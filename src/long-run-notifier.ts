import * as vscode from 'vscode';
import { getConfig } from './config';
import { notify, sessionFocusUrl, sessionGroupId } from './notifications';
import { sessionNameForTerminal } from './profile-provider';
import { parseSessionName } from './workspace-id';
import type { SessionIndex } from './session-manager';
import { formatDuration } from './util';

interface StartInfo { cmd: string; start: number; terminalName: string; }

/** The tmux session a terminal is attached to, if it is one of ours. Plain
 *  terminals return undefined and are never muted or grouped. */
function sessionOfTerminal(t: vscode.Terminal): string | undefined {
  const name = sessionNameForTerminal(t);
  if (!name) return undefined;
  return parseSessionName(name, getConfig().sessionPrefix) ? name : undefined;
}

export function registerLongRunNotifier(ctx: vscode.ExtensionContext, index: SessionIndex): void {
  const starts = new WeakMap<object, StartInfo>();

  const onStart = (vscode.window as { onDidStartTerminalShellExecution?: typeof vscode.window.onDidStartTerminalShellExecution }).onDidStartTerminalShellExecution;
  const onEnd = (vscode.window as { onDidEndTerminalShellExecution?: typeof vscode.window.onDidEndTerminalShellExecution }).onDidEndTerminalShellExecution;
  if (!onStart || !onEnd) {
    console.warn('[terminal-sessions] shell integration events not available in this VS Code build');
    return;
  }

  ctx.subscriptions.push(
    onStart(e => {
      if (!getConfig().enableLongRunNotifications) return;
      const cmd = e.execution.commandLine?.value || '(command)';
      starts.set(e.execution as unknown as object, {
        cmd,
        start: Date.now(),
        terminalName: e.terminal.name,
      });
    }),
    onEnd(e => {
      if (!getConfig().enableLongRunNotifications) return;
      const key = e.execution as unknown as object;
      const s = starts.get(key);
      if (!s) return;
      starts.delete(key);
      const durSec = (Date.now() - s.start) / 1000;
      const threshold = getConfig().longRunThresholdSeconds;
      if (durSec < threshold) return;
      const ok = e.exitCode === 0 || e.exitCode === undefined;
      const dur = formatDuration(durSec);
      const cmdShort = s.cmd.length > 60 ? s.cmd.slice(0, 57) + '...' : s.cmd;

      // "Mute Notifications" on a session has to mean the session, not just the
      // agent running in it — a muted tab was still announcing its slow builds.
      const tmuxSession = sessionOfTerminal(e.terminal);
      if (tmuxSession) {
        const parsed = parseSessionName(tmuxSession, getConfig().sessionPrefix);
        if (parsed && index.isSessionMuted(parsed.hash, tmuxSession)) return;
      }

      void notify({
        // Same shape as the agent notifications: which terminal in the title,
        // state in the subtitle, detail in the body.
        kind: 'shell',
        title: s.terminalName,
        subtitle: ok ? '✓ Command finished' : '✗ Command failed',
        body: [dur, ok ? '' : `exit ${e.exitCode}`, cmdShort].filter(Boolean).join(' · '),
        // The command line is the long part; in the toast it stays out.
        short: `${ok ? '✓' : '✗'} ${s.terminalName} · ${ok ? dur : `exit ${e.exitCode}`}`,
        level: ok ? 'info' : 'warning',
        // Same one-banner-per-session rule as the agent notifications, and the
        // same click target. A plain terminal gets neither.
        groupId: tmuxSession ? sessionGroupId(tmuxSession) : undefined,
        openUrl: tmuxSession ? sessionFocusUrl(tmuxSession) : undefined,
        // The terminal is right here, so the toast can offer the jump without
        // going through the deep link.
        toastAction: { label: 'Show terminal', callback: () => e.terminal.show() },
      });
    }),
  );
}

