import * as vscode from 'vscode';
import { COMMAND, getConfig } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(private index: SessionIndex) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = COMMAND.attachTo;
    this.item.text = '$(terminal-bash) ts: …';
    this.item.tooltip = 'Terminal Sessions — click to attach';
    this.item.show();
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  private async refresh(): Promise<void> {
    const cfg = getConfig();
    const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) {
      this.item.text = '$(alert) ts: tmux missing';
      this.item.tooltip = 'Terminal Sessions — tmux not installed. Click for install info.';
      return;
    }
    try {
      const sessions = await enrichSessions(tmuxPath, cfg.sessionPrefix, this.index);
      const active = sessions.filter(s => s.attached).length;
      const detached = sessions.length - active;
      this.item.text = `$(terminal-bash) ts: ${active}▶ ${detached}⇄`;
      const tooltip = new vscode.MarkdownString();
      tooltip.supportThemeIcons = true;
      tooltip.appendMarkdown(`**Terminal Sessions** — ${active} attached · ${detached} detached\n\n`);
      if (sessions.length > 0) {
        tooltip.appendMarkdown('---\n\n');
        for (const s of sessions.slice(0, 10)) {
          const icon = s.attached ? '$(pass-filled)' : '$(circle-outline)';
          const name = s.label || `#${s.tabId}`;
          tooltip.appendMarkdown(`${icon} \`${name}\` — ${s.workspaceLabel}\n\n`);
        }
        if (sessions.length > 10) tooltip.appendMarkdown(`_…+${sessions.length - 10} more_\n\n`);
      }
      tooltip.appendMarkdown('\n_Click to attach to a session._');
      this.item.tooltip = tooltip;
    } catch {
      this.item.text = '$(alert) ts: error';
    }
  }
}
