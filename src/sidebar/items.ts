import * as vscode from 'vscode';
import { SessionInfo } from '../types';
import { humanAge } from '../util';

export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly workspaceHash: string,
    public readonly sessions: SessionInfo[],
    public readonly workspacePath: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'workspace';
    const active = sessions.filter(s => s.attached).length;
    const detached = sessions.length - active;
    this.description = `${active}▶ ${detached}⇄`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${label}**`,
        `\`${workspacePath || label}\``,
        '',
        `Active: ${active}  ·  Detached: ${detached}`,
      ].join('\n\n'),
    );
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionInfo) {
    const label = session.label || `#${session.tabId}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'session';
    this.description = `${humanAge(session.lastAttached)}${session.attached ? ' · attached' : ''}`;

    const customized = Boolean(session.icon || session.color || session.label);
    const iconId = session.icon || (session.attached ? 'pass-filled' : 'circle-outline');
    const colorId = session.color || (session.attached ? 'terminal.ansiGreen' : undefined);
    this.iconPath = new vscode.ThemeIcon(
      iconId,
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );

    const displayHeader = session.label || `Session #${session.tabId}`;
    const parts = [
      `**${displayHeader}**${customized ? '  _(customized)_' : ''}`,
      `ID: \`${session.name}\``,
      `Workspace: \`${session.workspacePath || session.workspaceLabel}\``,
      `Created: ${session.createdAt.toLocaleString()}`,
      `Last attached: ${session.lastAttached.toLocaleString()}`,
      `State: ${session.attached ? 'Attached (live)' : 'Detached'}`,
    ];
    if (session.icon) parts.push(`Icon: \`${session.icon}\``);
    if (session.color) parts.push(`Color: \`${session.color}\``);
    this.tooltip = new vscode.MarkdownString(parts.join('\n\n'));

    this.command = {
      command: 'terminalSessions.attachTo',
      title: 'Attach',
      arguments: [this],
    };
  }
}
