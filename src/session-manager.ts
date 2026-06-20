import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceIndex, WorkspaceEntry, SessionInfo, SessionLabel, GroupLabel } from './types';
import type { AgentId } from './agents/types';
import * as tmux from './tmux';
import { parseSessionName } from './workspace-id';

export class SessionIndex {
  private indexPath: string;
  private data: WorkspaceIndex;

  constructor() {
    const dir = path.join(os.homedir(), '.terminal-sessions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    this.indexPath = path.join(dir, 'index.json');
    this.data = this.load();
  }

  private load(): WorkspaceIndex {
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
    } catch { /* fall through */ }
    return { version: 1, workspaces: {} };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[terminal-sessions] failed to save index:', e);
    }
  }

  recordWorkspace(hash: string, wsPath: string, label: string): void {
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
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (folderPath) ws.sessions[sessionName].folderPath = folderPath;
    else delete ws.sessions[sessionName].folderPath;
    this.save();
  }

  setSessionLabel(hash: string, sessionName: string, label: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].label = label;
    this.save();
  }

  setSessionIcon(hash: string, sessionName: string, icon: string | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (icon) ws.sessions[sessionName].icon = icon;
    else delete ws.sessions[sessionName].icon;
    this.save();
  }

  setSessionColor(hash: string, sessionName: string, color: string | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (color) ws.sessions[sessionName].color = color;
    else delete ws.sessions[sessionName].color;
    this.save();
  }

  setSessionLastActive(hash: string, sessionName: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].lastActiveAt = new Date().toISOString();
    this.save();
  }

  setSessionMuted(hash: string, sessionName: string, muted: boolean): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (muted) ws.sessions[sessionName].muted = true;
    else delete ws.sessions[sessionName].muted;
    this.save();
  }

  isSessionMuted(hash: string, sessionName: string): boolean {
    return this.data.workspaces[hash]?.sessions[sessionName]?.muted === true;
  }

  setSessionStopped(hash: string, sessionName: string, stopped: boolean): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (stopped) ws.sessions[sessionName].stopped = true;
    else delete ws.sessions[sessionName].stopped;
    this.save();
  }

  setLastClaudeSessionId(hash: string, sessionName: string, sessionId: string): void {
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
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    const s = ws.sessions[sessionName];
    const list = s.agentSessions ?? [];
    if (list[0]?.agent === agent && list[0]?.id === sessionId) {
      // already at the front for this agent — but still ensure legacy mirror
      if (agent !== 'claude') return;
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

  /** The agent that most recently ran in this tmux session (for resume routing).
   *  Defaults to 'claude' when nothing is recorded. */
  getLastAgent(hash: string, sessionName: string): AgentId {
    const s = this.data.workspaces[hash]?.sessions[sessionName];
    return s?.agentSessions?.[0]?.agent ?? 'claude';
  }

  setSessionSortOrder(hash: string, sessionName: string, order: number | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (order === undefined) delete ws.sessions[sessionName].sortOrder;
    else ws.sessions[sessionName].sortOrder = order;
    this.save();
  }

  clearWorkspaceSortOrder(hash: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    for (const name of Object.keys(ws.sessions)) {
      delete ws.sessions[name].sortOrder;
    }
    this.save();
  }

  removeSession(hash: string, sessionName: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    delete ws.sessions[sessionName];
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
    const ws = this.data.workspaces[hash];
    if (!ws?.groups?.[groupId]) return;
    ws.groups[groupId].name = name.trim();
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
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (groupId !== undefined && !ws.groups?.[groupId]) return; // unknown group
    if (groupId === undefined) delete ws.sessions[sessionName].groupId;
    else ws.sessions[sessionName].groupId = groupId;
    this.save();
  }

  setGroupSortOrder(hash: string, groupId: string, order: number | undefined): void {
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
      stopped: false,
      groupId: meta?.groupId,
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
        stopped: true,
        groupId: meta.groupId,
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
