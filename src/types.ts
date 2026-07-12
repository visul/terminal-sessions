import type { AgentId } from './agents/types';

/** One AI-agent session that ran in a tmux session, tagged by which CLI it
 *  belongs to. Replaces the Claude-only history with an agent-aware list. */
export interface AgentSessionRef {
  agent: AgentId;
  id: string;
  ts: number;
}

export interface SessionInfo {
  name: string;
  workspaceHash: string;
  workspacePath: string;
  workspaceLabel: string;
  tabId: number;
  label?: string;
  icon?: string;   // codicon id without $()
  color?: string;  // theme color id, e.g. "terminal.ansiGreen"
  createdAt: Date;
  lastAttached: Date;
  lastActiveAt?: Date;
  sortOrder?: number;
  attached: boolean;
  muted?: boolean;  // when true, notifications are suppressed for this session
  locked?: boolean;  // when true, the session is protected from Kill (padlock shown; unlock to remove)
  stopped?: boolean;  // true when user clicked Stop; the tmux session is dead but the entry is kept
  groupId?: string;  // when set, session lives inside a custom group at workspace level
  // Fork branch-set membership, resolved at enrichment time so the tree item can
  // build the chip resourceUri without a second index lookup.
  branchSetId?: string;
  branchName?: string;     // set display name (chip tooltip)
  branchColorId?: string;  // theme color id for the ⑂ chip
  // True when this session's latest agent conversation can be forked (Claude).
  // Drives the `forkable` contextValue token that gates the Fork command.
  forkable?: boolean;
  // Actual cwd the tmux session was started in. Set for subfolder sessions
  // (right-click → New Persistent in Folder); differs from the workspace root.
  folderPath?: string;
}

export interface WorkspaceIndex {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
  // Friendly names for agent sessions (any agent), keyed by sessionId. Sidecar
  // only — Claude's own transcript files are never modified for naming.
  sessionNames?: Record<string, { name: string; ts: number }>;
}

export interface WorkspaceEntry {
  path: string;
  label: string;
  lastSeen: string;
  sessions: Record<string, SessionLabel>;
  // User-defined groups (folders) within this workspace. Keyed by short
  // random id so renaming a group doesn't invalidate session.groupId refs.
  // sortOrder is shared with ungrouped sessions at workspace root — they live
  // at the same hierarchy level and the user reorders both via drag-drop.
  groups?: Record<string, GroupLabel>;
  // Fork "branch sets": loose peer links between sessions that were forked from
  // one another (Claude --fork-session). Keyed by short random id. A set is
  // metadata only — the forked conversations are already independent on disk —
  // and members carry `branchSetId`. Membership is orthogonal to `groups`: a
  // linked session keeps its position (root or inside a manual group).
  branchSets?: Record<string, BranchSet>;
}

export interface BranchSet {
  // Human name derived from the origin session's label at fork time (e.g.
  // "ASCK ⑂"). Shown in the row's chip tooltip.
  name: string;
  // Theme color id (terminalSessions.branchColorN) tinting every member's ⑂
  // chip, so a set is recognizable at a glance. Assigned round-robin on create.
  colorId: string;
}

export interface GroupLabel {
  name: string;
  sortOrder?: number;
  // Optional theme color id (e.g. "terminal.ansiBlue") tinting the group/master
  // icon in the sidebar. Set via right-click → Change Group Color.
  color?: string;
  // 'group' (default) holds sessions only. 'master' holds other groups/masters
  // only (a "group of groups"), never sessions directly.
  kind?: 'group' | 'master';
  // Parent master id. Unset = lives at the workspace root. Set = nested inside
  // that master group. Both normal groups and masters can have a parent master,
  // enabling arbitrary-depth nesting (master -> master -> group -> sessions).
  parentGroupId?: string;
}

export interface SessionLabel {
  label?: string;
  icon?: string;
  color?: string;
  createdAt: string;
  lastActiveAt?: string;
  sortOrder?: number;
  muted?: boolean;   // when true, suppress Claude Stop/Waiting notifications for this session
  // When true, this session is protected from Kill: the destructive Kill action is
  // hidden in the sidebar and refused by the command, guarding against accidental
  // removal. Toggled via right-click Lock/Unlock. A 🔒 hint is shown on the row.
  locked?: boolean;
  // Original cwd the session was created in. Differs from the workspace root
  // when the session was started from a subfolder (right-click → New Persistent
  // in Folder). Persisted so Restart re-creates tmux in the SAME folder, not
  // the VS Code workspace root.
  folderPath?: string;
  stopped?: boolean;  // persisted: tmux session is intentionally killed but entry kept
  // Last Claude session id that ran in this tmux session. Survives the live
  // claude-map cleanup that fires when a Claude conversation moves to another
  // tmux (claude --resume in a different tab), so Stop -> Start can still
  // auto-resume the original conversation here. Mirrors `claudeSessionHistory[0]`
  // and kept for backwards compatibility with older index files.
  lastClaudeSessionId?: string;
  // Ordered history of Claude session ids that ran in this tmux session, most
  // recent first, capped at 10. The first element drives auto-resume on
  // Stop -> Start and post-reboot restore; older entries are kept so the user
  // can manually `claude --resume <id>` an older conversation if needed.
  claudeSessionHistory?: string[];
  // Agent-tagged session history (most recent first), spanning every AI CLI
  // that ran in this tmux session (claude/codex/agy). Supersedes the Claude-only
  // fields above, which are still mirrored for back-compat with older index
  // files and code paths that read only `claudeSessionHistory`.
  agentSessions?: AgentSessionRef[];
  // "Character" launch flags observed on the live agent process, per agent
  // (yolo / --model / sandbox / …), so Restart and post-reboot restore relaunch
  // the conversation the way it was originally started. Refreshed each time we
  // see the live process; ephemeral path flags (claude-pick's temp --mcp-config)
  // are filtered out at relaunch time, not here.
  resumeFlags?: Partial<Record<AgentId, string[]>>;
  // When set, this session lives inside the named group at workspace level.
  // Cleared (or undefined) means the session sits at the workspace root,
  // siblings with the groups, ordered by sortOrder among them.
  groupId?: string;
  // When set, this session belongs to the named fork branch set (peers forked
  // from the same conversation). Drives the ⑂ chip decoration. Cleared on Unlink;
  // the set auto-dissolves when fewer than 2 members remain.
  branchSetId?: string;
}

export interface TmuxSessionRow {
  name: string;
  created: number;
  lastAttached: number;
  attached: boolean;
}
