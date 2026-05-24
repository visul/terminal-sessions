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
  stopped?: boolean;  // true when user clicked Stop; the tmux session is dead but the entry is kept
}

export interface WorkspaceIndex {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
}

export interface WorkspaceEntry {
  path: string;
  label: string;
  lastSeen: string;
  sessions: Record<string, SessionLabel>;
}

export interface SessionLabel {
  label?: string;
  icon?: string;
  color?: string;
  createdAt: string;
  lastActiveAt?: string;
  sortOrder?: number;
  muted?: boolean;   // when true, suppress Claude Stop/Waiting notifications for this session
  // Original cwd the session was created in. Differs from the workspace root
  // when the session was started from a subfolder (right-click → New Persistent
  // in Folder). Persisted so Restart re-creates tmux in the SAME folder, not
  // the VS Code workspace root.
  folderPath?: string;
  stopped?: boolean;  // persisted: tmux session is intentionally killed but entry kept
  // Last Claude session id that ran in this tmux session. Survives the live
  // claude-map cleanup that fires when a Claude conversation moves to another
  // tmux (claude --resume in a different tab), so Stop -> Start can still
  // auto-resume the original conversation here.
  lastClaudeSessionId?: string;
}

export interface TmuxSessionRow {
  name: string;
  created: number;
  lastAttached: number;
  attached: boolean;
}
