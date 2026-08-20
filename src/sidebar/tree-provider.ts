import * as vscode from 'vscode';
import { SessionIndex, enrichSessions, groupByWorkspace } from '../session-manager';
import * as tmux from '../tmux';
import { getConfig, setSortMode, VIEW_ID, SidebarSortMode, STOPPED_URI_SCHEME, BRANCH_URI_SCHEME } from '../config';
import { WorkspaceTreeItem, GroupTreeItem, BranchClusterItem, SessionTreeItem, SubagentTreeItem, SubagentsFolderItem, FavoritesFolderItem, OpenFolderItem, ActivityFolderItem, KilledFolderItem, KilledSessionItem, buildClaudeDetails } from './items';
import { sessionNameForTerminal, resolveTmuxNameForTerminalLive } from '../profile-provider';
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

/** Paints the ⑂ chip on fork branch-set members. Stateless: the chip color id
 *  and set name ride in the resourceUri query (built in items.ts), so no index
 *  lookup is needed. The chip appears/disappears purely by the row's resourceUri
 *  changing on tree refresh — same mechanism as the stopped decoration. */
class BranchSetDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== BRANCH_URI_SCHEME) return undefined;
    const params = new URLSearchParams(uri.query);
    const colorId = params.get('c') || undefined;
    const name = params.get('n') || 'branch';
    return {
      badge: '⑂',
      color: colorId ? new vscode.ThemeColor(colorId) : undefined,
      tooltip: `Branch: ${name}`,
    };
  }
}

/** Sessions Activity ordering: running first (most recently active on top),
 *  then stopped ones by stop recency. stoppedAt is stamped by Stop since
 *  0.20.29; older entries fall back to lastActiveAt, then createdAt. Pure. */
export function activityOrder(list: readonly SessionInfo[]): SessionInfo[] {
  const key = (s: SessionInfo): number =>
    (s.stopped ? (s.stoppedAt ?? s.lastActiveAt ?? s.createdAt) : (s.lastActiveAt ?? s.lastAttached)).getTime();
  const running = list.filter(s => !s.stopped).sort((a, b) => key(b) - key(a));
  const stopped = list.filter(s => s.stopped).sort((a, b) => key(b) - key(a));
  return [...running, ...stopped];
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
  // Group/master items by `${workspaceHash}::${groupId}`, so getParent() can
  // return the actual container instances that sit between a session and its
  // workspace — the chain treeView.reveal() must expand.
  private lastGroupItems = new Map<string, GroupTreeItem>();
  // Fork-cluster items by `${workspaceHash}::${branchSetId}`, so getParent() can
  // return the exact virtual container reveal() must expand for a clustered row.
  private lastClusterItems = new Map<string, BranchClusterItem>();
  // User-driven expansion state, tracked via the tree view's expand/collapse
  // events, so the tab-focus highlight can tell whether a session is already
  // on-screen. Workspaces render Expanded by default (recorded here only when
  // the user folds one); groups/masters render Collapsed by default (recorded
  // only when the user opens one).
  private collapsedWorkspaceIds = new Set<string>();
  private expandedContainerIds = new Set<string>();
  // Fork clusters render Expanded by default (active parallel work), so — unlike
  // groups — we record only the ones the user has COLLAPSED, mirroring workspaces.
  private collapsedClusterIds = new Set<string>();

  // One enrichSessions() (a tmux subprocess) per refresh pass, shared across the
  // root + every expanded container's getChildren call. VS Code fans getChildren
  // out across all visible levels on a single refresh; without this each level
  // spawned its own `tmux list-sessions`. Bumped by refresh() so the next pass
  // re-enriches.
  private refreshGen = 0;
  private enrichGen = -1;
  private enrichPromise: Promise<SessionInfo[]> | undefined;

  constructor(
    private index: SessionIndex,
    private claude: ClaudeTracker,
  ) {}

  refresh(): void {
    this.refreshGen++;
    this._onDidChange.fire(undefined);
  }

  /** The live session list for the current refresh pass, computed once and reused
   *  across every getChildren level. Caches the promise (not the value) so
   *  concurrent child calls in the same pass don't each spawn tmux. */
  private sessionsForThisPass(tmuxPath: string, prefix: string): Promise<SessionInfo[]> {
    if (this.enrichGen !== this.refreshGen || !this.enrichPromise) {
      this.enrichGen = this.refreshGen;
      this.enrichPromise = enrichSessions(tmuxPath, prefix, this.index);
    }
    return this.enrichPromise;
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  /** Required for treeView.reveal() to expand + scroll to nested items. Returns
   *  the FULL ancestor chain (session → group → master… → workspace), one hop
   *  per call, so VS Code knows every container it must expand. A session in a
   *  group returns that group; a group nested in a master returns the master;
   *  the top-most container returns the workspace. Falls back to the workspace
   *  when the session is ungrouped (or its group is stale), matching how the
   *  tree renders it. */
  getParent(el: vscode.TreeItem): vscode.TreeItem | undefined {
    if (el instanceof SessionTreeItem) {
      // A clustered session's immediate parent is its fork cluster (present only
      // when the cluster actually rendered, i.e. ≥2 members shared this container).
      const setId = el.session.branchSetId;
      if (setId) {
        const c = this.lastClusterItems.get(`${el.session.workspaceHash}::${setId}`);
        if (c) return c;
      }
      const gid = el.session.groupId;
      if (gid) {
        const g = this.lastGroupItems.get(`${el.session.workspaceHash}::${gid}`);
        if (g) return g;
      }
      return this.lastWorkspaceItems.get(el.session.workspaceHash);
    }
    if (el instanceof BranchClusterItem) {
      // The cluster sits in the container its members share (a group) or at root.
      if (el.groupId) {
        const g = this.lastGroupItems.get(`${el.workspaceHash}::${el.groupId}`);
        if (g) return g;
      }
      return this.lastWorkspaceItems.get(el.workspaceHash);
    }
    if (el instanceof GroupTreeItem) {
      const parentId = this.index.getGroups(el.workspaceHash)[el.groupId]?.parentGroupId;
      if (parentId) {
        const pg = this.lastGroupItems.get(`${el.workspaceHash}::${parentId}`);
        if (pg) return pg;
      }
      return this.lastWorkspaceItems.get(el.workspaceHash);
    }
    return undefined;
  }

  getLastSessionItem(name: string): SessionTreeItem | undefined {
    return this.lastSessionItems.get(name);
  }

  /** Record a container's open/closed state from the tree view's
   *  expand/collapse events (see registerSidebar). */
  noteExpanded(el: vscode.TreeItem, expanded: boolean): void {
    const id = el.id;
    if (!id) return;
    if (el instanceof WorkspaceTreeItem) {
      if (expanded) this.collapsedWorkspaceIds.delete(id);
      else this.collapsedWorkspaceIds.add(id);
    } else if (el instanceof GroupTreeItem) {
      if (expanded) this.expandedContainerIds.add(id);
      else this.expandedContainerIds.delete(id);
    } else if (el instanceof BranchClusterItem) {
      // Default-expanded, so we record the inverse: only clusters the user closed.
      if (expanded) this.collapsedClusterIds.delete(id);
      else this.collapsedClusterIds.add(id);
    }
  }

  /** True when every ancestor container of the session is currently open, so
   *  its row is already on-screen and needs no scroll/expand to be seen. Used
   *  by the tab-focus highlight, which must never expand a hidden branch. */
  isSessionVisible(session: SessionInfo): boolean {
    if (this.collapsedWorkspaceIds.has(`ws:${session.workspaceHash}`)) return false;
    // A session in a collapsed fork cluster is off-screen even if its group chain
    // is open. (When no cluster rendered, the id simply isn't in the set.)
    if (session.branchSetId
      && this.collapsedClusterIds.has(`clu:${session.workspaceHash}:${session.branchSetId}`)) return false;
    const groups = this.index.getGroups(session.workspaceHash);
    let gid = session.groupId;
    let guard = 0;
    while (gid && guard++ < 100) {
      const g = groups[gid];
      if (!g) break; // stale groupId → session renders ungrouped under the workspace
      if (!this.expandedContainerIds.has(`grp:${session.workspaceHash}:${gid}`)) return false;
      gid = g.parentGroupId;
    }
    return true;
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
  /** Build a session row, caching it for reveal(). `inCluster` suppresses the ⑂
   *  chip on rows rendered inside a fork cluster (the header carries it). */
  private makeSessionItem(
    s: SessionInfo,
    cfg: ReturnType<typeof getConfig>,
    inCluster = false,
    cache = true,
  ): SessionTreeItem {
    const item = new SessionTreeItem(
      s, this.claude.getSnapshot(s.name), cfg.claudeSidebarDetails, cfg.contextWarnPct, inCluster,
    );
    // Mirror rows (Sessions Activity) skip the cache: reveal/getParent must
    // keep resolving to the canonical row inside its group.
    if (cache) this.lastSessionItems.set(s.name, item);
    return item;
  }

  /** The pinned virtual folders at the top of a workspace: Favorites (starred
   *  sessions), Open (terminal tabs in this window), Sessions Activity (flat
   *  recency list) and Sessions Killed (graveyard). Each is gated by its
   *  setting; all but Activity also hide while empty. */
  /** Terminal → tmux-name results from the PID walk, keyed by terminal object
   *  (a reattach disposes the old terminal, so entries die with their tab).
   *  Successes are permanent for that object; misses are retried at most every
   *  15s — the sidebar refreshes often and a `ps` walk per ghost tab per
   *  refresh would add up, but a tmux client can also appear a moment after a
   *  reload while the pty host reconnects. */
  private openNameCache = new WeakMap<vscode.Terminal, { name?: string; at: number }>();

  private async resolveOpenName(t: vscode.Terminal): Promise<string | undefined> {
    const hit = this.openNameCache.get(t);
    if (hit && (hit.name !== undefined || Date.now() - hit.at < 15_000)) return hit.name;
    const cfg = getConfig();
    let name: string | undefined;
    try { name = await resolveTmuxNameForTerminalLive(t, this.index, cfg.sessionPrefix); }
    catch { name = undefined; }
    this.openNameCache.set(t, { name, at: Date.now() });
    return name;
  }

  private async specialFolders(
    hash: string,
    allWsSessions: SessionInfo[],
    cfg: ReturnType<typeof getConfig>,
  ): Promise<vscode.TreeItem[]> {
    const out: vscode.TreeItem[] = [];
    if (cfg.showFavoritesFolder) {
      const favs = activityOrder(allWsSessions.filter(s => s.favorite));
      if (favs.length > 0) out.push(new FavoritesFolderItem(hash, favs));
    }
    if (cfg.showOpenFolder) {
      // Sessions with a terminal tab open in THIS window, in panel order.
      const pos = new Map<string, number>();
      for (const t of vscode.window.terminals) {
        if (t.exitStatus) continue;
        // Cheap sync mapping first (shellArgs of tabs we created). Tabs
        // restored by a window reload lose their creationOptions, so they
        // fall back to the PID walk (tmux client is still alive under the
        // pty host) — cached per terminal object, see resolveOpenName.
        // eslint-disable-next-line no-await-in-loop
        const n = sessionNameForTerminal(t) ?? await this.resolveOpenName(t);
        if (n && !pos.has(n)) pos.set(n, pos.size);
      }
      const open = allWsSessions
        .filter(s => pos.has(s.name))
        .sort((a, b) => (pos.get(a.name)! - pos.get(b.name)!));
      if (open.length > 0) out.push(new OpenFolderItem(hash, open));
    }
    if (cfg.showActivityFolder) {
      const list = activityOrder(allWsSessions).slice(0, Math.max(1, cfg.activityLimit));
      out.push(new ActivityFolderItem(hash, list));
    }
    if (cfg.showKilledFolder) {
      const entries = this.index.getKilled(hash).slice(0, Math.max(1, cfg.killedLimit));
      if (entries.length > 0) out.push(new KilledFolderItem(hash, entries));
    }
    return out;
  }

  /** Fold branch-set members within one container's ordered rows into fork
   *  clusters. A set with ≥2 members present here collapses to a single
   *  BranchClusterItem at its first member's position; the rest are absorbed.
   *  Sets with <2 members here (lone/filtered) fall through as plain rows (which
   *  keep their ⑂ chip). Container rows (no `session`) pass through untouched. */
  private foldRows(
    hash: string,
    rows: Array<{ session?: SessionInfo; build: () => vscode.TreeItem }>,
    _cfg: ReturnType<typeof getConfig>,
  ): vscode.TreeItem[] {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const id = r.session?.branchSetId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const out: vscode.TreeItem[] = [];
    const emitted = new Set<string>();
    for (const r of rows) {
      const id = r.session?.branchSetId;
      if (id && (counts.get(id) ?? 0) >= 2) {
        if (emitted.has(id)) continue; // absorbed into the cluster emitted below
        emitted.add(id);
        const members = rows
          .map(x => x.session)
          .filter((s): s is SessionInfo => !!s && s.branchSetId === id);
        out.push(this.buildCluster(hash, id, members));
      } else {
        out.push(r.build());
      }
    }
    return out;
  }

  private buildCluster(hash: string, setId: string, members: SessionInfo[]): BranchClusterItem {
    const first = members[0];
    const baseLabel = first.branchBaseLabel
      || first.branchName?.replace(/\s*⑂\s*$/, '')
      || 'fork';
    const item = new BranchClusterItem(hash, setId, members, baseLabel, first.branchColorId, first.groupId);
    this.lastClusterItems.set(`${hash}::${setId}`, item);
    return item;
  }

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
        build: () => {
          const item = new GroupTreeItem(
            hash,
            gid,
            g.name,
            isMaster ? 'master' : 'group',
            isMaster ? visibleSessions : sortSessions(visibleSessions, cfg.sidebarSortMode),
            childCount,
            g.color,
          );
          // Cache so getParent() can hand reveal() this exact container.
          this.lastGroupItems.set(`${hash}::${gid}`, item);
          return item;
        },
      });
    }

    // Ungrouped sessions live only at the workspace root, never inside a master.
    // A groupId pointing at a MASTER is treated as orphaned too: masters list only
    // child groups (sessionsUnder recurses into groups, never sessions), so such a
    // session would otherwise render nowhere and vanish from the sidebar. Falling
    // it back to root keeps it reachable even if a stale index already has one.
    const groupIds = new Set(Object.keys(groups));
    const ungrouped = parentGroupId === undefined
      ? allWsSessions.filter(s =>
          (!s.groupId || !groupIds.has(s.groupId) || groups[s.groupId]?.kind === 'master')
          && passFilter(s))
      : [];

    if (cfg.sidebarSortMode === 'custom') {
      // Containers and root sessions interleave by their shared sortOrder. Fork
      // clusters fold in via foldRows at their first member's position; container
      // rows carry no `session` and pass through untouched.
      interface Row { sortOrder: number; secondaryKey: number | string; session?: SessionInfo; build: () => vscode.TreeItem }
      const rows: Row[] = [
        ...containerRows.map(r => ({ sortOrder: r.sortOrder, secondaryKey: r.name, build: r.build })),
        ...ungrouped.map(s => ({
          sortOrder: s.sortOrder ?? Number.MAX_SAFE_INTEGER,
          secondaryKey: s.tabId,
          session: s,
          build: () => this.makeSessionItem(s, cfg),
        })),
      ];
      rows.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (typeof a.secondaryKey === 'number' && typeof b.secondaryKey === 'number') {
          return a.secondaryKey - b.secondaryKey;
        }
        return String(a.secondaryKey).localeCompare(String(b.secondaryKey));
      });
      return this.foldRows(hash, rows, cfg);
    }

    // Non-custom modes: containers first (by sortOrder then name), then
    // ungrouped sessions ordered by the active mode (MRU / alphabetical / …),
    // with fork clusters folded in among the sessions.
    containerRows.sort((a, b) =>
      a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name));
    const sortedUngrouped = sortSessions(ungrouped, cfg.sidebarSortMode);
    return [
      ...containerRows.map(r => r.build()),
      ...this.foldRows(hash, sortedUngrouped.map(s => ({ session: s, build: () => this.makeSessionItem(s, cfg) })), cfg),
    ];
  }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const cfg = getConfig();
    // Only the container levels (root, workspace, group) need the live session
    // list; session-detail and subagent rows below don't. Skipping the tmux
    // subprocess + enrichment for those leaf branches is what stops an expanded
    // detail/subagent row from spawning `tmux list-sessions` on every refresh.
    const needsSessions = el === undefined
      || el instanceof WorkspaceTreeItem
      || el instanceof GroupTreeItem;
    let sessions: SessionInfo[] = [];
    if (needsSessions) {
      const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
      if (!tmuxPath) {
        const item = new vscode.TreeItem('tmux not installed — run: brew install tmux',
          vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('alert');
        return [item];
      }
      sessions = await this.sessionsForThisPass(tmuxPath, cfg.sessionPrefix);
    }
    let filtered = sessions;
    if (cfg.sidebarFilterMode === 'running') filtered = sessions.filter(s => !s.stopped);
    else if (cfg.sidebarFilterMode === 'stopped') filtered = sessions.filter(s => s.stopped);

    if (!el) {
      if (filtered.length === 0) {
        this.lastWorkspaceItems.clear();
        this.lastSessionItems.clear();
        this.lastGroupItems.clear();
        this.lastClusterItems.clear();
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
      // Groups AND sessions are rebuilt lazily on expand; drop stale entries so
      // getParent()/reveal() never get a container or session item from before a
      // move (a session cached at root would fail reveal after it moves into a
      // collapsed group — exactly the case reveal exists for).
      this.lastGroupItems.clear();
      this.lastSessionItems.clear();
      this.lastClusterItems.clear();
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
      return [
        ...(await this.specialFolders(el.workspaceHash, allWsSessions, cfg)),
        ...this.renderContainer(el.workspaceHash, undefined, allWsSessions, cfg),
      ];
    }
    if (el instanceof FavoritesFolderItem) {
      // Mirror rows, same rules as the Activity folder below: full actions,
      // uncached, distinct id prefix so the tree never sees a duplicate id.
      return el.sessions.map(s => {
        const item = this.makeSessionItem(s, cfg, false, false);
        item.id = `fav:${item.id}`;
        return item;
      });
    }
    if (el instanceof OpenFolderItem) {
      return el.sessions.map(s => {
        const item = this.makeSessionItem(s, cfg, false, false);
        item.id = `open:${item.id}`;
        return item;
      });
    }
    if (el instanceof ActivityFolderItem) {
      // Flat recency list. Rows are ordinary SessionTreeItems so every action
      // works, but they are NOT cached in lastSessionItems (the canonical row
      // in its group below owns reveal/getParent) and carry a distinct id so
      // the tree never sees the same id twice.
      return el.sessions.map(s => {
        const item = this.makeSessionItem(s, cfg, false, false);
        item.id = `act:${item.id}`;
        return item;
      });
    }
    if (el instanceof KilledFolderItem) {
      return el.entries.map(e => new KilledSessionItem(el.workspaceHash, e));
    }
    if (el instanceof GroupTreeItem) {
      const allWsSessions = sessions.filter(s => s.workspaceHash === el.workspaceHash);
      if (el.kind === 'master') {
        // Master container: its child masters + child normal groups. No
        // sessions appear directly under a master.
        return this.renderContainer(el.workspaceHash, el.groupId, allWsSessions, cfg);
      }
      // Normal group: its sessions (in current sort order) with fork clusters
      // folded in, exactly like the root's ungrouped list.
      return this.foldRows(
        el.workspaceHash,
        el.sessions.map(s => ({ session: s, build: () => this.makeSessionItem(s, cfg) })),
        cfg,
      );
    }
    if (el instanceof BranchClusterItem) {
      // Fork cluster: its member sessions, chip suppressed (header carries ⑂).
      // Members were captured when the cluster was built this pass — no tmux
      // enrichment needed, same as a normal group renders its captured sessions.
      return el.members.map(s => this.makeSessionItem(s, cfg, true));
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
    // Multi-select: lets batch actions (Add/Remove Favorites) and drag-drop
    // operate on several rows at once. Commands that don't understand a
    // selection keep acting on the clicked row only.
    canSelectMany: true,
  });
  ctx.subscriptions.push(treeView);
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new StoppedSessionDecorationProvider()),
    vscode.window.registerFileDecorationProvider(new BranchSetDecorationProvider()),
  );
  treeViewRef = treeView;
  // Track which containers the user has open so the tab-focus highlight can
  // skip sessions that aren't currently on-screen (it must never expand them).
  ctx.subscriptions.push(
    treeView.onDidExpandElement(e => provider?.noteExpanded(e.element, true)),
    treeView.onDidCollapseElement(e => provider?.noteExpanded(e.element, false)),
  );
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
    // Count only sessions the tracker is actively watching (its in-memory
    // snapshot map) instead of statSync-ing every session ever recorded in the
    // index on every event — only live sessions can be waiting/working anyway.
    const { waiting, working } = claude.attentionCounts();
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

  // Coalesce the agent-event stream: a working agent flushes its transcript many
  // times per second, and each flush used to trigger a full-tree refresh (one
  // tmux spawn per expanded node) + a badge recompute. Throttle to at most one
  // refresh per REFRESH_COALESCE_MS so a burst of writes costs one refresh, not
  // dozens — the sidebar still updates ~3×/sec while an agent streams.
  const REFRESH_COALESCE_MS = 300;
  let refreshPending = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  const doRefresh = (): void => { provider?.refresh(); updateBadge(); };
  const scheduleRefresh = (): void => {
    if (refreshPending) return;
    refreshPending = true;
    refreshTimer = setTimeout(() => { refreshPending = false; doRefresh(); }, REFRESH_COALESCE_MS);
  };
  ctx.subscriptions.push(claude.onChange(scheduleRefresh));
  const interval = setInterval(doRefresh, 10_000);
  ctx.subscriptions.push({ dispose: () => { clearInterval(interval); if (refreshTimer) clearTimeout(refreshTimer); } });
  updateBadge();
}

export function refreshSidebar(): void { provider?.refresh(); }

let treeViewRef: vscode.TreeView<vscode.TreeItem> | undefined;

/** Select and scroll to a session in the sidebar by tmux session name.
 *  `focus` true also moves keyboard focus to the tree (for the explicit
 *  "Reveal in Terminal Sessions View" command); the auto-highlight on tab focus
 *  leaves it false so it never steals focus from the terminal.
 *  `expand` true (the explicit command) builds the collapsed branch and lets
 *  reveal() open every ancestor group/master. `expand` false (tab focus) only
 *  highlights the session when it is ALREADY visible — it never expands a
 *  hidden branch, so switching terminal tabs won't reorganize the sidebar. */
export async function revealSessionInSidebar(
  sessionName: string,
  focus = false,
  expand = true,
): Promise<void> {
  if (!provider || !treeViewRef) return;

  if (!expand) {
    // Tab-focus highlight: select only when the session is on-screen already.
    // reveal() always expands ancestors, so we gate on isSessionVisible() and
    // bail out otherwise — no walk, no expansion, no scroll to a hidden row.
    const item = provider.getLastSessionItem(sessionName);
    if (!item || !provider.isSessionVisible(item.session)) return;
    try {
      await treeViewRef.reveal(item, { select: true, focus, expand: false });
    } catch { /* stale item — ignore */ }
    return;
  }

  let item = provider.getLastSessionItem(sessionName);
  if (!item) {
    // Not yet rendered — happens when the session lives in a collapsed group or
    // master. Walk the whole tree (workspaces → masters → groups) so its
    // TreeItem is built and cached before reveal. reveal() then expands the
    // ancestor chain itself via getParent().
    const stack: vscode.TreeItem[] = await provider.getChildren();
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const node = stack.pop()!;
      // Descend into fork clusters too, so a clustered session's row is built and
      // cached (and its cluster registered for getParent) before reveal walks up.
      if (node instanceof WorkspaceTreeItem
        || node instanceof GroupTreeItem
        || node instanceof BranchClusterItem) {
        // eslint-disable-next-line no-await-in-loop
        const kids = await provider.getChildren(node);
        for (const k of kids) stack.push(k);
      }
    }
    item = provider.getLastSessionItem(sessionName);
  }
  if (!item) return;
  try {
    await treeViewRef.reveal(item, { select: true, focus, expand: false });
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
