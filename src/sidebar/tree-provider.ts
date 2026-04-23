import * as vscode from 'vscode';
import { SessionIndex, enrichSessions, groupByWorkspace } from '../session-manager';
import * as tmux from '../tmux';
import { getConfig, setSortMode, VIEW_ID, SidebarSortMode } from '../config';
import { WorkspaceTreeItem, SessionTreeItem, buildClaudeDetails } from './items';
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

  constructor(
    private index: SessionIndex,
    private claude: ClaudeTracker,
  ) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

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
        const item = new vscode.TreeItem('No persistent sessions yet.',
          vscode.TreeItemCollapsibleState.None);
        item.description = 'Click + to create one';
        return [item];
      }
      const grouped = groupByWorkspace(sessions);
      const out: vscode.TreeItem[] = [];
      for (const [hash, group] of grouped) {
        const ordered = sortSessions(group, cfg.sidebarSortMode);
        const wsPath = ordered[0].workspacePath;
        out.push(new WorkspaceTreeItem(ordered[0].workspaceLabel, hash, ordered, wsPath));
      }
      return out;
    }
    if (el instanceof WorkspaceTreeItem) {
      return el.sessions.map(s => new SessionTreeItem(
        s,
        this.claude.getSnapshot(s.name),
        cfg.claudeSidebarDetails,
        cfg.contextWarnPct,
      ));
    }
    if (el instanceof SessionTreeItem) {
      const snap = el.claude;
      if (!snap) return [];
      return buildClaudeDetails(snap);
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
  ctx.subscriptions.push(claude.onChange(() => provider?.refresh()));
  const interval = setInterval(() => provider?.refresh(), 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function refreshSidebar(): void { provider?.refresh(); }
