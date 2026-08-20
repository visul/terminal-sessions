import * as vscode from 'vscode';
import { SessionInfo, KilledEntry } from '../types';
import { humanAge } from '../util';
import { ClaudeSnapshot } from '../claude-tracker';
import { SubagentSnapshot } from '../claude-transcript';
import { outcomeLabel } from '../outcome';
import { STOPPED_URI_SCHEME, BRANCH_URI_SCHEME } from '../config';

/**
 * User-defined folder within a workspace.
 *   - kind 'group': holds sessions that share a groupId.
 *   - kind 'master': holds other groups/masters (a "group of groups"), never
 *     sessions directly. Rendered with a distinct `library` icon and a
 *     `(N groups)` description so it reads clearly as a container of folders.
 * Both kinds sit at their parent level (root or inside a master) and share the
 * parent's sortOrder pool — drag-drop reorders and re-parents them.
 */
export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly groupId: string,
    public readonly groupName: string,
    public readonly kind: 'group' | 'master',
    public readonly sessions: SessionInfo[],
    // For masters: the direct child groups/masters (used for the count +
    // recursive session tally). Empty for normal groups.
    public readonly childGroupCount: number = 0,
    // Optional theme color id tinting the icon (right-click → Change Group Color).
    public readonly color?: string,
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    // Stable id (unique across the tree) so treeView.reveal() matches this node
    // by id even when getChildren rebuilds a fresh instance — required for
    // expanding a collapsed group/master to bring a nested session into view.
    this.id = `grp:${workspaceHash}:${groupId}`;
    const tint = color ? new vscode.ThemeColor(color) : undefined;
    if (kind === 'master') {
      this.contextValue = 'masterGroup';
      // `layers` (stacked) reads as a "group of groups" — distinct from the
      // plain `folder` used for normal groups.
      this.iconPath = new vscode.ThemeIcon('layers', tint);
      const n = childGroupCount;
      this.description = `${n} group${n === 1 ? '' : 's'}`;
      // sessions here is the RECURSIVE tally of all sessions under this master.
      const stopped = sessions.filter(s => s.stopped).length;
      const active = sessions.filter(s => !s.stopped && s.attached).length;
      this.tooltip = new vscode.MarkdownString(
        [
          `**${groupName}**  _(master group)_`,
          `${n} group${n === 1 ? '' : 's'} · ${sessions.length} session${sessions.length === 1 ? '' : 's'} total`,
          `Active: ${active}  ·  Stopped: ${stopped}`,
          `Holds only groups — drag groups in/out.`,
        ].join('\n\n'),
      );
      return;
    }
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon('folder', tint);
    const stopped = sessions.filter(s => s.stopped).length;
    const active = sessions.filter(s => !s.stopped && s.attached).length;
    const detached = sessions.filter(s => !s.stopped && !s.attached).length;
    this.description = formatGroupCounts(active, detached, stopped);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${groupName}**  _(group)_`,
        `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
        `Active: ${active}  ·  Detached: ${detached}${stopped > 0 ? `  ·  Stopped: ${stopped}` : ''}`,
      ].join('\n\n'),
    );
  }
}

/**
 * Collapsible header for a fork branch set: gathers all its member sessions under
 * one node so parallel forks read as a cluster. Virtual — computed at render time
 * from `branchSetId`, NOT a persisted group, so it has no drag-drop/rename/color.
 * The `repo-forked` icon (tinted with the set color) marks it as a fork cluster,
 * distinct from folder groups (`folder`) and masters (`layers`). Default-expanded;
 * VS Code persists the user's collapse by the stable id `clu:hash:setId`.
 */
export class BranchClusterItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly branchSetId: string,
    public readonly members: SessionInfo[],
    baseLabel: string,
    colorId: string | undefined,
    // The container all members share (undefined = workspace root). Drives
    // getParent() so reveal() expands the right ancestor chain.
    public readonly groupId: string | undefined,
  ) {
    super(baseLabel || 'fork', vscode.TreeItemCollapsibleState.Expanded);
    this.id = `clu:${workspaceHash}:${branchSetId}`;
    this.contextValue = 'branchCluster';
    this.iconPath = new vscode.ThemeIcon(
      'repo-forked',
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );
    const n = members.length;
    this.description = `${n} fork${n === 1 ? '' : 's'}`;
    const active = members.filter(s => !s.stopped && s.attached).length;
    const detached = members.filter(s => !s.stopped && !s.attached).length;
    const stopped = members.filter(s => s.stopped).length;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${baseLabel || 'fork'}**  _(fork cluster)_`,
        `${n} branch${n === 1 ? '' : 'es'} forked from the same conversation`,
        `Active: ${active}  ·  Detached: ${detached}${stopped > 0 ? `  ·  Stopped: ${stopped}` : ''}`,
        `Peers:`,
        ...members.map(s => `- ${s.label || `#${s.tabId}`}`),
      ].join('\n\n'),
    );
  }
}

export class WorkspaceTreeItem extends vscode.TreeItem {
  public readonly allSessions: SessionInfo[];
  constructor(
    public readonly label: string,
    public readonly workspaceHash: string,
    public readonly sessions: SessionInfo[],
    public readonly workspacePath: string,
    allSessions?: SessionInfo[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `ws:${workspaceHash}`;
    this.allSessions = allSessions ?? sessions;
    this.contextValue = 'workspace';
    // Counts always reflect the whole workspace (pre-filter), so the stopped
    // tally is visible even when sidebarFilterMode is hiding stopped rows.
    const countSrc = allSessions ?? sessions;
    const stopped = countSrc.filter(s => s.stopped).length;
    const active = countSrc.filter(s => !s.stopped && s.attached).length;
    const detached = countSrc.filter(s => !s.stopped && !s.attached).length;
    this.description = formatGroupCounts(active, detached, stopped);
    // `root-folder-opened` clearly marks the workspace root, distinct from the
    // `layers` master and plain `folder` groups beneath it.
    this.iconPath = new vscode.ThemeIcon('root-folder-opened');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${label}**`,
        `\`${workspacePath || label}\``,
        '',
        `Active: ${active}  ·  Detached: ${detached}${stopped > 0 ? `  ·  Stopped: ${stopped}` : ''}`,
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

/** Compact folder/workspace count badge: stopped `⏸` first, then the live
 *  sessions with the currently-running ones last — detached `⇄`, then working
 *  `▶`. Zero counts are omitted so only real numbers show (`1⏸`, `2⏸ · 1▶`,
 *  `2⏸ · 1⇄ 2▶`); all-zero yields `''`. The ` · ` keeps the stopped/live divide
 *  whenever both sides are present. */
function formatGroupCounts(active: number, detached: number, stopped: number): string {
  const stoppedSeg = stopped > 0 ? `${stopped}⏸` : '';
  const live = [
    detached > 0 ? `${detached}⇄` : '',
    active > 0 ? `${active}▶` : '',
  ].filter(Boolean).join(' ');
  return [stoppedSeg, live].filter(Boolean).join(' · ');
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function claudeStateDescription(snap: ClaudeSnapshot): string | undefined {
  // Context % moved to the expanded details row (alongside model · cost · turns)
  // to keep the main row tight. "N done" count removed entirely; only the
  // active-running counter survives because it's the only one that's actionable.
  const active = (snap.subagents || []).filter((s) => s.state !== 'done').length;
  const agentSuffix = active > 0 ? ` · 🤖 ${active} running` : '';
  switch (snap.state) {
    case 'working': {
      const since = snap.lastPromptAt ? formatElapsed(Date.now() - snap.lastPromptAt.getTime()) : '';
      return `working${since ? ' ' + since : ''}${agentSuffix}`;
    }
    case 'tool': {
      const since = snap.toolSince ? formatElapsed(Date.now() - snap.toolSince.getTime()) : '';
      const name = snap.toolName || 'tool';
      return `${name}${since ? ' ' + since : ''}${agentSuffix}`;
    }
    case 'waiting':
      return `waiting input${agentSuffix}`;
    case 'idle': {
      const since = snap.lastStopAt
        ? formatElapsed(Date.now() - snap.lastStopAt.getTime())
        : (snap.lastAssistantMessageAt
          ? formatElapsed(Date.now() - snap.lastAssistantMessageAt.getTime())
          : '');
      const outcome = snap.outcome && snap.outcome.kind !== 'ok' ? outcomeLabel(snap.outcome) : '';
      if (snap.dismissed) return `dismissed${since ? ' ' + since : ''}${agentSuffix}`;
      // Unread: lead with the verdict ("done 2m", "✗ tests failed 2m") so the
      // row reads as a result, not as a clock. Seen: back to the idle clock,
      // with a non-ok verdict kept as a trailing hint.
      if (snap.unread) {
        const head = outcome || 'done';
        return `${head}${since ? ' ' + since : ''}${agentSuffix}`;
      }
      const base = since ? `idle ${since}` : 'idle';
      return `${base}${outcome ? ' · ' + outcome : ''}${agentSuffix}`;
    }
    case 'none':
      return undefined;
  }
}

/** Short label distinguishing non-Claude agents in the row/tooltip. Empty for
 *  Claude (and legacy/undefined) so existing Claude rows read exactly as before. */
function agentLabel(agent: ClaudeSnapshot['agent']): string {
  switch (agent) {
    case 'codex': return 'Codex';
    case 'agy': return 'Antigravity';
    case 'grok': return 'Grok';
    default: return '';
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly claude: ClaudeSnapshot | undefined,
    public readonly detailsMode: 'auto' | 'always' | 'collapsed' | 'off',
    public readonly contextPctAlert: number,
    // True when this row renders inside a fork cluster: the cluster header already
    // carries the ⑂ meaning, so the per-row chip is suppressed to cut redundancy.
    public readonly inCluster = false,
  ) {
    const label = session.label || `#${session.tabId}`;
    const hasActiveClaude =
      claude !== undefined && claude.state !== 'none';
    const hasAnyClaudeData =
      hasActiveClaude || (claude !== undefined && (claude.model || claude.messageCount));
    let collapsible = vscode.TreeItemCollapsibleState.None;
    let expansionSalt = '';
    if (hasAnyClaudeData && detailsMode !== 'off') {
      const shouldExpand = detailsMode === 'always'
        ? true
        : detailsMode === 'collapsed'
        ? false // details exist as a collapsible row, but never auto-expand
        : (claude!.state === 'working' || claude!.state === 'tool' || claude!.state === 'waiting');
      collapsible = shouldExpand
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      // In 'auto' mode the expansion is supposed to follow Claude's state, but VS
      // Code persists expand/collapse keyed by TreeItem.id and ignores the
      // recomputed collapsibleState on a rebuild with the same id. Salt the id
      // with the desired state so an idle→working transition produces a "new"
      // item that actually auto-expands (and re-collapses when idle again).
      // 'collapsed'/'off' keep the plain id so the user's manual toggle sticks.
      if (detailsMode === 'auto') expansionSalt = shouldExpand ? ':e1' : ':e0';
    }
    super(label, collapsible);
    // Stable id (unique across the tree) so treeView.reveal() can locate and
    // scroll to this session by id regardless of which fresh instance a
    // getChildren pass produced. The optional expansion salt (auto mode) is the
    // only thing that varies it, and only when the details' desired state flips.
    this.id = `ses:${session.workspaceHash}:${session.name}${expansionSalt}`;
    // Stopped session: muted icon + greyed label via FileDecorationProvider,
    // single-click row to start, no Claude details (process is dead).
    if (session.stopped) {
      // Stopped scheme: session.stopped(.fav)?(.locked)? — fav first, matching
      // the running rows where .fav directly follows the base token.
      this.contextValue = 'session.stopped'
        + (session.favorite ? '.fav' : '')
        + (session.locked ? '.locked' : '');
      this.iconPath = new vscode.ThemeIcon(
        'debug-stop',
        new vscode.ThemeColor('disabledForeground'),
      );
      const ageHint = humanAge(session.lastAttached);
      // A stopped session still carries the flags Start will relaunch with, so a
      // yolo one must say so BEFORE the click — clicking this row runs Start
      // directly, with no confirmation anywhere on that path.
      this.description = `${session.favorite ? '★ ' : ''}stopped · idle ${ageHint}${session.locked ? ' · 🔒' : ''}`
        + (session.yolo ? ' · 🚨' : '');
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
      this.resourceUri = vscode.Uri.parse(
        `${STOPPED_URI_SCHEME}:${encodeURIComponent(session.name)}`,
      );
      const displayHeader = session.label || `Session #${session.tabId}`;
      const parts = [
        `**${displayHeader}** _(stopped)_`,
        `ID: \`${session.name}\``,
        `Workspace: \`${session.workspacePath || session.workspaceLabel}\``,
      ];
      if (session.folderPath && session.folderPath !== session.workspacePath) {
        parts.push(`Folder (session cwd): \`${session.folderPath}\``);
      }
      parts.push(`Created: ${session.createdAt.toLocaleString()}`);
      if (claude?.sessionId) {
        parts.push(`Last Claude session: \`${claude.sessionId.slice(0, 8)}…\` (will auto-resume on Start)`);
      }
      if (session.yolo) {
        const why = (session.yoloFlags || []).map(f => `\`${f}\``).join(', ');
        parts.push(
          `🚨 **Will start in YOLO mode** — Start relaunches this session with `
          + `${why || 'auto-approve flags'}, so tool use, file writes and shell commands `
          + `run without asking.`,
        );
      }
      parts.push(`Click to start.`);
      this.tooltip = new vscode.MarkdownString(parts.join('\n\n'));
      this.command = {
        command: 'terminalSessions.start',
        title: 'Start',
        arguments: [this],
      };
      return;
    }
    // contextValue drives view/item/context menus. Flags are appended in a FIXED
    // order — fav, muted, forkable, branched, locked, yolo — so menu `when`
    // regexes can match any combination, e.g. "session", "session.fav",
    // "session.muted", "session.fav.muted.forkable.branched.locked.yoloOn".
    // Any change to this order requires updating every session `when` regex in
    // package.json (they are anchored). `forkable` = latest agent supports fork
    // (Claude), gating the Fork command; `branched` = in a branch set, gating
    // Unlink. The trailing yolo token is `.yoloOn`/`.yoloOff` when the agent has
    // an auto-approve mode we can drive (absent entirely when it doesn't), which
    // both gates the two Switch commands and picks which of them shows — one
    // token rather than two keeps the other regexes to a single extra group.
    // Stopped rows use a separate scheme and carry none of these.
    let cv = 'session';
    if (session.favorite) cv += '.fav';
    if (session.muted) cv += '.muted';
    if (session.forkable) cv += '.forkable';
    if (session.branchSetId) cv += '.branched';
    if (session.locked) cv += '.locked';
    if (session.yoloCapable) cv += session.yolo ? '.yoloOn' : '.yoloOff';
    // Trailing `.attn` = row is asking for attention (unread result or a live
    // waiting state): gates the Dismiss command.
    if (claude && (claude.unread || claude.state === 'waiting')) cv += '.attn';
    this.contextValue = cv;

    // Fork branch-set members carry a resourceUri in the branch scheme so the
    // BranchSetDecorationProvider paints the ⑂ chip (in the set's color). The
    // color id and set name ride in the query, so the provider needs no index
    // lookup. Stopped rows already own their resourceUri (the greyed-out
    // decoration and its early return above), so a stopped+branched session keeps
    // the stopped look and drops its chip — an acceptable trade-off, since dimmed
    // rows aren't part of active parallel work.
    if (session.branchSetId && !inCluster) {
      this.resourceUri = vscode.Uri.parse(
        `${BRANCH_URI_SCHEME}://branch/${session.workspaceHash}/${encodeURIComponent(session.name)}` +
        `?c=${encodeURIComponent(session.branchColorId || '')}&n=${encodeURIComponent(session.branchName || 'branch')}`,
      );
    }

    // Attached state is now encoded in the icon (filled vs outline) instead
    // of a trailing " · attached" text, which was just noise on every row.
    // ★ leads the description so the favorite state is visible at rest — the
    // inline star action itself only appears on hover.
    const favHint = session.favorite ? '★ ' : '';
    const mutedHint = session.muted ? ' · 🔕' : '';
    const lockHint = session.locked ? ' · 🔒' : '';
    // Auto-approve sessions act without asking, so the row says so at a glance.
    const yoloHint = session.yolo ? ' · 🚨' : '';
    const aLabel = claude ? agentLabel(claude.agent) : '';
    const claudeDesc = claude ? claudeStateDescription(claude) : undefined;
    // Prefix the agent name for non-Claude rows so "Codex working 12s" vs
    // "working 12s" (Claude) are distinguishable at a glance.
    const stateDesc = claudeDesc
      ? (aLabel ? `${aLabel} · ${claudeDesc}` : claudeDesc)
      : undefined;
    const ageHint = humanAge(session.lastAttached);
    this.description = stateDesc
      ? `${favHint}${stateDesc}${mutedHint}${lockHint}${yoloHint}`
      : `${favHint}${ageHint}${mutedHint}${lockHint}${yoloHint}`;

    const customized = Boolean(session.icon || session.color || session.label);
    // Unread results get a distinct glyph per verdict so a row reads at a glance:
    // filled check (done), error (failed/red tests), question (agent asked you).
    const unreadIcon = claude?.state === 'idle' && claude.unread
      ? (claude.unread === 'error' ? 'error' : claude.unread === 'asked' ? 'question' : 'pass-filled')
      : '';
    const claudeIcon = unreadIcon || (claude ? STATE_ICONS[claude.state] : '');
    // Detached sessions get a hollow circle regardless of Claude state — a
    // clear visual cue that nobody's currently attached to the tmux session.
    // Claude state is still visible via the icon color below.
    const iconId = !session.attached
      ? 'circle-outline'
      : (claudeIcon || session.icon || 'pass-filled');

    let colorId: string | undefined;
    if (claude) {
      switch (claude.state) {
        case 'waiting':   colorId = 'terminalSessions.waitingIcon'; break;
        case 'working':   colorId = 'terminalSessions.workingIcon'; break;
        case 'tool':      colorId = 'terminalSessions.toolIcon'; break;
        case 'idle':
          colorId = claude.unread === 'error' ? 'terminalSessions.unreadErrorIcon'
            : claude.unread === 'asked' ? 'terminalSessions.waitingIcon'
            : claude.unread === 'done' ? 'terminalSessions.unreadDoneIcon'
            : (session.color || 'terminalSessions.idleIcon');
          break;
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
    ];
    // Show the actual start folder for subfolder sessions — the cwd the tmux
    // session (and any agent) runs in, distinct from the VS Code workspace root.
    if (session.folderPath && session.folderPath !== session.workspacePath) {
      parts.push(`Folder (session cwd): \`${session.folderPath}\``);
    }
    parts.push(
      `Created: ${session.createdAt.toLocaleString()}`,
      `Last attached: ${session.lastAttached.toLocaleString()}`,
      `State: ${session.attached ? 'Attached (live)' : 'Detached'}`,
    );
    if (session.locked) parts.push(`🔒 **Locked** — protected from Kill (right-click → Unlock to remove)`);
    // Name the flags actually responsible instead of a hardcoded one — agents
    // reach auto-approve by more than one spelling.
    if (session.yolo) {
      const why = (session.yoloFlags || []).map(f => `\`${f}\``).join(', ');
      parts.push(
        `🚨 **YOLO mode** — launched with ${why || 'auto-approve flags'}; `
        + `tool use, file writes and shell commands run without asking. `
        + `Right-click → Switch to Normal Mode to restore prompts.`,
      );
    }
    if (session.icon) parts.push(`Icon: \`${session.icon}\``);
    if (session.color) parts.push(`Color: \`${session.color}\``);
    if (claude && claude.state !== 'none') {
      parts.push(`${aLabel || 'Claude'}: ${claudeDesc || claude.state}`);
      if (claude.unread) {
        parts.push(`**Unread** — finished since you last looked. Focus the terminal or right-click → Dismiss to clear.`);
      }
      if (claude.outcome && claude.outcome.kind !== 'ok' && claude.state === 'idle') {
        parts.push(`Last turn: **${outcomeLabel(claude.outcome)}**${claude.outcome.hint ? ` — \`${claude.outcome.hint}\`` : ''}`);
      }
      if (claude.dismissed) parts.push(`_Waiting state dismissed — reappears on new agent activity._`);
      if (claude.sessionId) parts.push(`Conversation ID: \`${claude.sessionId}\``);
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
      if (claude.lastAssistantMessage) parts.push(`**${aLabel || 'Claude'}:** ${claude.lastAssistantMessage}`);
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

const SUBAGENT_ICONS: Record<SubagentSnapshot['state'], string> = {
  working: 'loading~spin',
  tool: 'tools',
  done: 'check',
};

function shortenAgentType(t: string | undefined): string {
  if (!t) return 'agent';
  // Trim common namespace prefixes like "everything-claude-code:code-reviewer".
  const afterColon = t.split(':').pop() ?? t;
  return afterColon;
}

/**
 * Collapsible group row holding all top-level subagents of a session.
 * Keeps the main session expansion clean when a turn spawned many agents.
 * Expand → list of SubagentTreeItem rows (one per top-level subagent).
 */
export class SubagentsFolderItem extends vscode.TreeItem {
  constructor(
    public readonly parentSession: SessionInfo,
    public readonly transcriptPath: string | undefined,
    public readonly topLevelSubagents: SubagentSnapshot[],
    public readonly allSubagents: SubagentSnapshot[],
  ) {
    const active = topLevelSubagents.filter((s) => s.state !== 'done').length;
    const done = topLevelSubagents.length - active;
    const label = active > 0
      ? `Agents (${active} running${done > 0 ? ` · ${done} done` : ''})`
      : `Agents (${done} done)`;
    // Expand by default when any agent is live so the user sees activity
    // without an extra click; collapse when everything is already done.
    const collapse = active > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(label, collapse);
    this.contextValue = 'subagentsFolder';
    this.iconPath = new vscode.ThemeIcon(
      'hubot',
      new vscode.ThemeColor(active > 0 ? 'terminalSessions.workingIcon' : 'terminalSessions.idleIcon'),
    );
    const lines = [
      `**🤖 Agents** (${topLevelSubagents.length} total)`,
      `Running: ${active}  ·  Done: ${done}`,
    ];
    if (topLevelSubagents.length > 0) {
      const sample = topLevelSubagents.slice(0, 5)
        .map((s) => `- \`${shortenAgentType(s.agentType)}\` ${s.description ? '— ' + s.description : ''} (${s.state})`)
        .join('\n');
      lines.push(sample);
      if (topLevelSubagents.length > 5) lines.push(`…and ${topLevelSubagents.length - 5} more`);
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
  }
}

/**
 * Tree item for a single subagent under a Claude-active session.
 *
 * - The inline description surfaces state + elapsed time (and current tool
 *   name when one is active), matching the main SessionTreeItem language.
 * - Expanding shows the subagent's children: any NESTED subagents, its
 *   current tool with its input, and the last streamed text block.
 * - Tooltip spells out the full agentType + description + timestamps and
 *   offers the `Open Subagent Transcript` command via contextValue.
 */
export class SubagentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly parentSession: SessionInfo,
    public readonly transcriptPath: string | undefined,
    public readonly subagent: SubagentSnapshot,
    public readonly nestedChildren: SubagentSnapshot[],
  ) {
    const agentLabel = shortenAgentType(subagent.agentType);
    const desc = subagent.description ? ` — ${subagent.description}` : '';
    const label = `${agentLabel}${desc}`;

    // Collapse by default unless this subagent has nested children or has
    // useful "live" detail rows to show (current tool / last message).
    const hasChildren = nestedChildren.length > 0
      || !!subagent.currentTool
      || !!subagent.lastMessage;
    const initialCollapse = hasChildren
      ? (subagent.state === 'done'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded)
      : vscode.TreeItemCollapsibleState.None;

    super(label, initialCollapse);
    this.contextValue = 'subagent';

    const icon = SUBAGENT_ICONS[subagent.state];
    let color: string | undefined;
    switch (subagent.state) {
      case 'working': color = 'terminalSessions.workingIcon'; break;
      case 'tool':    color = 'terminalSessions.toolIcon';    break;
      case 'done':    color = 'terminalSessions.idleIcon';    break;
    }
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);

    const start = subagent.startedAt.getTime();
    const end = subagent.completedAt?.getTime() || Date.now();
    const elapsedMs = Math.max(0, end - start);
    const elapsed = formatElapsedMs(elapsedMs);
    let inline: string;
    switch (subagent.state) {
      case 'tool':    inline = `${subagent.currentTool || 'tool'} ${elapsed}`; break;
      case 'working': inline = `working ${elapsed}`; break;
      case 'done':    inline = `done in ${elapsed}`; break;
    }
    this.description = inline;

    const tooltipParts: string[] = [
      `**${agentLabel}**${desc}`,
      `State: ${subagent.state}`,
      `Started: ${subagent.startedAt.toLocaleString()}`,
    ];
    if (subagent.completedAt) {
      tooltipParts.push(`Completed: ${subagent.completedAt.toLocaleString()}`);
    }
    tooltipParts.push(`Depth: ${subagent.depth}`);
    if (subagent.parentId) tooltipParts.push(`Parent subagent: \`${subagent.parentId.slice(0, 12)}\``);
    if (subagent.currentTool) {
      tooltipParts.push(`Current tool: \`${subagent.currentTool}\``);
      if (subagent.currentToolInput) tooltipParts.push(`Tool input: \`${subagent.currentToolInput}\``);
    }
    if (subagent.lastMessage) tooltipParts.push(`**Last:** ${subagent.lastMessage}`);
    this.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
  }
}

function formatElapsedMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export function buildClaudeDetails(snap: ClaudeSnapshot, contextPctAlert: number): ClaudeDetailItem[] {
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
  // Context % lives here now (used to sit in the main row description).
  // Warning prefix when over the configured alert threshold.
  if (snap.contextPct !== undefined && snap.contextPct > 0) {
    const pct = Math.round(snap.contextPct * 100);
    const warn = snap.contextPct >= contextPctAlert ? '⚠ ' : '';
    metaBits.push(`${warn}${pct}% ctx`);
  }
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


/** Pinned virtual folder "Sessions Activity": a flat, group-free list of the
 *  workspace's sessions ordered by recency — running first (most recently
 *  active on top), then stopped ones by stop time. Rows are ordinary
 *  SessionTreeItems (all actions work); they mirror sessions that also appear
 *  in their groups below, so this is a shortcut, not a move. */
/** Pinned virtual folder "Favorite Sessions": starred sessions of the
 *  workspace, running and stopped alike. Hidden while empty. */
export class FavoritesFolderItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly sessions: SessionInfo[],
  ) {
    super('Favorite Sessions', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `favf:${workspaceHash}`;
    this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
    this.description = String(sessions.length);
    this.contextValue = 'favoritesFolder';
    this.tooltip = 'Starred sessions. Click the ☆ on any session row to add or remove it. Right-click (or the view\'s ⋯ menu) to disable.';
  }
}

/** Pinned virtual folder "Open Sessions": sessions with a terminal tab open in
 *  THIS window, in panel order. Hidden while empty. */
export class OpenFolderItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly sessions: SessionInfo[],
  ) {
    super('Open Sessions', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `openf:${workspaceHash}`;
    this.iconPath = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green'));
    this.description = String(sessions.length);
    this.contextValue = 'openFolder';
    this.tooltip = 'Sessions currently open as terminal tabs in this window, in tab order. Right-click (or the view\'s ⋯ menu) to disable.';
  }
}

export class ActivityFolderItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly sessions: SessionInfo[],
  ) {
    super('Recent Sessions', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `actf:${workspaceHash}`;
    this.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.yellow'));
    this.description = String(sessions.length);
    this.contextValue = 'activityFolder';
    this.tooltip = 'Most recent sessions — running first, then by stop time. Right-click (or the view\'s ⋯ menu) to disable.';
  }
}

/** Pinned virtual folder "Sessions Killed": the workspace graveyard. Killed
 *  sessions land here (capped) instead of vanishing; right-click → Restore
 *  brings one back with its conversation history. */
export class KilledFolderItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly entries: KilledEntry[],
  ) {
    super('Killed Sessions', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `kilf:${workspaceHash}`;
    this.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('descriptionForeground'));
    this.description = String(entries.length);
    this.contextValue = 'killedFolder';
    this.tooltip = 'Recently killed sessions. Right-click one to restore it (with its conversation). Right-click this folder (or the view\'s ⋯ menu) to disable.';
  }
}

/** One killed session inside the graveyard folder. Restore-only row. */
export class KilledSessionItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly entry: KilledEntry,
  ) {
    super(entry.meta.label || entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = `kil:${workspaceHash}:${entry.name}:${entry.killedAt}`;
    this.description = `killed ${humanAge(new Date(entry.killedAt))}`;
    this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    this.contextValue = 'killedSession';
    const convs = entry.meta.agentSessions?.length ?? entry.meta.claudeSessionHistory?.length ?? 0;
    this.tooltip = new vscode.MarkdownString(
      `**${entry.meta.label || entry.name}**\n\n`
      + `Killed ${humanAge(new Date(entry.killedAt))}`
      + (convs ? ` · ${convs} recorded conversation${convs === 1 ? '' : 's'}` : '')
      + '\n\nRight-click → Restore Session to bring it back; Start then resumes its conversation.',
    );
  }
}
