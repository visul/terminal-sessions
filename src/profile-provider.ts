import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { PROFILE_ID, getConfig } from './config';
import * as tmux from './tmux';
import { currentWorkspace, sessionName, parseSessionName } from './workspace-id';
import { SessionIndex } from './session-manager';
import { SessionLabel } from './types';

function iconFromMeta(meta: SessionLabel | undefined): vscode.ThemeIcon {
  const id = meta?.icon || 'terminal-bash';
  const color = meta?.color ? new vscode.ThemeColor(meta.color) : undefined;
  return new vscode.ThemeIcon(id, color);
}

function colorFromMeta(meta: SessionLabel | undefined): vscode.ThemeColor | undefined {
  return meta?.color ? new vscode.ThemeColor(meta.color) : undefined;
}

function displayName(label: string | undefined, folder: string, tabId: number): string {
  const tabPart = `#${tabId}`;
  const trimmed = (label || '').trim();
  if (trimmed.length > 0) return `${trimmed} ${tabPart}`;
  return `${folder}${tabPart}`;
}

export function registerPersistentProfile(index: SessionIndex): vscode.Disposable {
  return vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
    async provideTerminalProfile() {
      const cfg = getConfig();
      const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
      if (!tmuxPath) {
        const choice = await vscode.window.showErrorMessage(
          'tmux is not installed. Terminal Sessions needs tmux to provide persistent terminals.',
          'Install via Homebrew', 'Install Instructions', 'Dismiss',
        );
        if (choice === 'Install via Homebrew') {
          const term = vscode.window.createTerminal('install tmux');
          term.show();
          term.sendText('brew install tmux');
        } else if (choice === 'Install Instructions') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/tmux/tmux/wiki/Installing'));
        }
        throw new Error('tmux missing');
      }

      const ws = currentWorkspace();
      if (!ws) {
        const name = `${cfg.sessionPrefix}-adhoc-${Date.now().toString(36).slice(-6)}`;
        return new vscode.TerminalProfile({
          name: `adhoc-${name.slice(-6)}`,
          shellPath: tmuxPath,
          shellArgs: tmux.buildAttachOrCreateArgs(name, process.env.HOME || '/'),
        });
      }

      index.recordWorkspace(ws.hash, ws.path, ws.label);
      const tabId = await nextSafeTabId(index, tmuxPath, cfg.sessionPrefix, ws.hash);
      const name = sessionName(cfg.sessionPrefix, ws.hash, tabId);
      index.recordSession(ws.hash, name);
      const meta = index.getSessionMeta(ws.hash, name);
      const termName = displayName(meta?.label, ws.label, tabId);

      return new vscode.TerminalProfile({
        name: termName,
        shellPath: tmuxPath,
        shellArgs: tmux.buildAttachOrCreateArgs(name, ws.path),
        iconPath: iconFromMeta(meta),
        color: colorFromMeta(meta),
      });
    },
  });
}

/**
 * Next tab id that won't collide with a LIVE tmux session, even when the index is
 * stale or empty (e.g. after a corrupt-index reset while tmux sessions are still
 * alive). getNextTabId alone reads only the index; a reused id fed to
 * `new-session -A -s` would silently attach a second client to the existing
 * session (both panes mirror each other) instead of creating a fresh one.
 */
export async function nextSafeTabId(
  index: SessionIndex,
  tmuxPath: string,
  prefix: string,
  hash: string,
): Promise<number> {
  let tabId = index.getNextTabId(hash, prefix);
  try {
    const rows = await tmux.listSessions(tmuxPath, prefix);
    let maxLive = 0;
    for (const r of rows) {
      const p = parseSessionName(r.name, prefix);
      if (p && p.hash === hash && p.tabId > maxLive) maxLive = p.tabId;
    }
    if (maxLive + 1 > tabId) tabId = maxLive + 1;
  } catch { /* tmux not listing — fall back to the index id */ }
  return tabId;
}

export function sessionNameForTerminal(t: vscode.Terminal): string | undefined {
  const opts = t.creationOptions;
  if (!opts || typeof opts !== 'object' || 'pty' in opts) return undefined;
  const shellArgs = (opts as vscode.TerminalOptions).shellArgs;
  if (!shellArgs) return undefined;
  const args = Array.isArray(shellArgs) ? shellArgs : [shellArgs];
  const sIdx = args.indexOf('-s');
  const tIdx = args.indexOf('-t');
  const nameIdx = sIdx >= 0 ? sIdx + 1 : (tIdx >= 0 ? tIdx + 1 : -1);
  if (nameIdx < 0 || nameIdx >= args.length) return undefined;
  return args[nameIdx];
}

/**
 * Locate the VS Code terminal currently bound to a tmux session.
 * Two-stage match:
 *  1. shellArgs contain the tmux name after `-s` / `-t` (primary, exact)
 *  2. terminal name ends with `#<tabId>` (fallback for terminals VS Code
 *     restored across window reloads where creationOptions are trimmed)
 * Within each stage, prefer a live terminal over an exited one so we
 * never reattach to a "process exited" ghost when a working tab exists.
 */
export function findTerminalForSession(name: string): vscode.Terminal | undefined {
  const byArgs: vscode.Terminal[] = [];
  for (const t of vscode.window.terminals) {
    if (sessionNameForTerminal(t) === name) byArgs.push(t);
  }
  const live = byArgs.find(t => !t.exitStatus);
  if (live) return live;
  if (byArgs.length > 0) return byArgs[0];

  const m = /-(\d+)$/.exec(name);
  if (!m) return undefined;
  const suffix = '#' + m[1];
  const byName: vscode.Terminal[] = [];
  for (const t of vscode.window.terminals) {
    if (t.name && t.name.endsWith(suffix)) byName.push(t);
  }
  return byName.find(t => !t.exitStatus) ?? byName[0];
}

/**
 * Resolve the tmux session name for a terminal, robust to window reloads.
 * VS Code trims `creationOptions` on restored terminals, so the primary
 * shellArgs-based lookup (`sessionNameForTerminal`) returns undefined for the
 * ⚠ "disconnected" tabs left after a reload. Fall back to the tab label, which
 * still ends with `#<tabId>`, and find the matching session in the index.
 */
export function resolveSessionNameForTerminal(
  t: vscode.Terminal,
  index: SessionIndex,
  prefix: string,
): string | undefined {
  const direct = sessionNameForTerminal(t);
  if (direct) return direct;

  const m = /#(\d+)\s*$/.exec(t.name || '');
  if (!m) return undefined;
  const tabId = parseInt(m[1], 10);
  const labelPart = (t.name || '').replace(/#\d+\s*$/, '').trim();

  const matches: string[] = [];
  for (const ws of Object.values(index.getAllWorkspaces())) {
    for (const sName of Object.keys(ws.sessions || {})) {
      const parsed = parseSessionName(sName, prefix);
      if (parsed && parsed.tabId === tabId) matches.push(sName);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;
  // tabId is unique per workspace but not globally. Disambiguate by the label
  // part of the tab name, which is either the session's custom label or (when
  // unlabeled) the workspace label — exactly what displayName() renders.
  if (labelPart) {
    for (const sName of matches) {
      const parsed = parseSessionName(sName, prefix)!;
      const meta = index.getSessionMeta(parsed.hash, sName);
      const wsLabel = index.getWorkspace(parsed.hash)?.label;
      if (meta?.label === labelPart || (!meta?.label && wsLabel === labelPart)) return sName;
    }
  }
  // Prefer the current window's own workspace before giving up.
  const cur = currentWorkspace();
  if (cur) {
    const own = matches.find(sName => parseSessionName(sName, prefix)?.hash === cur.hash);
    if (own) return own;
  }
  // Still ambiguous → do NOT guess a cross-workspace session. Returning an
  // arbitrary match would reattach this terminal to a DIFFERENT project's tmux
  // (and stamp MRU / reveal the wrong folder). Let the PID fallback resolve it.
  return undefined;
}

/**
 * Last-resort identity: read the terminal's live process. The tmux name we need
 * is right there in `tmux … attach-session -t <name>` even when (a) a reload
 * trimmed the shellArgs and (b) the user renamed the tab so it no longer carries
 * the `#<tabId>` we'd otherwise match on. Rename-proof and reload-proof.
 */
async function tmuxNameFromTerminalProcess(t: vscode.Terminal): Promise<string | undefined> {
  let pid: number | undefined;
  try { pid = await t.processId; } catch { pid = undefined; }
  if (!pid) return undefined;
  try {
    const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // Match BOTH resume forms the extension emits: attach-session -t <name> and
    // new-session -A -s <name> (the profile "+ New Persistent Terminal" path).
    // Matching only -t left every profile-created, renamed, reloaded terminal
    // unresolvable — the PID fallback would find nothing and the session looked
    // dead to Reveal / Open Folder.
    const m = /(?:new-session|attach-session)\b.*?\s-(?:t|s)\s+(\S+)/.exec(out)
      || /\s-[ts]\s+(\S+)/.exec(out);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a terminal's tmux session name, robust to BOTH window reloads (trimmed
 * shellArgs) AND user-renamed tabs (no `#<tabId>` in the label). Tries the cheap
 * synchronous paths first (shellArgs, then tab label), then falls back to the
 * live process args via PID.
 */
export async function resolveTmuxNameForTerminalLive(
  t: vscode.Terminal,
  index: SessionIndex,
  prefix: string,
): Promise<string | undefined> {
  const byName = resolveSessionNameForTerminal(t, index, prefix);
  if (byName) return byName;
  return tmuxNameFromTerminalProcess(t);
}

export async function openTerminalForSession(
  name: string,
  cwd?: string,
  index?: SessionIndex,
  forceNew = false,
): Promise<vscode.Terminal | undefined> {
  if (!forceNew) {
    const existing = findTerminalForSession(name);
    if (existing && !existing.exitStatus) {
      existing.show();
      // Re-assert focus on the next tick: a sidebar TreeItem click (and the
      // refreshSidebar that follows) can leave keyboard focus on the tree, so
      // show() alone often isn't enough — you'd have to click the terminal to
      // type. Re-showing after the click settles puts the cursor in the terminal.
      setTimeout(() => { try { existing.show(); } catch { /* disposed */ } }, 0);
      // If this pane was left in copy-mode (scrolled up to read), exit it so the
      // terminal is ready to type the moment you switch to it — no extra click.
      void tmux.detectTmuxPath(getConfig().tmuxPath).then(tp => {
        if (tp) void tmux.exitCopyMode(tp, name);
      });
      return existing;
    }
    // A "process exited" ghost (yellow ⚠ in the picker) — dispose it so
    // the user doesn't end up with both the dead pane and a live one.
    if (existing) {
      try { existing.dispose(); } catch { /* already gone */ }
    }
  }

  const cfg = getConfig();
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!tmuxPath) return undefined;

  let termName = name;
  let meta: SessionLabel | undefined;
  // Resolve the cwd VS Code should label the terminal with. Tmux remembers
  // its own working directory regardless of what we pass — but VS Code's
  // terminal panel groups tabs by this `cwd`, so passing the session's
  // original folder (the subfolder it was created in via right-click → New
  // Persistent in Folder) keeps reattached terminals visually grouped with
  // their originals instead of drifting to the workspace root and looking
  // like a duplicate.
  let resolvedCwd: string | undefined = cwd;
  if (index) {
    const parsed = parseSessionName(name, cfg.sessionPrefix);
    if (parsed) {
      meta = index.getSessionMeta(parsed.hash, name);
      const ws = index.getWorkspace(parsed.hash);
      termName = displayName(meta?.label, ws?.label || parsed.hash, parsed.tabId);
      if (!resolvedCwd) resolvedCwd = meta?.folderPath || ws?.path;
    }
  }

  const terminal = vscode.window.createTerminal({
    name: termName,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachArgs(name),
    cwd: resolvedCwd,
    iconPath: iconFromMeta(meta),
    color: colorFromMeta(meta),
  });
  terminal.show();
  void tmux.exitCopyMode(tmuxPath, name);
  return terminal;
}

export function metaIconAndColor(meta: SessionLabel | undefined): {
  icon: vscode.ThemeIcon;
  color: vscode.ThemeColor | undefined;
} {
  return { icon: iconFromMeta(meta), color: colorFromMeta(meta) };
}
