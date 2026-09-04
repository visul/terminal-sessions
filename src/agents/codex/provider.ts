import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from '../types';
import { commandOnPath } from '../detect';
import { FlagSpec, captureFlags, withFlags } from '../launch-flags';
import {
  installJsonSettingsHook,
  uninstallJsonSettingsHook,
  isJsonSettingsHookInstalled,
} from '../hooks';
import {
  reduceCodexTranscriptLine,
  readCodexTranscriptSummary,
} from './transcript';

// Accept any RFC-4122-shaped UUID, including the UUIDv7 ids Codex uses for
// session ids (version nibble = 7, e.g. `019ea6e0-752a-7500-ae0b-...`). The
// generic regex already covers every version, so no special-casing needed.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Codex "character" launch flags. Codex's resume restores the recorded cwd, so
// `--cd`/`-C` is intentionally NOT carried. MCP lives in ~/.codex/config.toml,
// not on the command line, so there's nothing MCP-ish to capture here.
const CODEX_FLAGS: FlagSpec = {
  bool: ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo'],
  value: {
    '--model': {},
    '--sandbox': {},
    '--ask-for-approval': {},
    '--profile': {},
    '--config': {},
  },
  alias: { '-m': '--model', '-s': '--sandbox', '-a': '--ask-for-approval', '-c': '--config' },
};

const CODEX_HOME = path.join(os.homedir(), '.codex');
const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');

// We write hooks into ~/.codex/hooks.json. Codex accepts EITHER hooks.json
// (JSON) OR a [hooks] table in config.toml; we prefer the JSON file because it
// uses the *same* nested shape as Claude's settings.json
// (`{ hooks: { <Event>: [ { hooks: [ { type:'command', command } ] } ] } }`),
// so the shared installJsonSettingsHook helper works verbatim — and writing a
// separate JSON file means we never have to parse/rewrite the user's TOML
// config (which holds model + MCP server settings we must not disturb).
//
// Codex's only schema addition over Claude is an OPTIONAL `matcher` field on
// each entry; omitting it means "all" which is what we want for a forwarder.
const HOOKS_PATH = path.join(CODEX_HOME, 'hooks.json');

// Lifecycle events Codex emits. SessionStart is the load-bearing one (it ties
// session_id + cwd + transcript_path to the tmux pane via the forwarder's
// stdin JSON). PreToolUse/PostToolUse are installed for completeness but, per
// Codex 0.137.x, currently fire ONLY for the Bash tool — so the tracker must
// treat the TRANSCRIPT (task_started/task_complete + function_call events) as
// the authoritative tool/working state, NOT these hooks. Stop and
// PermissionRequest drive notifications.
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
] as const;

// Match our shared forwarder so install replaces a prior entry of ours and
// uninstall removes it.
function isOurCodexHook(command: string): boolean {
  return command.includes('agent-hook.sh');
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  badge: 'codex',
  badgeIcon: 'rocket',
  // Codex `resume <id>` restores the recorded cwd itself, so we must NOT
  // prepend a `cd` to the resume command (doing so would actually be harmless
  // but pointless; more importantly the tracker uses this flag to skip cwd
  // resolution entirely for Codex).
  resumeNeedsCwd: false,
  supportsFork: false,
  hookEvents: CODEX_HOOK_EVENTS,

  isInstalled(): boolean {
    return commandOnPath('codex');
  },

  settingsPath(): string {
    return HOOKS_PATH;
  },

  installHook(forwarderPath: string): Promise<boolean> {
    // Codex hooks.json uses the identical nested shape to Claude's
    // settings.json, so we reuse the shared installer. The forwarder is wired
    // as `"<path>" codex <Event>`; Codex pipes the event JSON
    // ({session_id, transcript_path, cwd, hook_event_name, tool_name, ...}) to
    // the command's stdin, exactly like Claude, so the same forwarder script
    // normalizes both with no Codex-specific branch.
    return installJsonSettingsHook({
      settingsPath: HOOKS_PATH,
      events: CODEX_HOOK_EVENTS,
      command: (event) => `"${forwarderPath}" codex ${event}`,
      isOurs: isOurCodexHook,
    });
  },

  uninstallHook(): Promise<boolean> {
    return uninstallJsonSettingsHook(HOOKS_PATH, isOurCodexHook);
  },

  isHookInstalled(): boolean {
    return isJsonSettingsHookInstalled(HOOKS_PATH, 'agent-hook.sh');
  },

  needsHookUpgrade(): boolean {
    if (!fs.existsSync(HOOKS_PATH)) return false;
    let raw: string;
    try { raw = fs.readFileSync(HOOKS_PATH, 'utf8'); }
    catch { return false; }
    if (!raw.includes('agent-hook.sh')) return false;
    for (const event of CODEX_HOOK_EVENTS) {
      if (!raw.includes(event)) return true;
    }
    return false;
  },

  isValidSessionId(id: string): boolean {
    return UUID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, _cwd: string, hintedPath?: string): string | undefined {
    // The hook-reported transcript_path is most reliable when present.
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    if (!UUID_RE.test(sessionId)) return undefined;
    // Codex shards sessions by date: ~/.codex/sessions/YYYY/MM/DD/. Scan the
    // last few days (newest first) for rollout-*-<sessionId>.jsonl. A session
    // started just before midnight could land in "yesterday", so we look back
    // a few days to be safe.
    return scanRecentDirsFor(sessionId, 4);
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceCodexTranscriptLine(state, line);
  },

  // No afterTranscriptDelta — Codex has no separate subagent transcript dirs to
  // merge (subagent sessions are their own top-level rollout files).

  contextLimitFor(_model: string | undefined): number {
    // The transcript carries an explicit model_context_window per turn, so this
    // is only a pre-first-token fallback. 256k is a safe default for gpt-5.x
    // under Codex (observed windows: 258400).
    return 256_000;
  },

  processNames: ['codex'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, CODEX_FLAGS);
  },

  // `--yolo` is the live spelling (a hidden alias of the long form); `--full-auto`
  // was removed from the CLI and is listed only so a flag set captured from an
  // older Codex is still recognized and stripped. Neither `--sandbox` nor
  // `--ask-for-approval` is yolo on its own — neither alone removes both the
  // sandbox and the prompts.
  //
  // Only `--ask-for-approval` is a conflict, and that is verified against the
  // installed CLI rather than assumed: `codex --yolo -a never doctor` fails with
  // "the argument '--dangerously-bypass-approvals-and-sandbox' cannot be used
  // with '--ask-for-approval'", while `codex --yolo -s workspace-write doctor`
  // exits 0. Listing `--sandbox` here too would silently discard a user's
  // deliberately restrictive `--sandbox read-only` for no reason, and nothing
  // restores a dropped value on the way back to normal mode.
  yolo: {
    on: ['--yolo'],
    off: ['--yolo', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'],
    conflicts: ['--ask-for-approval'],
  },

  buildResumeCommand(
    sessionId: string,
    _terminalCwd: string,
    _transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    // Interactive resume restores the recorded cwd itself — no `cd` prefix.
    // (`codex exec resume` is headless-only and must not be used for the pane.)
    return withFlags(`codex resume ${sessionId}`, extraFlags, CODEX_FLAGS);
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const out: AgentSessionSummary[] = [];
    const seen = new Set<string>();
    // Codex's generated thread titles (session_index.jsonl) — the name `codex resume`
    // shows and accepts; surfaced as autoTitle for on-disk sessions too.
    const threadNames = threadNamesById();

    // 1) Scan recent rollout dirs (newest days first) — authoritative file
    //    locations with full summaries (cwd filter + previews).
    for (const file of recentRolloutFiles(6)) {
      const sessionId = sessionIdFromRolloutName(file.name);
      if (!sessionId || seen.has(sessionId)) continue;
      const summary = readCodexTranscriptSummary(file.path);
      // When a cwd filter is requested, keep sessions launched at-or-under it.
      if (cwd && summary?.cwd && !isCwdMatch(summary.cwd, cwd)) continue;
      seen.add(sessionId);
      out.push({
        agent: 'codex',
        sessionId,
        transcriptPath: file.path,
        cwd: summary?.cwd,
        firstUserMessage: summary?.firstUserMessage,
        autoTitle: threadNames.get(sessionId),
        lineCount: summary?.lineCount,
        byteSize: summary?.byteSize ?? file.size,
        mtimeMs: summary?.mtimeMs ?? file.mtimeMs,
      });
    }

    // 2) Fold in any entries from session_index.jsonl we didn't already find on
    //    disk (e.g. archived/older sessions). thread_name → firstUserMessage.
    //    No cwd in the index, so these are only included when no cwd filter is
    //    set (otherwise we can't tell if they belong to this folder).
    if (!cwd) {
      // Resolve on-disk paths for index entries with a SINGLE readdir pass over
      // the 30 day-dirs, instead of re-scanning all 30 per entry (that was
      // hundreds of entries × 30 readdirs on every picker open).
      const rolloutById = rolloutPathsBySessionId(30);
      for (const entry of readSessionIndex()) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push({
          agent: 'codex',
          sessionId: entry.id,
          transcriptPath: rolloutById.get(entry.id),
          firstUserMessage: entry.thread_name,
          autoTitle: entry.thread_name,
          mtimeMs: entry.updated_at ? Date.parse(entry.updated_at) || undefined : undefined,
        });
      }
    }

    out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    return out;
  },

  readTranscriptSummary(transcriptPath: string) {
    const s = readCodexTranscriptSummary(transcriptPath);
    if (!s) return undefined;
    const id = sessionIdFromRolloutName(path.basename(transcriptPath));
    const autoTitle = id ? threadNamesById().get(id) : undefined;
    return autoTitle ? { ...s, autoTitle } : s;
  },
};

// session_index.jsonl is re-read at most every few seconds: the resume picker
// calls readTranscriptSummary once per candidate.
let threadNameCache: { at: number; map: Map<string, string> } | undefined;
function threadNamesById(): Map<string, string> {
  const now = Date.now();
  if (threadNameCache && now - threadNameCache.at < 5000) return threadNameCache.map;
  const map = new Map<string, string>();
  for (const e of readSessionIndex()) if (e.thread_name) map.set(e.id, e.thread_name);
  threadNameCache = { at: now, map };
  return map;
}

// ───────────────────────────── helpers ─────────────────────────────

interface RolloutFile { name: string; path: string; size: number; mtimeMs: number; }

/** Extract the session UUID from a `rollout-<ISO>-<uuid>.jsonl` filename. The
 *  UUID is the trailing 5 dash-separated groups before `.jsonl`. */
function sessionIdFromRolloutName(name: string): string | undefined {
  const m = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(name);
  return m ? m[1] : undefined;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}

/** Date-sharded dir for `daysBack` days ago, e.g.
 *  ~/.codex/sessions/2026/06/08. */
function sessionDayDir(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(SESSIONS_ROOT, yyyy, mm, dd);
}

/** Find a rollout file for `sessionId` by scanning the last `days` day-dirs
 *  (today first). Returns the absolute path or undefined. */
function scanRecentDirsFor(sessionId: string, days: number): string | undefined {
  for (let back = 0; back < days; back++) {
    const dir = sessionDayDir(back);
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      if (name.includes(sessionId)) return path.join(dir, name);
    }
  }
  return undefined;
}

/** Map session-id → rollout path across the last `days` day-dirs in one readdir
 *  pass, so a batch of id lookups doesn't re-scan every dir per id. Newest days
 *  are scanned first, so the first (newest) match for an id wins. */
function rolloutPathsBySessionId(days: number): Map<string, string> {
  const map = new Map<string, string>();
  for (let back = 0; back < days; back++) {
    const dir = sessionDayDir(back);
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = sessionIdFromRolloutName(name);
      if (id && !map.has(id)) map.set(id, path.join(dir, name));
    }
  }
  return map;
}

/** Collect rollout files from the last `days` day-dirs, newest day first,
 *  newest mtime within a day first. */
function recentRolloutFiles(days: number): RolloutFile[] {
  const files: RolloutFile[] = [];
  for (let back = 0; back < days; back++) {
    const dir = sessionDayDir(back);
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.jsonl') || !name.startsWith('rollout-')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        files.push({ name, path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* gone between readdir and stat */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

interface SessionIndexEntry { id: string; thread_name?: string; updated_at?: string; }

/** Parse ~/.codex/session_index.jsonl ({id, thread_name, updated_at} per
 *  line). Best-effort; returns [] if absent or unreadable. */
function readSessionIndex(): SessionIndexEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(SESSION_INDEX, 'utf8'); }
  catch { return []; }
  const out: SessionIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.id === 'string' && UUID_RE.test(o.id)) {
        out.push({
          id: o.id,
          thread_name: typeof o.thread_name === 'string' ? o.thread_name : undefined,
          updated_at: typeof o.updated_at === 'string' ? o.updated_at : undefined,
        });
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

/** True when `sessionCwd` is the requested `cwd` or a subdirectory of it (so
 *  resuming from a workspace root lists sessions started in its subfolders). */
function isCwdMatch(sessionCwd: string, cwd: string): boolean {
  if (sessionCwd === cwd) return true;
  const base = cwd.endsWith('/') ? cwd : cwd + '/';
  return sessionCwd.startsWith(base);
}
