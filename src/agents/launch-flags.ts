// Launch-flag preservation, shared by every provider.
//
// When a tracked agent process is alive we read its argv from `ps` and keep the
// "character" flags it was launched with (yolo, --model, sandbox, …). On resume
// — Restart, Start-after-Stop when tmux died, post-reboot restore, reattach — we
// append those flags to the provider's resume command so the conversation comes
// back the way it was started.
//
// This is an ALLOWLIST: only flags a provider names in its FlagSpec are kept.
// Everything else — `--resume`/`--continue`/`--print`, positional prompts, the
// `codex resume`/`exec` subcommands — is dropped automatically by not matching.
//
// Two things are deliberately NOT carried as flags:
//   • MCP config. For users with the `claude-pick` resume wrapper the live
//     `--mcp-config` points at an ephemeral temp file (mktemp + `trap rm EXIT`)
//     that is already deleted by the time we relaunch; re-applying it would be a
//     dead path AND collide with claude-pick's fresh injection. The path-existence
//     filter below drops it, and `claude-pick` restores MCP from its own sticky
//     memory. For users WITHOUT claude-pick, a real permanent `--mcp-config
//     ~/x.json` still exists on disk, so the same filter KEEPS it — correct for
//     everyone, with no claude-pick knowledge baked into the extension.
//   • `--cd`/working-dir flags — the resume command already handles cwd.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posixQuote } from '../shell-escape';

/** Declarative description of which launch flags a provider re-applies on resume. */
export interface FlagSpec {
  /** Valueless flags to keep verbatim, e.g. `--dangerously-skip-permissions`. */
  bool: readonly string[];
  /** Value-taking flags to keep. `path:true` marks the value as a filesystem
   *  path that must still exist at relaunch (the flag is dropped otherwise). */
  value: Readonly<Record<string, { path?: boolean }>>;
  /** Short alias → canonical name, e.g. `-m` → `--model`. */
  alias?: Readonly<Record<string, string>>;
  /** A flag kept only when its partner survives — e.g. `--strict-mcp-config`
   *  needs `--mcp-config` (a lone `--strict-mcp-config` would start with zero
   *  MCP servers, which is worse than letting claude-pick repopulate them). */
  companion?: Readonly<Record<string, string>>;
}

/**
 * Extract the allowlisted launch flags from a live process argv. `argv[0]` is the
 * executable; flags follow. Handles `--flag value`, `--flag=value`, short aliases
 * and repeatable flags. Returns a flat token array (flag, value, flag, …).
 */
export function captureFlags(argv: readonly string[], spec: FlagSpec): string[] {
  const out: string[] = [];
  const canon = (t: string): string => spec.alias?.[t] ?? t;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || !tok.startsWith('-')) continue; // positional / subcommand → drop
    let name = tok;
    let inlineVal: string | undefined;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 0) {
      name = tok.slice(0, eq);
      inlineVal = tok.slice(eq + 1);
    }
    name = canon(name);
    if (spec.bool.includes(name)) {
      out.push(name);
      continue;
    }
    const vspec = spec.value[name];
    if (vspec) {
      let val: string | undefined;
      if (inlineVal !== undefined) val = inlineVal;
      else if (i + 1 < argv.length) val = argv[++i];
      if (val === undefined) continue;
      // `ps` collapses the argv into one space-joined string (see readAgentArgv),
      // so a path value that originally contained spaces —
      // `--add-dir "/path with spaces"` — arrives split across several tokens.
      // Best-effort recovery for path-valued flags: greedily absorb following
      // non-flag tokens until the joined value exists on disk. The common
      // no-spaces case is untouched (the first token is used as-is); a value we
      // can't reconstruct stays truncated and is dropped by materializeFlags'
      // existence check rather than resumed corrupted.
      if (vspec.path && looksLikePath(val) && !fs.existsSync(expandHome(val))) {
        let joined = val;
        let j = i;
        while (j + 1 < argv.length && !argv[j + 1].startsWith('-')) {
          joined += ' ' + argv[j + 1];
          j++;
          if (fs.existsSync(expandHome(joined))) { val = joined; i = j; break; }
        }
      }
      out.push(name, val);
      continue;
    }
  }
  return out;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Only existence-check values that actually look like filesystem paths, so an
 *  inline JSON `--mcp-config '{...}'` or a non-path value is never dropped. */
function looksLikePath(v: string): boolean {
  return /^[~./]/.test(v) || v.startsWith(path.sep);
}

/**
 * Drop captured flags that are no longer valid at relaunch time: path-valued
 * flags whose file/dir has vanished (the claude-pick temp case), then any
 * companion flag orphaned by that removal.
 */
export function materializeFlags(flags: readonly string[], spec: FlagSpec): string[] {
  const kept: string[] = [];
  const present = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i];
    if (spec.value[name]) {
      const val = flags[i + 1] ?? '';
      i++; // consume value
      if (spec.value[name].path && looksLikePath(val) && !fs.existsSync(expandHome(val))) {
        continue; // dead path → drop the whole flag+value
      }
      kept.push(name, val);
      present.add(name);
    } else {
      kept.push(name);
      present.add(name);
    }
  }
  if (!spec.companion) return kept;
  const final: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const name = kept[i];
    const partner = spec.companion[name];
    if (partner && !present.has(partner)) {
      if (spec.value[name]) i++; // skip its value too, if any
      continue; // orphan companion → drop
    }
    if (spec.value[name]) {
      final.push(name, kept[i + 1]);
      i++;
    } else {
      final.push(name);
    }
  }
  return final;
}

/** Single-quote every token before it is appended to a resume command string.
 *  Whitespace-only quoting left values like `/x/$(id)` bare, so a captured flag
 *  value carrying shell metacharacters could be expanded when the command runs.
 *  POSIX single-quoting neutralizes all of them; a plain flag name such as
 *  `--model` becomes `'--model'`, which the shell strips back to `--model`. */
function shQuote(t: string): string {
  return posixQuote(t);
}

/** Append the surviving launch flags to a resume command string. */
export function withFlags(cmd: string, extraFlags: readonly string[] | undefined, spec: FlagSpec): string {
  const live = materializeFlags(extraFlags ?? [], spec);
  return live.length ? `${cmd} ${live.map(shQuote).join(' ')}` : cmd;
}

interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

export interface ProcTree {
  byPid: Map<number, Proc>;
  byParent: Map<number, Proc[]>;
}

/** One `ps` snapshot of every process, indexed by pid and by parent pid. Build
 *  it once per poll and reuse it across many subtree queries. */
export function processTree(): ProcTree {
  const byPid = new Map<number, Proc>();
  const byParent = new Map<number, Proc[]>();
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const p: Proc = { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), cmd: m[3] };
      byPid.set(p.pid, p);
      const arr = byParent.get(p.ppid) ?? [];
      arr.push(p);
      byParent.set(p.ppid, arr);
    }
  } catch {
    /* ps unavailable → empty tree */
  }
  return { byPid, byParent };
}

/** All pids in the subtree under `roots` (roots included). */
export function collectDescendantPids(roots: readonly number[], tree: ProcTree): Set<number> {
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (out.has(pid)) continue;
    out.add(pid);
    for (const child of tree.byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return out;
}

/**
 * Walk the process subtree under any of `rootPids` (a tmux pane's shell pids) and
 * return the argv of the first descendant whose executable basename matches one
 * of `names` (the agent CLI). Returns undefined when no such process is live —
 * e.g. the agent hasn't launched yet, or claude-pick's gum picker is still open.
 */
export function readAgentArgv(
  rootPids: readonly number[],
  names: readonly string[],
  tree?: ProcTree,
): string[] | undefined {
  if (!rootPids.length || !names.length) return undefined;
  const t = tree ?? processTree();
  if (!t.byPid.size) return undefined;
  const want = new Set(names);
  const queue = [...rootPids];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = t.byPid.get(pid);
    if (self) {
      // `ps -o command=` returns the command line as a single space-joined
      // string with the original argv boundaries lost, so a flag value that
      // contained spaces splits into several tokens here and can't be perfectly
      // reconstructed. captureFlags recovers path-valued flags on a best-effort
      // basis (re-joining until the path exists); other space-bearing values
      // are dropped rather than restored corrupted.
      const argv = self.cmd.split(/\s+/);
      if (want.has(path.basename(argv[0] || ''))) return argv;
    }
    for (const child of t.byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return undefined;
}
