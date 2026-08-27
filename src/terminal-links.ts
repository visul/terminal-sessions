import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findCandidates, findWebCandidates, PathCandidate } from './links-matcher';

/**
 * Terminal link provider: two detectors the built-in one lacks.
 *  - File paths WITH SPACES, validated on disk (the built-in detector stops
 *    at the first space). Ported from the standalone Terminal Path Links
 *    extension, now a native feature.
 *  - Scheme-less web URLs (github.com/owner/repo, learn.microsoft.com/x) —
 *    the built-in detector only links https:// and www. forms.
 * Both read the RENDERED terminal text, so they work identically inside and
 * outside tmux (no OSC 8 passthrough involved).
 */

// stat cache so repeated renders of the same lines stay cheap.
// Values hold a PROMISE so concurrent lookups of the same path share one
// fs.stat (in-flight de-dup); eviction drops oldest entries, never clears all.
const CACHE_TTL_MS = 30000;
// Misses are cached much shorter: a file created right after a failed lookup
// (build-then-click workflow) must become clickable quickly.
const CACHE_NEG_TTL_MS = 3000;
const CACHE_MAX = 500;
// Hard cap of fs.stat calls per provideTerminalLinks invocation — worst-case
// lines (prose with slashes, many base dirs) cost at most this many stats.
const MAX_STATS_PER_LINE = 24;

interface CacheEntry { p: Promise<'file' | 'dir' | null>; t: number; neg: boolean; }
const statCache = new Map<string, CacheEntry>();

interface Resolved { abs: string; kind: 'file' | 'dir'; }

interface LinkData {
  resolved?: Resolved;
  line?: number | null;
  col?: number | null;
  tail?: string;
  url?: string;
}

type TsLink = vscode.TerminalLink & { data: LinkData };

function statKind(absPath: string): Promise<'file' | 'dir' | null> {
  const hit = statCache.get(absPath);
  const now = Date.now();
  if (hit && now - hit.t < (hit.neg ? CACHE_NEG_TTL_MS : CACHE_TTL_MS)) return hit.p;
  const entry: CacheEntry = { p: Promise.resolve(null), t: now, neg: false };
  entry.p = fs.promises
    .stat(absPath)
    .then((st): 'file' | 'dir' => (st.isDirectory() ? 'dir' : 'file'))
    .catch(() => {
      entry.neg = true;
      return null;
    });
  statCache.delete(absPath); // refresh moves the key to the back (LRU-ish, not FIFO)
  while (statCache.size >= CACHE_MAX) {
    statCache.delete(statCache.keys().next().value as string); // oldest-in first
  }
  statCache.set(absPath, entry);
  return entry.p;
}

function baseDirs(terminal: vscode.Terminal): string[] {
  const dirs: string[] = [];
  try {
    const cwd = terminal?.shellIntegration?.cwd;
    if (cwd && cwd.scheme === 'file') dirs.push(cwd.fsPath);
  } catch {
    // shellIntegration may not exist on older APIs
  }
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (f.uri.scheme === 'file') dirs.push(f.uri.fsPath);
  }
  return [...new Set(dirs)];
}

// Resolve a candidate pathText to { abs, kind } or null. `budget.left`
// bounds the number of stat calls across the whole line.
async function resolveCandidate(
  pathText: string, dirs: string[], budget: { left: number },
): Promise<Resolved | null> {
  const tries: string[] = [];
  if (pathText.startsWith('/')) {
    tries.push(pathText);
  } else if (pathText.startsWith('~/')) {
    tries.push(path.join(os.homedir(), pathText.slice(2)));
  } else {
    for (const d of dirs) tries.push(path.join(d, pathText));
  }
  const allowed = tries.slice(0, Math.max(0, budget.left));
  budget.left -= allowed.length;
  if (allowed.length === 0) return null;
  // stat all base dirs in parallel, keep the first hit in priority order
  const kinds = await Promise.all(allowed.map((abs) => statKind(abs)));
  for (let i = 0; i < allowed.length; i++) {
    const kind = kinds[i];
    if (kind) return { abs: allowed[i], kind };
  }
  return null;
}

async function openResolved(resolved: Resolved, line?: number | null, col?: number | null): Promise<void> {
  const uri = vscode.Uri.file(resolved.abs);
  if (resolved.kind === 'dir') {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const opts: vscode.TextDocumentShowOptions = {};
  if (line) {
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (col || 1) - 1));
    opts.selection = new vscode.Range(pos, pos);
  }
  await vscode.window.showTextDocument(uri, opts);
}

// Wrapped-tail rescue: the fragment on a continuation row is the TAIL of a
// real path. If it uniquely suffix-matches a workspace file, open that.
const GLOB_SPECIALS = /[[\]{}()!?*]/;

async function rescueByTail(tail: string, line?: number | null, col?: number | null): Promise<boolean> {
  const clean = tail.replace(/^\/+/, '');
  if (GLOB_SPECIALS.test(clean) || clean.length < 4) return false;
  const matches = await vscode.workspace.findFiles('**/' + clean, '**/node_modules/**', 5);
  if (matches.length === 0) return false;
  if (matches.length === 1) {
    await openResolved({ abs: matches[0].fsPath, kind: 'file' }, line, col);
    return true;
  }
  const pick = await vscode.window.showQuickPick(
    matches.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
    { placeHolder: 'Multiple files end with this fragment' },
  );
  if (pick) await openResolved({ abs: pick.uri.fsPath, kind: 'file' }, line, col);
  return true;
}

async function providePathLinks(ctx: vscode.TerminalLinkContext): Promise<TsLink[]> {
  const groups = findCandidates(ctx.line);
  if (groups.length === 0) return [];
  const dirs = baseDirs(ctx.terminal);
  const budget = { left: MAX_STATS_PER_LINE };
  const links: TsLink[] = [];
  for (const group of groups) {
    // Tail rescue only ever applies to a bare fragment that IS the
    // whole line and ends like a filename; compute eligibility first.
    const head: PathCandidate = group[0];
    // A fragment like "src/foo.ts:15:5" fails the filename test in its
    // literal form; its suffix-stripped sibling (same span, line != null)
    // is the one rescue must match and navigate with.
    const rescueCand: PathCandidate = group.find(
      (c) => c.start === head.start && c.length === head.length && c.line !== null,
    ) || head;
    const trimmed = ctx.line.trim();
    const ownLine = trimmed.length === head.length
      && ctx.line.indexOf(trimmed) === head.start;
    const lastSeg = rescueCand.pathText.slice(rescueCand.pathText.lastIndexOf('/') + 1);
    const rescueEligible = ownLine && /\.[A-Za-z0-9]{1,8}$/.test(lastSeg);

    // If nothing here contains a space and tail rescue can't apply,
    // this group is entirely the built-in detector's business.
    const anySpace = group.some((c) => c.pathText.includes(' '));
    if (!anySpace && !rescueEligible) continue;

    let resolvedAny = false;
    for (const cand of group) {
      const resolved = await resolveCandidate(cand.pathText, dirs, budget);
      if (resolved) {
        resolvedAny = true;
        // Only paths WITH spaces get a link from us; a resolving
        // space-less path is the built-in detector's link — but its
        // resolution still (correctly) suppresses tail rescue.
        if (cand.pathText.includes(' ')) {
          links.push({
            startIndex: cand.start,
            length: cand.length,
            tooltip: 'Open ' + resolved.abs,
            data: { resolved, line: cand.line, col: cand.col },
          });
        }
        break; // longest match wins within a run
      }
    }
    // Own-line bare fragment that resolved nowhere: offer tail rescue
    // (covers paths broken onto a continuation row by hard wrapping).
    // Skipped when the stat budget ran dry — no reliable verdict then.
    if (!resolvedAny && rescueEligible && budget.left > 0) {
      links.push({
        startIndex: head.start,
        length: head.length,
        tooltip: 'Find file ending in ' + rescueCand.pathText,
        data: { tail: rescueCand.pathText, line: rescueCand.line, col: rescueCand.col },
      });
    }
  }
  return links;
}

function provideWebLinks(ctx: vscode.TerminalLinkContext): TsLink[] {
  return findWebCandidates(ctx.line).map((c) => ({
    startIndex: c.start,
    length: c.length,
    tooltip: 'Open ' + c.url,
    data: { url: c.url },
  }));
}

export function registerTerminalLinks(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      async provideTerminalLinks(linkCtx: vscode.TerminalLinkContext): Promise<TsLink[]> {
        try {
          // The standalone Terminal Path Links extension already provides the
          // path detector; skip ours so the same text does not get two
          // overlapping links. Checked live so a mid-session install of that
          // extension takes effect without a window reload.
          const standalone = !!vscode.extensions.getExtension('visul.terminal-path-links');
          const cfg = vscode.workspace.getConfiguration('terminalSessions');
          const links: TsLink[] = [];
          if (cfg.get<boolean>('pathLinks', true) && !standalone) {
            links.push(...(await providePathLinks(linkCtx)));
          }
          if (cfg.get<boolean>('webLinks', true)) {
            const taken = links.map((l) => [l.startIndex, l.startIndex + l.length] as const);
            for (const w of provideWebLinks(linkCtx)) {
              // Path links win on overlap: a real file beats a URL guess.
              const overlaps = taken.some(([a, b]) => w.startIndex < b && w.startIndex + w.length > a);
              if (!overlaps) links.push(w);
            }
          }
          return links;
        } catch {
          return []; // never break the terminal over a link
        }
      },
      async handleTerminalLink(link: TsLink): Promise<void> {
        try {
          const d = link.data || {};
          if (d.url) return void (await vscode.env.openExternal(vscode.Uri.parse(d.url)));
          if (d.resolved) return void (await openResolved(d.resolved, d.line, d.col));
          if (d.tail) {
            const ok = await rescueByTail(d.tail, d.line, d.col);
            if (!ok) vscode.window.showInformationMessage('No file found ending in: ' + d.tail);
          }
        } catch (e) {
          vscode.window.showWarningMessage('Terminal Sessions links: ' + (e instanceof Error ? e.message : String(e)));
        }
      },
    }),
  );
}
