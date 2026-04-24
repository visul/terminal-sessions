import * as vscode from 'vscode';
import { SessionIndex, enrichSessions, groupByWorkspace } from '../session-manager';
import * as tmux from '../tmux';
import { getConfig, setSortMode, VIEW_ID, SidebarSortMode } from '../config';
import { WorkspaceTreeItem, SessionTreeItem, SubagentTreeItem, SubagentsFolderItem, buildClaudeDetails } from './items';
import { SessionInfo } from '../types';
import { ClaudeTracker } from '../claude-tracker';

const DRAG_MIME = 'application/vnd.code.tree.terminalsessions';

function sortSessions(group: SessionInfo[], mode: SidebarSortMode): SessionInfo[] {
  const list = [...group];
  switch (mode) {
    case 'custom': {
      // Sessions with sortOrder defined go first (by order asc); rest fall back
      // to creation order (tabId asc) so newly-created sessions append.
      list.sort((a, b) => {
        const ao = a.sortOrder;
        const bo = b.sortOrder;
        if (ao !== undefined && bo !== undefined) return ao - bo;
        if (ao !== undefined) return -1;
        if (bo !== undefined) return 1;
        return a.tabId - b.tabId;
      });
      return list;
    }
    case 'mru': {
      // Most recently focused first. Falls back to lastAttached, then tabId.
      list.sort((a, b) => {
        const at = a.lastActiveAt?.getTime() ?? a.lastAttached.getTime();
        const bt = b.lastActiveAt?.getTime() ?? b.lastAttached.getTime();
        if (bt !== at) return bt - at;
        return a.tabId - b.tabId;
      });
      return list;
    }
    case 'alphabetical': {
      list.sort((a, b) => {
        const al = (a.label || `#${a.tabId}`).toLowerCase();
        const bl = (b.label || `#${b.tabId}`).toLowerCase();
        return al.localeCompare(bl);
      });
      return list;
    }
    case 'created':
    default:
      list.sort((a, b) => a.tabId - b.tabId);
      return list;
  }
}

class SessionsTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>,
             vscode.TreeDragAndDropController<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  // Track the last rendered items so treeView.reveal() can be fed the exact
  // element instance VS Code has in the tree (reveal requires identity
  // equality, not just a fresh item with the same contents).
  private lastWorkspaceItems = new Map<string, WorkspaceTreeItem>();
  private lastSessionItems = new Map<string, SessionTreeItem>();

  constructor(
    private index: SessionIndex,
    private claude: ClaudeTracker,
  ) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  /** Required for treeView.reveal() to work on nested items. */
  getParent(el: vscode.TreeItem): vscode.TreeItem | undefined {
    if (el instanceof SessionTreeItem) {
      return this.lastWorkspaceItems.get(el.session.workspaceHash);
    }
    return undefined;
  }

  getLastSessionItem(name: string): SessionTreeItem | undefined {
    return this.lastSessionItems.get(name);
  }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const cfg = getConfig();
    const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) {
      const item = new vscode.TreeItem('tmux not installed — run: brew install tmux',
        vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('alert');
      return [item];
    }
    const sessions = await enrichSessions(tmuxPath, cfg.sessionPrefix, this.index);
    if (!el) {
      if (sessions.length === 0) {
        this.lastWorkspaceItems.clear();
        this.lastSessionItems.clear();
        const item = new vscode.TreeItem('No persistent sessions yet.',
          vscode.TreeItemCollapsibleState.None);
        item.description = 'Click + to create one';
        return [item];
      }
      const grouped = groupByWorkspace(sessions);
      const out: vscode.TreeItem[] = [];
      this.lastWorkspaceItems.clear();
      for (const [hash, group] of grouped) {
        const ordered = sortSessions(group, cfg.sidebarSortMode);
        const wsPath = ordered[0].workspacePath;
        const wsItem = new WorkspaceTreeItem(ordered[0].workspaceLabel, hash, ordered, wsPath);
        this.lastWorkspaceItems.set(hash, wsItem);
        out.push(wsItem);
      }
      return out;
    }
    if (el instanceof WorkspaceTreeItem) {
      return el.sessions.map(s => {
        const item = new SessionTreeItem(
          s,
          this.claude.getSnapshot(s.name),
          cfg.claudeSidebarDetails,
          cfg.contextWarnPct,
        );
        this.lastSessionItems.set(s.name, item);
        return item;
      });
    }
    if (el instanceof SessionTreeItem) {
      const snap = el.claude;
      if (!snap) return [];
      const children: vscode.TreeItem[] = buildClaudeDetails(snap);
      // Wrap subagents under a single collapsible folder so sessions with
      // many spawned agents stay tidy. Folder is rendered only when at least
      // one subagent survives the `showCompletedSubagents` filter.
      const subs = snap.subagents || [];
      const showCompleted = cfg.showCompletedSubagents;
      const top = subs.filter((s) =>
        !s.parentId && (showCompleted || s.state !== 'done'),
      );
      if (top.length > 0) {
        children.push(new SubagentsFolderItem(
          el.session,
          snap.transcriptPath,
          top,
          subs,
        ));
      }
      return children;
    }
    if (el instanceof SubagentsFolderItem) {
      const cfgNow = getConfig();
      const showCompleted = cfgNow.showCompletedSubagents;
      return el.topLevelSubagents.map((s) => {
        const nested = el.allSubagents.filter(
          (x) => x.parentId === s.id && (showCompleted || x.state !== 'done'),
        );
        return new SubagentTreeItem(el.parentSession, el.transcriptPath, s, nested);
      });
    }
    if (el instanceof SubagentTreeItem) {
      const out: vscode.TreeItem[] = [];
      // Nested subagents first, then the current tool row, then last message.
      const showCompleted = cfg.showCompletedSubagents;
      const nested = el.nestedChildren.filter((s) => showCompleted || s.state !== 'done');
      // To build recursive tree, we also need this subagent's grandchildren
      // accessible via its own snapshot.subagents lookup. We re-resolve via
      // the parent session's Claude snapshot.
      const sessionSnap = this.claude.getSnapshot(el.parentSession.name);
      const allSubs = sessionSnap?.subagents || [];
      for (const s of nested) {
        const grandchildren = allSubs.filter((x) => x.parentId === s.id && (showCompleted || x.state !== 'done'));
        out.push(new SubagentTreeItem(el.parentSession, el.transcriptPath, s, grandchildren));
      }
      if (el.subagent.currentTool) {
        const preview = el.subagent.currentToolInput ? ` "${el.subagent.currentToolInput}"` : '';
        const item = new vscode.TreeItem(
          `${el.subagent.currentTool}${preview}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('tools');
        item.contextValue = 'subagentDetail';
        out.push(item);
      }
      if (el.subagent.lastMessage) {
        const item = new vscode.TreeItem(
          `"${el.subagent.lastMessage}"`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('hubot');
        item.contextValue = 'subagentDetail';
        out.push(item);
      }
      return out;
    }
    return [];
  }

  async handleDrag(
    source: readonly vscode.TreeItem[],
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const sessionItems = source.filter(
      (i): i is SessionTreeItem => i instanceof SessionTreeItem,
    );
    if (sessionItems.length === 0) return;
    const payload = sessionItems.map(i => ({
      hash: i.session.workspaceHash,
      name: i.session.name,
    }));
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(payload));
  }

  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) return;
    const raw = item.value as Array<{ hash: string; name: string }>;
    if (!Array.isArray(raw) || raw.length === 0) return;

    const targetHash = target instanceof SessionTreeItem
      ? target.session.workspaceHash
      : (target instanceof WorkspaceTreeItem ? target.workspaceHash : undefined);
    if (!targetHash) return;
    if (raw.some(r => r.hash !== targetHash)) {
      vscode.window.showInformationMessage(
        'Terminal Sessions: cross-workspace reorder is not supported.',
      );
      return;
    }

    const cfg = getConfig();
    const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) return;
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, this.index);
    const group = sortSessions(
      all.filter(s => s.workspaceHash === targetHash),
      cfg.sidebarSortMode,
    );

    const dragNames = new Set(raw.map(r => r.name));
    const dragged = group.filter(s => dragNames.has(s.name));
    const rest = group.filter(s => !dragNames.has(s.name));

    let insertIdx = rest.length;
    if (target instanceof SessionTreeItem && !dragNames.has(target.session.name)) {
      const targetIdxInGroup = group.findIndex(s => s.name === target.session.name);
      const firstDraggedIdxInGroup = group.findIndex(s => dragNames.has(s.name));
      const draggingDown =
        firstDraggedIdxInGroup >= 0 && firstDraggedIdxInGroup < targetIdxInGroup;
      const targetIdxInRest = rest.findIndex(s => s.name === target.session.name);
      if (targetIdxInRest < 0) insertIdx = rest.length;
      else insertIdx = draggingDown ? targetIdxInRest + 1 : targetIdxInRest;
    }
    const reordered = [...rest.slice(0, insertIdx), ...dragged, ...rest.slice(insertIdx)];

    reordered.forEach((s, i) => {
      this.index.setSessionSortOrder(s.workspaceHash, s.name, i);
    });

    if (cfg.sidebarSortMode !== 'custom') {
      await setSortMode('custom');
      vscode.window.setStatusBarMessage(
        'Terminal Sessions: switched sort mode to Custom',
        2500,
      );
    }
    this.refresh();
  }
}

let provider: SessionsTreeProvider | undefined;

export function registerSidebar(
  ctx: vscode.ExtensionContext,
  index: SessionIndex,
  claude: ClaudeTracker,
): void {
  provider = new SessionsTreeProvider(index, claude);
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  ctx.subscriptions.push(treeView);
  treeViewRef = treeView;

  // Activity-bar badge: surfaces Claude sessions that need user attention
  // (waiting = Claude paused for approval; working = actively generating).
  // Waiting is more urgent, so we show waiting count first; if none, show
  // working count; if neither, remove the badge.
  const updateBadge = (): void => {
    let waiting = 0;
    let working = 0;
    for (const ws of Object.values(index.getAllWorkspaces())) {
      for (const name of Object.keys(ws.sessions)) {
        const snap = claude.getSnapshot(name);
        if (!snap) continue;
        if (snap.state === 'waiting') waiting++;
        else if (snap.state === 'working' || snap.state === 'tool') working++;
      }
    }
    if (waiting > 0) {
      treeView.badge = {
        value: waiting,
        tooltip: `${waiting} Claude session${waiting === 1 ? '' : 's'} waiting for you`,
      };
    } else if (working > 0) {
      treeView.badge = {
        value: working,
        tooltip: `${working} Claude session${working === 1 ? '' : 's'} working`,
      };
    } else {
      treeView.badge = undefined;
    }
  };

  ctx.subscriptions.push(claude.onChange(() => {
    provider?.refresh();
    updateBadge();
  }));
  const interval = setInterval(() => {
    provider?.refresh();
    updateBadge();
  }, 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(interval) });
  updateBadge();
}

export function refreshSidebar(): void { provider?.refresh(); }

let treeViewRef: vscode.TreeView<vscode.TreeItem> | undefined;

/** Select and scroll to a session in the sidebar by tmux session name. */
export async function revealSessionInSidebar(sessionName: string): Promise<void> {
  if (!provider || !treeViewRef) return;
  // Ensure the tree has been rendered at least once for this element.
  let item = provider.getLastSessionItem(sessionName);
  if (!item) {
    // Force a render by asking for roots, then re-check.
    await provider.getChildren();
    const roots = await provider.getChildren();
    for (const r of roots) {
      // Expand each workspace child to populate session map.
      // getChildren(workspaceItem) renders its sessions.
      // eslint-disable-next-line no-await-in-loop
      await provider.getChildren(r);
    }
    item = provider.getLastSessionItem(sessionName);
  }
  if (!item) return;
  try {
    await treeViewRef.reveal(item, { select: true, focus: false, expand: false });
  } catch { /* reveal can throw if the item is stale — ignore */ }
}
