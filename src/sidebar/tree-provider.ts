import * as vscode from 'vscode';
import { SessionIndex, enrichSessions, groupByWorkspace } from '../session-manager';
import * as tmux from '../tmux';
import { getConfig, setSortMode, VIEW_ID, SidebarSortMode, STOPPED_URI_SCHEME } from '../config';
import { WorkspaceTreeItem, GroupTreeItem, SessionTreeItem, SubagentTreeItem, SubagentsFolderItem, buildClaudeDetails } from './items';
import { SessionInfo } from '../types';
import { ClaudeTracker } from '../claude-tracker';

const DRAG_MIME = 'application/vnd.code.tree.terminalsessions';

class StoppedSessionDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== STOPPED_URI_SCHEME) return undefined;
    return {
      color: new vscode.ThemeColor('disabledForeground'),
      tooltip: 'Stopped',
    };
  }
}

export function sortSessions(group: SessionInfo[], mode: SidebarSortMode): SessionInfo[] {
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

  /**
   * Render the children of a container (workspace root when parentGroupId is
   * undefined, otherwise a master group). Produces, in the user's sort order:
   *   - child masters and normal groups whose parentGroupId === parentGroupId
   *   - (root only) ungrouped sessions
   * Masters never list sessions directly. Under an active running/stopped
   * filter, groups/masters with no visible sessions anywhere beneath them are
   * hidden so the tree doesn't show empty folders.
   */
  private renderContainer(
    hash: string,
    parentGroupId: string | undefined,
    allWsSessions: SessionInfo[],
    cfg: ReturnType<typeof getConfig>,
  ): vscode.TreeItem[] {
    const groups = this.index.getGroups(hash);
    const wantStopped = cfg.sidebarFilterMode === 'stopped';
    const wantRunning = cfg.sidebarFilterMode === 'running';
    const passFilter = (s: SessionInfo): boolean =>
      wantStopped ? !!s.stopped : wantRunning ? !s.stopped : true;

    // All filtered sessions beneath a group/master (recursive through masters).
    const sessionsUnder = (gid: string): SessionInfo[] => {
      const g = groups[gid];
      if (!g) return [];
      if (g.kind === 'master') {
        const out: SessionInfo[] = [];
        for (const [cid, cg] of Object.entries(groups)) {
          if (cg.parentGroupId === gid) out.push(...sessionsUnder(cid));
        }
        return out;
      }
      return allWsSessions.filter(s => s.groupId === gid).filter(passFilter);
    };

    interface ContainerRow { sortOrder: number; name: string; build: () => vscode.TreeItem }
    const containerRows: ContainerRow[] = [];
    for (const [gid, g] of Object.entries(groups)) {
      if ((g.parentGroupId ?? undefined) !== parentGroupId) continue;
      const isMaster = g.kind === 'master';
      const visibleSessions = sessionsUnder(gid);
      if (cfg.sidebarFilterMode !== 'all' && visibleSessions.length === 0) continue;
      const childCount = isMaster
        ? Object.values(groups).filter(cg => cg.parentGroupId === gid).length
        : 0;
      containerRows.push({
        sortOrder: g.sortOrder ?? Number.MAX_SAFE_INTEGER,
        name: g.name.toLowerCase(),
        build: () => new GroupTreeItem(
          hash,
          gid,
          g.name,
          isMaster ? 'master' : 'group',
          isMaster ? visibleSessions : sortSessions(visibleSessions, cfg.sidebarSortMode),
          childCount,
        ),
      });
    }

    // Ungrouped sessions live only at the workspace root, never inside a master.
    const groupIds = new Set(Object.keys(groups));
    const ungrouped = parentGroupId === undefined
      ? allWsSessions.filter(s => (!s.groupId || !groupIds.has(s.groupId)) && passFilter(s))
      : [];

    const buildSession = (s: SessionInfo): vscode.TreeItem => {
      const item = new SessionTreeItem(
        s, this.claude.getSnapshot(s.name), cfg.claudeSidebarDetails, cfg.contextWarnPct,
      );
      this.lastSessionItems.set(s.name, item);
      return item;
    };

    if (cfg.sidebarSortMode === 'custom') {
      // Containers and root sessions interleave by their shared sortOrder.
      interface Row { sortOrder: number; secondaryKey: number | string; build: () => vscode.TreeItem }
      const rows: Row[] = [
        ...containerRows.map(r => ({ sortOrder: r.sortOrder, secondaryKey: r.name, build: r.build })),
        ...ungrouped.map(s => ({
          sortOrder: s.sortOrder ?? Number.MAX_SAFE_INTEGER,
          secondaryKey: s.tabId,
          build: () => buildSession(s),
        })),
      ];
      rows.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (typeof a.secondaryKey === 'number' && typeof b.secondaryKey === 'number') {
          return a.secondaryKey - b.secondaryKey;
        }
        return String(a.secondaryKey).localeCompare(String(b.secondaryKey));
      });
      return rows.map(r => r.build());
    }

    // Non-custom modes: containers first (by sortOrder then name), then
    // ungrouped sessions ordered by the active mode (MRU / alphabetical / …).
    containerRows.sort((a, b) =>
      a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name));
    const sortedUngrouped = sortSessions(ungrouped, cfg.sidebarSortMode);
    return [
      ...containerRows.map(r => r.build()),
      ...sortedUngrouped.map(buildSession),
    ];
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
    let filtered = sessions;
    if (cfg.sidebarFilterMode === 'running') filtered = sessions.filter(s => !s.stopped);
    else if (cfg.sidebarFilterMode === 'stopped') filtered = sessions.filter(s => s.stopped);

    if (!el) {
      if (filtered.length === 0) {
        this.lastWorkspaceItems.clear();
        this.lastSessionItems.clear();
        if (sessions.length > 0) {
          // Filter-induced empty state — distinguish from truly-empty
          const label = cfg.sidebarFilterMode === 'stopped'
            ? 'No stopped sessions.'
            : 'No running sessions.';
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.description = `${sessions.length} hidden by filter`;
          item.iconPath = new vscode.ThemeIcon('filter');
          return [item];
        }
        const item = new vscode.TreeItem('No persistent sessions yet.',
          vscode.TreeItemCollapsibleState.None);
        item.description = 'Click + to create one';
        return [item];
      }
      const grouped = groupByWorkspace(filtered);
      const allByWorkspace = groupByWorkspace(sessions);
      const out: vscode.TreeItem[] = [];
      this.lastWorkspaceItems.clear();
      for (const [hash, group] of grouped) {
        const ordered = sortSessions(group, cfg.sidebarSortMode);
        const wsPath = ordered[0].workspacePath;
        const wsItem = new WorkspaceTreeItem(
          ordered[0].workspaceLabel,
          hash,
          ordered,
          wsPath,
          allByWorkspace.get(hash) ?? ordered,
        );
        this.lastWorkspaceItems.set(hash, wsItem);
        out.push(wsItem);
      }
      return out;
    }
    if (el instanceof WorkspaceTreeItem) {
      // Root container: top-level masters + top-level normal groups + ungrouped
      // sessions, all sharing one sortOrder pool (interleaved via drag-drop).
      const allWsSessions = sessions.filter(s => s.workspaceHash === el.workspaceHash);
      return this.renderContainer(el.workspaceHash, undefined, allWsSessions, cfg);
    }
    if (el instanceof GroupTreeItem) {
      const allWsSessions = sessions.filter(s => s.workspaceHash === el.workspaceHash);
      if (el.kind === 'master') {
        // Master container: its child masters + child normal groups. No
        // sessions appear directly under a master.
        return this.renderContainer(el.workspaceHash, el.groupId, allWsSessions, cfg);
      }
      // Normal group: only its sessions, in current sidebar sort order.
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
      const children: vscode.TreeItem[] = buildClaudeDetails(snap, cfg.contextWarnPct);
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
    interface DragSession { kind: 'session'; hash: string; name: string }
    interface DragGroup { kind: 'group'; hash: string; groupId: string }
    type Payload = DragSession | DragGroup;
    const payload: Payload[] = [];
    for (const i of source) {
      if (i instanceof SessionTreeItem) {
        payload.push({ kind: 'session', hash: i.session.workspaceHash, name: i.session.name });
      } else if (i instanceof GroupTreeItem) {
        payload.push({ kind: 'group', hash: i.workspaceHash, groupId: i.groupId });
      }
    }
    if (payload.length === 0) return;
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(payload));
  }

  /**
   * Drop semantics:
   *   - Session dropped on a GroupTreeItem → moved INTO that group (appended).
   *   - Session dropped on a SessionTreeItem inside a group → moved into that
   *     group AND reordered relative to the target session.
   *   - Session dropped on a root-level SessionTreeItem → cleared groupId,
   *     reordered at root relative to the target.
   *   - Session dropped on a WorkspaceTreeItem → moved to root, appended.
   *   - Group dropped on another GroupTreeItem → reordered at root (groups
   *     always live at root; cross-parent moves don't apply to groups).
   *   - Group dropped on a root-level SessionTreeItem → reordered at root
   *     relative to the target session.
   *   - Cross-workspace drops are refused (groups/sessions are workspace-scoped).
   */
  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) return;
    interface DragSession { kind: 'session'; hash: string; name: string }
    interface DragGroup { kind: 'group'; hash: string; groupId: string }
    type Payload = DragSession | DragGroup;
    const raw = item.value as Payload[];
    if (!Array.isArray(raw) || raw.length === 0) return;

    const targetHash = target instanceof SessionTreeItem
      ? target.session.workspaceHash
      : target instanceof GroupTreeItem
        ? target.workspaceHash
        : target instanceof WorkspaceTreeItem
          ? target.workspaceHash
          : undefined;
    if (!targetHash) return;
    if (raw.some(r => r.hash !== targetHash)) {
      vscode.window.showInformationMessage(
        'Terminal Sessions: cross-workspace drag-drop is not supported.',
      );
      return;
    }

    const cfg = getConfig();
    const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) return;

    const sessions = raw.filter((r): r is DragSession => r.kind === 'session');
    const groups = raw.filter((r): r is DragGroup => r.kind === 'group');
    const draggingGroups = groups.length > 0;
    const indexGroups = this.index.getGroups(targetHash);
    const targetGroupMeta = target instanceof GroupTreeItem ? indexGroups[target.groupId] : undefined;

    // ── Resolve where the dragged items land ──────────────────────────────
    // `reorderContainer` = the container whose child list we reorder within
    //   (undefined = workspace root; a master id = that master's interior;
    //    a normal-group id = its session list).
    // `sessionDestGroupId` = the normal group (or root) dragged sessions join.
    // `groupDestParent`    = the master (or root) dragged groups/masters join.
    let sessionDestGroupId: string | undefined;
    let groupDestParent: string | undefined;
    let rejectSessions = false;

    if (target instanceof GroupTreeItem) {
      if (targetGroupMeta?.kind === 'master') {
        // Drop INTO the master: groups become its children; sessions can't.
        groupDestParent = target.groupId;
        rejectSessions = true;
      } else {
        // Drop on a normal group: sessions go INSIDE it; groups become its
        // siblings (same parent as the target group).
        sessionDestGroupId = target.groupId;
        groupDestParent = targetGroupMeta?.parentGroupId;
      }
    } else if (target instanceof SessionTreeItem) {
      const sGid = target.session.groupId;
      const sParent = sGid ? indexGroups[sGid]?.parentGroupId : undefined;
      sessionDestGroupId = sGid;          // join the target session's group (or root)
      groupDestParent = sGid ? sParent : undefined; // groups become siblings of that group
    } else {
      // WorkspaceTreeItem or empty space → root
      sessionDestGroupId = undefined;
      groupDestParent = undefined;
    }

    // ── Apply parent/group changes ────────────────────────────────────────
    if (draggingGroups) {
      // Masters hold only groups; re-parent each dragged group/master.
      // setGroupParent rejects cycles + non-master parents, returning false.
      let anyRejected = false;
      for (const g of groups) {
        const ok = this.index.setGroupParent(targetHash, g.groupId, groupDestParent);
        if (!ok && groupDestParent !== undefined) anyRejected = true;
      }
      if (anyRejected) {
        vscode.window.showInformationMessage(
          'Terminal Sessions: can\'t move a master group inside itself or its own descendant.',
        );
      }
    } else {
      if (rejectSessions) {
        vscode.window.showInformationMessage(
          'Terminal Sessions: master groups hold only groups, not sessions. Drop the session on a normal group or the workspace root.',
        );
        return;
      }
      for (const s of sessions) {
        this.index.setSessionGroup(targetHash, s.name, sessionDestGroupId);
      }
    }

    // ── Reorder within the destination container ──────────────────────────
    const reorderContainer = draggingGroups ? groupDestParent : sessionDestGroupId;
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, this.index);
    const wsSessions = all.filter(s => s.workspaceHash === targetHash);
    const freshGroups = this.index.getGroups(targetHash);

    interface Child {
      key: string;
      isGroup: boolean;
      sortOrder: number;
      session?: SessionInfo;
      groupId?: string;
    }
    // The reorder container can be: root (undefined), a master (child
    // groups/masters), or a normal group (its sessions).
    const buildChildList = (containerId: string | undefined): Child[] => {
      const list: Child[] = [];
      const containerKind = containerId ? freshGroups[containerId]?.kind : undefined;
      if (containerId !== undefined && containerKind !== 'master') {
        // Normal group container → its sessions.
        for (const s of wsSessions) {
          if (s.groupId !== containerId) continue;
          list.push({ key: `s:${s.name}`, isGroup: false, sortOrder: s.sortOrder ?? Number.MAX_SAFE_INTEGER, session: s });
        }
      } else {
        // Root or master container → child groups/masters.
        for (const [gid, g] of Object.entries(freshGroups)) {
          if ((g.parentGroupId ?? undefined) !== containerId) continue;
          list.push({ key: `g:${gid}`, isGroup: true, sortOrder: g.sortOrder ?? Number.MAX_SAFE_INTEGER, groupId: gid });
        }
        // Root also holds ungrouped sessions.
        if (containerId === undefined) {
          for (const s of wsSessions) {
            if (s.groupId && freshGroups[s.groupId]) continue;
            list.push({ key: `s:${s.name}`, isGroup: false, sortOrder: s.sortOrder ?? Number.MAX_SAFE_INTEGER, session: s });
          }
        }
      }
      list.sort((a, b) => a.sortOrder - b.sortOrder);
      return list;
    };

    const destChildren = buildChildList(reorderContainer);
    const draggedKeys = new Set<string>([
      ...sessions.map(s => `s:${s.name}`),
      ...groups.map(g => `g:${g.groupId}`),
    ]);

    const draggedChildren = destChildren.filter(c => draggedKeys.has(c.key));
    const rest = destChildren.filter(c => !draggedKeys.has(c.key));

    let insertIdx = rest.length;
    let targetKey: string | undefined;
    if (target instanceof SessionTreeItem) targetKey = `s:${target.session.name}`;
    else if (target instanceof GroupTreeItem) targetKey = `g:${target.groupId}`;
    // When dropping INTO a master, targetKey (the master) isn't a child of the
    // reorder container, so it won't be found below → dragged items append.
    if (targetKey && !draggedKeys.has(targetKey)) {
      const tIdxFull = destChildren.findIndex(c => c.key === targetKey);
      const firstDraggedIdxFull = destChildren.findIndex(c => draggedKeys.has(c.key));
      const draggingDown = firstDraggedIdxFull >= 0 && firstDraggedIdxFull < tIdxFull;
      const tIdxRest = rest.findIndex(c => c.key === targetKey);
      if (tIdxRest >= 0) insertIdx = draggingDown ? tIdxRest + 1 : tIdxRest;
    }

    // Re-collect the dragged children IN THE ORDER they appear in raw, so a
    // multi-select drag preserves the user's pick order.
    const draggedInOrder: Child[] = [];
    for (const r of raw) {
      const k = r.kind === 'session' ? `s:${r.name}` : `g:${r.groupId}`;
      const c = draggedChildren.find(x => x.key === k);
      if (c) draggedInOrder.push(c);
    }
    const reordered = [...rest.slice(0, insertIdx), ...draggedInOrder, ...rest.slice(insertIdx)];

    // Persist new sortOrder: integers 0..N-1 within the destination container.
    reordered.forEach((c, i) => {
      if (c.isGroup && c.groupId) {
        this.index.setGroupSortOrder(targetHash, c.groupId, i);
      } else if (c.session) {
        this.index.setSessionSortOrder(targetHash, c.session.name, i);
      }
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
  // Disable the built-in Collapse All — it folds the workspace folders too,
  // which hides every session. We expose a custom "Collapse Sessions" that
  // folds session detail rows (Claude inline detail + Agents folder) and
  // re-expands the workspace folder so the session list stays visible.
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    dragAndDropController: provider,
  });
  ctx.subscriptions.push(treeView);
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new StoppedSessionDecorationProvider()),
  );
  treeViewRef = treeView;
  updateTreeViewDescription();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('terminalSessions.sidebarFilterMode')) {
        updateTreeViewDescription();
        provider?.refresh();
      }
    }),
  );

  // Activity-bar badge: surfaces agent sessions that need user attention
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
        tooltip: `${waiting} agent session${waiting === 1 ? '' : 's'} waiting for you`,
      };
    } else if (working > 0) {
      treeView.badge = {
        value: working,
        tooltip: `${working} agent session${working === 1 ? '' : 's'} working`,
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

function updateTreeViewDescription(): void {
  if (!treeViewRef) return;
  const cfg = getConfig();
  if (cfg.sidebarFilterMode === 'running') treeViewRef.description = 'Running only';
  else if (cfg.sidebarFilterMode === 'stopped') treeViewRef.description = 'Stopped only';
  else treeViewRef.description = undefined;
}

/**
 * Collapse session detail rows (Claude detail children, Agents folder) while
 * keeping the workspace folders expanded. Strategy: trigger VS Code's built-in
 * collapse-all command (which folds everything), then programmatically reveal
 * each workspace item with expand:1 so only the top level re-opens. The
 * sessions and their detail rows stay collapsed because they're children of
 * the workspace and `expand:1` only opens the workspace itself.
 */
export async function collapseAllSessions(): Promise<void> {
  if (!treeViewRef || !provider) return;
  try {
    await vscode.commands.executeCommand(
      `workbench.actions.treeView.${VIEW_ID}.collapseAll`,
    );
  } catch { /* fallback below still works if the built-in id changes */ }
  const roots = await provider.getChildren();
  for (const root of roots) {
    if (root instanceof WorkspaceTreeItem) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await treeViewRef.reveal(root, { expand: 1, focus: false, select: false });
      } catch { /* reveal can throw if the item is stale — ignore */ }
    }
  }
}
