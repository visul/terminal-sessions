import * as vscode from 'vscode';
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
      const tabId = index.getNextTabId(ws.hash, cfg.sessionPrefix);
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

export function findTerminalForSession(name: string): vscode.Terminal | undefined {
  for (const t of vscode.window.terminals) {
    if (sessionNameForTerminal(t) === name) return t;
  }
  return undefined;
}

export async function openTerminalForSession(
  name: string,
  cwd?: string,
  index?: SessionIndex,
  forceNew = false,
): Promise<vscode.Terminal | undefined> {
  if (!forceNew) {
    const existing = findTerminalForSession(name);
    if (existing) {
      existing.show();
      return existing;
    }
  }

  const cfg = getConfig();
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!tmuxPath) return undefined;

  let termName = name;
  let meta: SessionLabel | undefined;
  let workspaceCwd: string | undefined = cwd;
  if (index) {
    const parsed = parseSessionName(name, cfg.sessionPrefix);
    if (parsed) {
      meta = index.getSessionMeta(parsed.hash, name);
      const ws = index.getWorkspace(parsed.hash);
      termName = displayName(meta?.label, ws?.label || parsed.hash, parsed.tabId);
      if (!workspaceCwd && ws?.path) workspaceCwd = ws.path;
    }
  }

  const terminal = vscode.window.createTerminal({
    name: termName,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachArgs(name),
    cwd,
    iconPath: iconFromMeta(meta),
    color: colorFromMeta(meta),
  });
  terminal.show();
  return terminal;
}

export function metaIconAndColor(meta: SessionLabel | undefined): {
  icon: vscode.ThemeIcon;
  color: vscode.ThemeColor | undefined;
} {
  return { icon: iconFromMeta(meta), color: colorFromMeta(meta) };
}
