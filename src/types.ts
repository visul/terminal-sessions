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
}

export interface TmuxSessionRow {
  name: string;
  created: number;
  lastAttached: number;
  attached: boolean;
}
