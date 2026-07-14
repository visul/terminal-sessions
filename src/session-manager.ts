import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceIndex, WorkspaceEntry, SessionInfo, SessionLabel, GroupLabel, BranchSet } from './types';
import type { AgentId } from './agents/types';
import { isForkableAgent } from './agents/registry';
import * as tmux from './tmux';
import { parseSessionName } from './workspace-id';

/** Number of contributed branch-chip theme colors (terminalSessions.branchColor1..N).
 *  New sets cycle through them round-robin. Keep in sync with contributes.colors. */
const BRANCH_COLOR_COUNT = 8;

export class SessionIndex {
  private indexPath: string;
  private data: WorkspaceIndex;
  /** mtime of index.json as of our last load/save. Lets reloadIfChanged() cheaply
   *  detect that another VS Code window wrote the file since we last touched it. */
  private lastMtimeMs = 0;

  constructor() {
    const dir = path.join(os.homedir(), '.terminal-sessions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    this.indexPath = path.join(dir, 'index.json');
    this.data = this.load();
  }

  /** Read + parse index.json from disk. Returns a fresh empty index when the file
   *  is absent (first run). On a parse/shape failure the corrupt file is preserved
   *  as index.json.corrupt.<ts> (so the user can recover groups/labels by hand)
   *  before falling back to empty — never silently discarded. Returns null only
   *  when the file exists but can't be read (permissions/IO), so callers keep the
   *  in-memory copy rather than wiping it. */
  private readFromDisk(): WorkspaceIndex | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, workspaces: {} };
      console.error('[terminal-sessions] cannot read index:', e);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
      throw new Error('unexpected index shape');
    } catch (e) {
      try {
        const bak = `${this.indexPath}.corrupt.${Date.now()}`;
        fs.writeFileSync(bak, raw);
        console.error(`[terminal-sessions] index.json unparseable (${e}); backed up to ${bak}, starting empty`);
      } catch { /* best effort */ }
      return { version: 1, workspaces: {} };
    }
  }

  private load(): WorkspaceIndex {
    const data = this.readFromDisk() ?? { version: 1, workspaces: {} };
    try { this.lastMtimeMs = fs.statSync(this.indexPath).mtimeMs; } catch { this.lastMtimeMs = 0; }
    return data;
  }

  /** Re-read index.json when another VS Code window has written it since our last
   *  load/save. Called at the top of every mutator so a change is always applied
   *  on top of the freshest on-disk snapshot — otherwise a stale in-memory copy
   *  would clobber a concurrent window's groups/labels/history on the next save
   *  (index.json is machine-global but each window holds its own copy). The mtime
   *  check makes the common single-window case a single stat with no re-read. */
  private reloadIfChanged(): void {
    let mtime = 0;
    try { mtime = fs.statSync(this.indexPath).mtimeMs; } catch { return; }
    if (mtime === this.lastMtimeMs) return;
    const fresh = this.readFromDisk();
    if (!fresh) return;
    this.data = fresh;
    this.lastMtimeMs = mtime;
  }

  /** Public hook so the sidebar can pull in another window's edits on its refresh
   *  tick (getters otherwise read this window's last-known snapshot). Cheap: one
   *  stat unless the file actually changed. */
  syncFromDisk(): void {
    this.reloadIfChanged();
  }

  private save(): void {
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    try {
      // Atomic replace: write a sibling temp file then rename over the target, so a
      // crash mid-write can never leave a truncated index.json (which load() would
      // treat as corrupt and back up).
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.indexPath);
      try { this.lastMtimeMs = fs.statSync(this.indexPath).mtimeMs; } catch { /* keep prior */ }
    } catch (e) {
      console.error('[terminal-sessions] failed to save index:', e);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  }

  recordWorkspace(hash: string, wsPath: string, label: string): void {
    this.reloadIfChanged();
    const existing = this.data.workspaces[hash];
    // CRITICAL: spread `existing` FIRST and only override the volatile fields
    // (path/label/lastSeen). Earlier we rebuilt the object listing only
    // `sessions`, which silently wiped `groups` on every workspace touch —
    // pressing "+ New Persistent Terminal" would call recordWorkspace and
    // erase every user-defined folder.
    this.data.workspaces[hash] = {
      ...(existing || { sessions: {} }),
      path: wsPath,
      label,
      lastSeen: new Date().toISOString(),
    };
    this.save();
  }

  recordSession(hash: string, sessionName: string, label?: string, folderPath?: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    const existing = ws.sessions[sessionName];
    ws.sessions[sessionName] = {
      ...(existing || {}),
      label: label ?? existing?.label,
      folderPath: folderPath ?? existing?.folderPath,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    this.save();
  }

  setSessionFolderPath(hash: string, sessionName: string, folderPath: string | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (folderPath) ws.sessions[sessionName].folderPath = folderPath;
    else delete ws.sessions[sessionName].folderPath;
    this.save();
  }

  setSessionLabel(hash: string, sessionName: string, label: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].label = label;
    this.save();
  }

  setSessionIcon(hash: string, sessionName: string, icon: string | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (icon) ws.sessions[sessionName].icon = icon;
    else delete ws.sessions[sessionName].icon;
    this.save();
  }

  setSessionColor(hash: string, sessionName: string, color: string | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (color) ws.sessions[sessionName].color = color;
    else delete ws.sessions[sessionName].color;
    this.save();
  }

  setSessionLastActive(hash: string, sessionName: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].lastActiveAt = new Date().toISOString();
    this.save();
  }

  setSessionMuted(hash: string, sessionName: string, muted: boolean): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (muted) ws.sessions[sessionName].muted = true;
    else delete ws.sessions[sessionName].muted;
    this.save();
  }

  isSessionMuted(hash: string, sessionName: string): boolean {
    return this.data.workspaces[hash]?.sessions[sessionName]?.muted === true;
  }

  setSessionLocked(hash: string, sessionName: string, locked: boolean): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (locked) ws.sessions[sessionName].locked = true;
    else delete ws.sessions[sessionName].locked;
    this.save();
  }

  isSessionLocked(hash: string, sessionName: string): boolean {
    return this.data.workspaces[hash]?.sessions[sessionName]?.locked === true;
  }

  setSessionStopped(hash: string, sessionName: string, stopped: boolean): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (stopped) ws.sessions[sessionName].stopped = true;
    else delete ws.sessions[sessionName].stopped;
    this.save();
  }

  setLastClaudeSessionId(hash: string, sessionName: string, sessionId: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (ws.sessions[sessionName].lastClaudeSessionId === sessionId) return;
    ws.sessions[sessionName].lastClaudeSessionId = sessionId;
    this.save();
  }

  /**
   * Push a Claude session id onto the front of this tmux session's history.
   * Dedupes (a re-seen id moves to the front), caps the list at 10, and also
   * mirrors the head into `lastClaudeSessionId` for backwards compatibility
   * with code that reads only that field.
   */
  recordClaudeSession(hash: string, sessionName: string, sessionId: string): void {
    this.recordAgentSession(hash, sessionName, 'claude', sessionId);
  }

  /**
   * Push an AI-agent session id onto the front of this tmux session's
   * agent-tagged history. Dedupes by (agent,id), caps at 20 total, and (for
   * Claude) mirrors the head into the legacy `claudeSessionHistory` /
   * `lastClaudeSessionId` fields so older code paths keep working.
   */
  recordAgentSession(hash: string, sessionName: string, agent: AgentId, sessionId: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    const s = ws.sessions[sessionName];
    const list = s.agentSessions ?? [];
    if (list[0]?.agent === agent && list[0]?.id === sessionId) {
      // Already at the front for this agent. Skip the whole-file rewrite unless
      // the legacy Claude mirror is somehow out of sync — a tool-heavy Claude
      // turn fires this per hook event, and re-serializing an unchanged index
      // (twice, with saveMap) on every event is pure churn on a hot file.
      if (agent !== 'claude') return;
      if (s.claudeSessionHistory?.[0] === sessionId && s.lastClaudeSessionId === sessionId) return;
    }
    const filtered = list.filter(e => !(e.agent === agent && e.id === sessionId));
    filtered.unshift({ agent, id: sessionId, ts: Date.now() });
    s.agentSessions = filtered.slice(0, 20);
    if (agent === 'claude') {
      const deduped = (s.claudeSessionHistory ?? []).filter(id => id !== sessionId);
      s.claudeSessionHistory = [sessionId, ...deduped].slice(0, 10);
      s.lastClaudeSessionId = sessionId;
    }
    this.save();
  }

  /** Ordered (most-recent-first) session-id history for one agent in a tmux
   *  session. Falls back to the legacy Claude fields when no agent-tagged
   *  history exists yet (index files written before the agent dimension). */
  getAgentSessionHistory(hash: string, sessionName: string, agent: AgentId): string[] {
    const s = this.data.workspaces[hash]?.sessions[sessionName];
    if (!s) return [];
    if (s.agentSessions && s.agentSessions.length > 0) {
      return s.agentSessions.filter(e => e.agent === agent).map(e => e.id);
    }
    if (agent === 'claude') {
      const legacy = s.claudeSessionHistory ?? [];
      if (legacy.length) return legacy;
      if (s.lastClaudeSessionId) return [s.lastClaudeSessionId];
    }
    return [];
  }

  /** Record the "character" launch flags seen on a live agent process, per agent,
   *  so Restart / post-reboot restore can relaunch the conversation the way it was
   *  started. Stores `[]` too (clears stale), and skips the write when unchanged. */
  recordResumeFlags(hash: string, sessionName: string, agent: AgentId, flags: string[]): void {
    this.reloadIfChanged();
    const s = this.data.workspaces[hash]?.sessions[sessionName];
    if (!s) return;
    const map = s.resumeFlags ?? {};
    const prev = map[agent];
    if (prev && prev.length === flags.length && prev.every((v, i) => v === flags[i])) return;
    map[agent] = flags;
    s.resumeFlags = map;
    this.save();
  }

  /** Captured launch flags for an agent in this tmux session (empty when none). */
  getResumeFlags(hash: string, sessionName: string, agent: AgentId): string[] {
    return this.data.workspaces[hash]?.sessions[sessionName]?.resumeFlags?.[agent] ?? [];
  }

  /** The agent that most recently ran in this tmux session (for resume routing).
   *  Defaults to 'claude' when nothing is recorded. */
  getLastAgent(hash: string, sessionName: string): AgentId {
    const s = this.data.workspaces[hash]?.sessions[sessionName];
    return s?.agentSessions?.[0]?.agent ?? 'claude';
  }

  setSessionSortOrder(hash: string, sessionName: string, order: number | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (order === undefined) delete ws.sessions[sessionName].sortOrder;
    else ws.sessions[sessionName].sortOrder = order;
    this.save();
  }

  clearWorkspaceSortOrder(hash: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    for (const name of Object.keys(ws.sessions)) {
      delete ws.sessions[name].sortOrder;
    }
    this.save();
  }

  removeSession(hash: string, sessionName: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    // Capture branch-set membership before deleting so a Kill dissolves an
    // orphaned set the same way Unlink does — otherwise the lone survivor keeps
    // its branchSetId and stays chip-colored forever (a set of one is dead).
    const setId = ws.sessions[sessionName]?.branchSetId;
    delete ws.sessions[sessionName];
    if (setId) this.dissolveBranchSetIfOrphaned(ws, setId);
    this.save();
  }

  getWorkspace(hash: string): WorkspaceEntry | undefined {
    return this.data.workspaces[hash];
  }

  getAllWorkspaces(): Record<string, WorkspaceEntry> {
    return this.data.workspaces;
  }

  getSessionLabel(hash: string, sessionName: string): string | undefined {
    return this.data.workspaces[hash]?.sessions[sessionName]?.label;
  }

  getSessionMeta(hash: string, sessionName: string): SessionLabel | undefined {
    return this.data.workspaces[hash]?.sessions[sessionName];
  }

  /** Set (or clear, when name is empty/undefined) a friendly label for an agent
   *  session id. Stored in the sidecar `sessionNames` map; never touches
   *  ~/.claude. */
  setSessionName(sessionId: string, name: string | undefined): void {
    this.reloadIfChanged();
    if (!sessionId) return;
    if (!this.data.sessionNames) this.data.sessionNames = {};
    const trimmed = name?.trim();
    if (trimmed) this.data.sessionNames[sessionId] = { name: trimmed, ts: Date.now() };
    else delete this.data.sessionNames[sessionId];
    this.save();
  }

  getSessionName(sessionId: string): string | undefined {
    return this.data.sessionNames?.[sessionId]?.name;
  }

  getNextTabId(hash: string, prefix: string): number {
    const ws = this.data.workspaces[hash];
    if (!ws) return 1;
    let max = 0;
    for (const name of Object.keys(ws.sessions)) {
      const parsed = parseSessionName(name, prefix);
      if (parsed && parsed.tabId > max) max = parsed.tabId;
    }
    return max + 1;
  }

  // ────────────────────── Branch set operations ──────────────────────
  //
  // A branch set loosely links sessions forked from one another
  // (Claude --fork-session). Peers, not a hierarchy: every member is equal and
  // carries `branchSetId`. Orthogonal to groups — a linked session keeps its
  // position (root or inside a manual group). Metadata only; the forked
  // conversations are already independent on disk.

  private nextBranchSetId(hash: string): string {
    const ws = this.data.workspaces[hash];
    const existing = new Set(Object.keys(ws?.branchSets || {}));
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = 'b_' + Math.random().toString(36).slice(2, 6);
      if (!existing.has(id)) return id;
    }
    return 'b_' + Date.now().toString(36);
  }

  /** Create a new branch set with `name`, assigning the next chip color
   *  round-robin. `baseLabel` is the clean origin label (no " ⑂"), stored for the
   *  fork-cluster header and name proposals. Returns the new id (undefined if the
   *  workspace is unknown). */
  createBranchSet(hash: string, name: string, baseLabel?: string): string | undefined {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws) return undefined;
    if (!ws.branchSets) ws.branchSets = {};
    const id = this.nextBranchSetId(hash);
    const n = (Object.keys(ws.branchSets).length % BRANCH_COLOR_COUNT) + 1;
    const set: BranchSet = {
      name: name.trim() || 'branch',
      colorId: `terminalSessions.branchColor${n}`,
      baseLabel: baseLabel?.trim() || undefined,
    };
    ws.branchSets[id] = set;
    this.save();
    return id;
  }

  /** Link a session into a branch set. No-op if workspace/session/set is unknown. */
  addSessionToBranchSet(hash: string, sessionName: string, branchSetId: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (!ws.branchSets?.[branchSetId]) return;
    ws.sessions[sessionName].branchSetId = branchSetId;
    this.save();
  }

  /** Unlink a session from its branch set. When fewer than 2 members remain the
   *  set auto-dissolves: the lone survivor is unlinked and the set entry deleted
   *  (a set of one is meaningless). */
  removeSessionFromBranchSet(hash: string, sessionName: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    const meta = ws?.sessions[sessionName];
    if (!ws || !meta?.branchSetId) return;
    const setId = meta.branchSetId;
    delete meta.branchSetId;
    this.dissolveBranchSetIfOrphaned(ws, setId);
    this.save();
  }

  /** Auto-dissolve a branch set once it can't hold a relationship: when fewer
   *  than 2 members remain, unlink the lone survivor and delete the set entry.
   *  Shared by Unlink and Kill (session removal). Caller saves. */
  private dissolveBranchSetIfOrphaned(ws: WorkspaceEntry, setId: string): void {
    const remaining = Object.values(ws.sessions).filter(s => s.branchSetId === setId);
    if (remaining.length < 2) {
      for (const s of remaining) delete s.branchSetId;
      if (ws.branchSets) delete ws.branchSets[setId];
    }
  }

  /** One-shot self-heal (run at activation): dissolve every branch set that can
   *  no longer hold a relationship (<2 member sessions). Recovers sets orphaned
   *  by a Kill from before removeSession learned to dissolve them, or by any
   *  other path that dropped a member outside the branch-set API — otherwise the
   *  lone survivor stays chip-colored forever. */
  pruneOrphanedBranchSets(): void {
    this.reloadIfChanged();
    let changed = false;
    for (const ws of Object.values(this.data.workspaces)) {
      if (!ws.branchSets) continue;
      for (const setId of Object.keys(ws.branchSets)) {
        this.dissolveBranchSetIfOrphaned(ws, setId);
        if (!ws.branchSets[setId]) changed = true;
      }
    }
    if (changed) this.save();
  }

  getBranchSet(hash: string, branchSetId: string): BranchSet | undefined {
    return this.data.workspaces[hash]?.branchSets?.[branchSetId];
  }

  /** Session names currently belonging to the given branch set. */
  branchSetMembers(hash: string, branchSetId: string): string[] {
    const ws = this.data.workspaces[hash];
    if (!ws) return [];
    return Object.keys(ws.sessions).filter(n => ws.sessions[n].branchSetId === branchSetId);
  }

  // ────────────────────── Group operations ──────────────────────
  //
  // Groups live at workspace level and share the sortOrder pool with
  // ungrouped sessions — both are siblings at the workspace root, ordered
  // together via drag-drop. session.groupId is the parent pointer; an
  // undefined groupId means the session sits at the root level.

  /** Generate a short stable id. Random enough that renaming doesn't break
   *  refs; short enough to keep index.json readable. */
  private nextGroupId(hash: string): string {
    const ws = this.data.workspaces[hash];
    const existing = new Set(Object.keys(ws?.groups || {}));
    // 4 random chars from base36 — 36^4 = ~1.7M, plenty for a workspace.
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = 'g_' + Math.random().toString(36).slice(2, 6);
      if (!existing.has(id)) return id;
    }
    return 'g_' + Date.now().toString(36); // fallback, near-impossible to collide
  }

  /** Create a new group (or master) with the given display name. Optionally
   *  nested inside a parent master. Returns the new id. */
  createGroup(
    hash: string,
    name: string,
    kind: 'group' | 'master' = 'group',
    parentGroupId?: string,
  ): string | undefined {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws) return undefined;
    if (!ws.groups) ws.groups = {};
    // Reject a parent that isn't a master (only masters can contain groups).
    if (parentGroupId !== undefined) {
      const parent = ws.groups[parentGroupId];
      if (!parent || parent.kind !== 'master') parentGroupId = undefined;
    }
    const id = this.nextGroupId(hash);
    // Append to the end of the destination container's order. For a nested
    // group that's the parent master's children; for root it's the root pool.
    const maxOrder = this.maxSortOrderInContainer(hash, parentGroupId);
    ws.groups[id] = {
      name: name.trim(),
      sortOrder: maxOrder + 1,
      kind,
      parentGroupId,
    };
    this.save();
    return id;
  }

  renameGroup(hash: string, groupId: string, name: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.groups?.[groupId]) return;
    ws.groups[groupId].name = name.trim();
    this.save();
  }

  /** Set (or clear, when color is undefined) the icon tint for a group/master. */
  setGroupColor(hash: string, groupId: string, color: string | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.groups?.[groupId]) return;
    if (color) ws.groups[groupId].color = color;
    else delete ws.groups[groupId].color;
    this.save();
  }

  /**
   * Delete a group or master.
   *   - Normal group: its sessions orphan back to the workspace root.
   *   - Master: its direct child groups/masters pop up one level to the
   *     master's own parent (root if it had none). Nothing is recursively
   *     deleted — the user loses only the one container they asked to remove.
   */
  deleteGroup(hash: string, groupId: string): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    const target = ws?.groups?.[groupId];
    if (!ws || !target) return;
    if (target.kind === 'master') {
      // Pop direct children up to this master's parent.
      const grandparent = target.parentGroupId;
      let nextOrder = this.maxSortOrderInContainer(hash, grandparent) + 1;
      for (const g of Object.values(ws.groups || {})) {
        if (g.parentGroupId === groupId) {
          g.parentGroupId = grandparent;
          g.sortOrder = nextOrder++;
        }
      }
    } else {
      // Normal group: orphan its sessions to root.
      let nextOrder = this.maxSortOrderInContainer(hash, undefined) + 1;
      for (const s of Object.values(ws.sessions)) {
        if (s.groupId === groupId) {
          s.groupId = undefined;
          s.sortOrder = nextOrder++;
        }
      }
    }
    delete ws.groups![groupId];
    this.save();
  }

  /**
   * Re-parent a group/master into a master (or to root when parentGroupId is
   * undefined). Rejects cycles: a master can't be moved inside its own
   * descendant. Rejects parents that aren't masters.
   */
  setGroupParent(hash: string, groupId: string, parentGroupId: string | undefined): boolean {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    const g = ws?.groups?.[groupId];
    if (!ws || !ws.groups || !g) return false;
    if (parentGroupId !== undefined) {
      if (parentGroupId === groupId) return false; // can't parent to self
      const parent = ws.groups[parentGroupId];
      if (!parent || parent.kind !== 'master') return false; // only masters hold groups
      if (this.isDescendantGroup(hash, groupId, parentGroupId)) return false; // cycle
    }
    g.parentGroupId = parentGroupId;
    this.save();
    return true;
  }

  /** True if `candidate` is `ancestor` itself or nested somewhere beneath it.
   *  Used to block cycles when re-parenting. */
  isDescendantGroup(hash: string, ancestor: string, candidate: string): boolean {
    const ws = this.data.workspaces[hash];
    if (!ws?.groups) return false;
    let cur: string | undefined = candidate;
    const seen = new Set<string>();
    while (cur !== undefined) {
      if (cur === ancestor) return true;
      if (seen.has(cur)) break; // defensive: malformed cycle in data
      seen.add(cur);
      cur = ws.groups[cur]?.parentGroupId;
    }
    return false;
  }

  setSessionGroup(hash: string, sessionName: string, groupId: string | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (groupId !== undefined) {
      const g = ws.groups?.[groupId];
      if (!g) return;                    // unknown group
      if (g.kind === 'master') return;   // masters hold only groups, not sessions —
      // assigning one here would make the session render nowhere (matches the DnD guard).
    }
    if (groupId === undefined) delete ws.sessions[sessionName].groupId;
    else ws.sessions[sessionName].groupId = groupId;
    this.save();
  }

  setGroupSortOrder(hash: string, groupId: string, order: number | undefined): void {
    this.reloadIfChanged();
    const ws = this.data.workspaces[hash];
    if (!ws?.groups?.[groupId]) return;
    if (order === undefined) delete ws.groups[groupId].sortOrder;
    else ws.groups[groupId].sortOrder = order;
    this.save();
  }

  /**
   * Highest sortOrder among the children of a given container. The container
   * is the workspace root (parentGroupId undefined) or a master group. Used so
   * newly-added items append at the end of the user's manual order within that
   * container.
   *   - Root children: top-level groups/masters (no parent) + ungrouped sessions.
   *   - Master children: groups/masters whose parentGroupId === the master.
   *     (Masters never directly contain sessions.)
   */
  private maxSortOrderInContainer(hash: string, parentGroupId: string | undefined): number {
    const ws = this.data.workspaces[hash];
    if (!ws) return 0;
    let max = 0;
    for (const g of Object.values(ws.groups || {})) {
      if (g.parentGroupId !== parentGroupId) continue;
      if (g.sortOrder !== undefined && g.sortOrder > max) max = g.sortOrder;
    }
    if (parentGroupId === undefined) {
      for (const s of Object.values(ws.sessions)) {
        if (s.groupId) continue; // grouped sessions don't compete at root
        if (s.sortOrder !== undefined && s.sortOrder > max) max = s.sortOrder;
      }
    }
    return max;
  }

  getGroup(hash: string, groupId: string): GroupLabel | undefined {
    return this.data.workspaces[hash]?.groups?.[groupId];
  }

  getGroups(hash: string): Record<string, GroupLabel> {
    return this.data.workspaces[hash]?.groups || {};
  }
}

export async function enrichSessions(
  tmuxPath: string,
  prefix: string,
  index: SessionIndex,
): Promise<SessionInfo[]> {
  // Pick up any edits another VS Code window made to index.json since our last
  // touch, so cross-window group/label/stop changes show up on the next refresh.
  index.syncFromDisk();
  const rows = await tmux.listSessions(tmuxPath, prefix);
  const out: SessionInfo[] = [];
  const liveNames = new Set<string>();

  // 1. Live tmux rows
  for (const row of rows) {
    const parsed = parseSessionName(row.name, prefix);
    if (!parsed) continue;
    liveNames.add(row.name);
    const ws = index.getWorkspace(parsed.hash);
    const meta = index.getSessionMeta(parsed.hash, row.name);
    const bset = meta?.branchSetId ? ws?.branchSets?.[meta.branchSetId] : undefined;
    const latestAgent: AgentId | undefined = meta?.agentSessions?.[0]?.agent
      ?? ((meta?.lastClaudeSessionId || meta?.claudeSessionHistory?.length) ? 'claude' : undefined);
    out.push({
      name: row.name,
      workspaceHash: parsed.hash,
      workspacePath: ws?.path || '',
      workspaceLabel: ws?.label || `(${parsed.hash})`,
      tabId: parsed.tabId,
      label: meta?.label,
      icon: meta?.icon,
      color: meta?.color,
      createdAt: new Date(row.created * 1000),
      lastAttached: new Date((row.lastAttached || row.created) * 1000),
      lastActiveAt: meta?.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
      sortOrder: meta?.sortOrder,
      attached: row.attached,
      muted: meta?.muted,
      locked: meta?.locked,
      stopped: false,
      groupId: meta?.groupId,
      branchSetId: meta?.branchSetId,
      branchName: bset?.name,
      branchColorId: bset?.colorId,
      branchBaseLabel: bset ? (bset.baseLabel ?? bset.name.replace(/\s*⑂\s*$/, '')) : undefined,
      forkable: isForkableAgent(latestAgent),
      folderPath: meta?.folderPath,
    });
  }

  // 2. Stopped index entries that have no live tmux row
  for (const [hash, ws] of Object.entries(index.getAllWorkspaces())) {
    for (const [sessionName, meta] of Object.entries(ws.sessions)) {
      if (!meta.stopped) continue;
      if (liveNames.has(sessionName)) continue;
      const parsed = parseSessionName(sessionName, prefix);
      if (!parsed) continue;
      const created = meta.createdAt ? new Date(meta.createdAt) : new Date(0);
      const lastActive = meta.lastActiveAt ? new Date(meta.lastActiveAt) : created;
      const bset = meta.branchSetId ? ws.branchSets?.[meta.branchSetId] : undefined;
      const latestAgent: AgentId | undefined = meta.agentSessions?.[0]?.agent
        ?? ((meta.lastClaudeSessionId || meta.claudeSessionHistory?.length) ? 'claude' : undefined);
      out.push({
        name: sessionName,
        workspaceHash: hash,
        workspacePath: ws.path,
        workspaceLabel: ws.label,
        tabId: parsed.tabId,
        label: meta.label,
        icon: meta.icon,
        color: meta.color,
        createdAt: created,
        lastAttached: lastActive,
        lastActiveAt: meta.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
        sortOrder: meta.sortOrder,
        attached: false,
        muted: meta.muted,
        locked: meta.locked,
        stopped: true,
        groupId: meta.groupId,
        branchSetId: meta.branchSetId,
        branchName: bset?.name,
        branchColorId: bset?.colorId,
        forkable: isForkableAgent(latestAgent),
        folderPath: meta.folderPath,
      });
    }
  }

  out.sort((a, b) => {
    if (a.workspaceLabel !== b.workspaceLabel) return a.workspaceLabel.localeCompare(b.workspaceLabel);
    return a.tabId - b.tabId;
  });
  return out;
}

export function groupByWorkspace(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const arr = map.get(s.workspaceHash) || [];
    arr.push(s);
    map.set(s.workspaceHash, arr);
  }
  return map;
}
