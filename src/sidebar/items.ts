import * as vscode from 'vscode';
import { SessionInfo } from '../types';
import { humanAge } from '../util';
import { ClaudeSnapshot } from '../claude-tracker';

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

const STATE_ICONS: Record<ClaudeSnapshot['state'], string> = {
  none: '',
  working: 'loading~spin',
  tool: 'tools',
  waiting: 'warning',
  idle: 'check',
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function claudeStateDescription(snap: ClaudeSnapshot, contextPctAlert: number): string | undefined {
  // Always show context % when we have it, with a warning prefix when high.
  let ctxSuffix = '';
  if (snap.contextPct !== undefined && snap.contextPct > 0) {
    const pct = Math.round(snap.contextPct * 100);
    const warn = snap.contextPct >= contextPctAlert ? '⚠ ' : '';
    ctxSuffix = ` · ${warn}${pct}% ctx`;
  }
  switch (snap.state) {
    case 'working': {
      const since = snap.lastPromptAt ? formatElapsed(Date.now() - snap.lastPromptAt.getTime()) : '';
      return `working${since ? ' ' + since : ''}${ctxSuffix}`;
    }
    case 'tool': {
      const since = snap.toolSince ? formatElapsed(Date.now() - snap.toolSince.getTime()) : '';
      const name = snap.toolName || 'tool';
      return `${name}${since ? ' ' + since : ''}${ctxSuffix}`;
    }
    case 'waiting':
      return `waiting input${ctxSuffix}`;
    case 'idle': {
      const since = snap.lastStopAt
        ? formatElapsed(Date.now() - snap.lastStopAt.getTime())
        : (snap.lastAssistantMessageAt
          ? formatElapsed(Date.now() - snap.lastAssistantMessageAt.getTime())
          : '');
      return since ? `idle ${since}${ctxSuffix}` : `idle${ctxSuffix}`;
    }
    case 'none':
      return undefined;
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly claude: ClaudeSnapshot | undefined,
    public readonly detailsMode: 'auto' | 'always' | 'off',
    public readonly contextPctAlert: number,
  ) {
    const label = session.label || `#${session.tabId}`;
    const hasActiveClaude =
      claude !== undefined && claude.state !== 'none';
    const hasAnyClaudeData =
      hasActiveClaude || (claude !== undefined && (claude.model || claude.messageCount));
    let collapsible = vscode.TreeItemCollapsibleState.None;
    if (hasAnyClaudeData && detailsMode !== 'off') {
      const shouldExpand = detailsMode === 'always'
        ? true
        : (claude!.state === 'working' || claude!.state === 'tool' || claude!.state === 'waiting');
      collapsible = shouldExpand
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    }
    super(label, collapsible);
    // contextValue drives view/item/context menus. Shapes like "session" and
    // "session.muted" are matched by existing menus via =~ /^session/.
    this.contextValue = session.muted ? 'session.muted' : 'session';

    const attachedHint = session.attached ? ' · attached' : '';
    const mutedHint = session.muted ? ' · 🔕' : '';
    const claudeDesc = claude ? claudeStateDescription(claude, contextPctAlert) : undefined;
    const ageHint = humanAge(session.lastAttached);
    this.description = claudeDesc
      ? `${claudeDesc}${attachedHint}${mutedHint}`
      : `${ageHint}${attachedHint}${mutedHint}`;

    const customized = Boolean(session.icon || session.color || session.label);
    const claudeIcon = claude ? STATE_ICONS[claude.state] : '';
    const iconId = claudeIcon
      || session.icon
      || (session.attached ? 'pass-filled' : 'circle-outline');

    let colorId: string | undefined;
    if (claude) {
      switch (claude.state) {
        case 'waiting':   colorId = 'terminalSessions.waitingIcon'; break;
        case 'working':   colorId = 'terminalSessions.workingIcon'; break;
        case 'tool':      colorId = 'terminalSessions.toolIcon'; break;
        case 'idle':      colorId = session.color || 'terminalSessions.idleIcon'; break;
        case 'none':      colorId = session.color || (session.attached ? 'terminal.ansiGreen' : undefined); break;
      }
    } else {
      colorId = session.color || (session.attached ? 'terminal.ansiGreen' : undefined);
    }
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
    if (claude && claude.state !== 'none') {
      parts.push(`Claude: ${claudeDesc || claude.state}`);
      if (claude.model) parts.push(`Model: \`${claude.model}\``);
      if (claude.messageCount) parts.push(`Turns: ${claude.messageCount}`);
      if (claude.cost !== undefined) {
        const breakdown = claude.costByModel
          ? Object.entries(claude.costByModel)
              .filter(([, c]) => c > 0.0005)
              .map(([m, c]) => `${shortenModel(m)}: $${c.toFixed(2)}`)
              .join(' · ')
          : '';
        parts.push(`Cost (API equivalent): **$${claude.cost.toFixed(2)}**${breakdown ? ` (${breakdown})` : ''}`);
      }
      if (claude.contextTokens !== undefined && claude.contextLimit) {
        const pct = Math.round((claude.contextPct || 0) * 100);
        parts.push(`Context: ${claude.contextTokens.toLocaleString()} / ${claude.contextLimit.toLocaleString()} (${pct}%)`);
      }
      if (claude.tokens) {
        const t = claude.tokens;
        parts.push(
          `Tokens — out: ${t.output.toLocaleString()} · in: ${t.input.toLocaleString()}`
          + ` · cache read: ${t.cacheRead.toLocaleString()}`
          + ` · cache 5m: ${t.cacheCreate5m.toLocaleString()}`
          + ` · cache 1h: ${t.cacheCreate1h.toLocaleString()}`,
        );
      }
      if (claude.lastUserMessage) parts.push(`**User:** ${claude.lastUserMessage}`);
      if (claude.lastAssistantMessage) parts.push(`**Claude:** ${claude.lastAssistantMessage}`);
      if (claude.toolInput) parts.push(`**Tool input:** \`${claude.toolInput}\``);
    }
    this.tooltip = new vscode.MarkdownString(parts.join('\n\n'));

    this.command = {
      command: 'terminalSessions.attachTo',
      title: 'Attach',
      arguments: [this],
    };
  }
}

export class ClaudeDetailItem extends vscode.TreeItem {
  constructor(label: string, description?: string, iconId?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (description) this.description = description;
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = 'claudeDetail';
    this.tooltip = description ? `${label} ${description}` : label;
  }
}

export function buildClaudeDetails(snap: ClaudeSnapshot): ClaudeDetailItem[] {
  const items: ClaudeDetailItem[] = [];
  if (snap.lastUserMessage) {
    items.push(new ClaudeDetailItem(`"${snap.lastUserMessage}"`, undefined, 'comment'));
  }
  if (snap.lastAssistantMessage) {
    items.push(new ClaudeDetailItem(`Claude: ${snap.lastAssistantMessage}`, undefined, 'hubot'));
  }
  if (snap.state === 'tool' && snap.toolName) {
    const preview = snap.toolInput ? `"${snap.toolInput}"` : '';
    items.push(new ClaudeDetailItem(`${snap.toolName}${preview ? ' ' + preview : ''}`, undefined, 'tools'));
  }
  const metaBits: string[] = [];
  if (snap.model) metaBits.push(shortenModel(snap.model));
  if (snap.cost !== undefined && snap.cost > 0) {
    metaBits.push(`$${snap.cost.toFixed(2)}`);
  }
  if (snap.messageCount) metaBits.push(`${snap.messageCount} turns`);
  if (metaBits.length > 0) {
    items.push(new ClaudeDetailItem(metaBits.join(' · '), undefined, 'info'));
  }
  if (snap.lastStopAt && snap.state === 'idle') {
    items.push(new ClaudeDetailItem(
      `idle ${formatElapsed(Date.now() - snap.lastStopAt.getTime())}`,
      undefined,
      'clock',
    ));
  }
  return items;
}

function shortenModel(m: string): string {
  // "claude-opus-4-7" → "opus"; leave others unchanged
  const match = m.match(/claude-(opus|sonnet|haiku)/i);
  return match ? match[1].toLowerCase() : m;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

