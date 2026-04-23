import * as vscode from 'vscode';
import { getConfig } from './config';
import { notify } from './notifications';

interface StartInfo { cmd: string; start: number; terminalName: string; }

export function registerLongRunNotifier(ctx: vscode.ExtensionContext): void {
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

      void notify({
        title: ok ? `✓ ${dur}` : `✗ exit ${e.exitCode}`,
        subtitle: s.terminalName,
        body: cmdShort,
        level: ok ? 'info' : 'warning',
      });
    }),
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
