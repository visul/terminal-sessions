import * as vscode from 'vscode';

export type AutoRestoreMode = 'auto' | 'ask' | 'off';
export type NativeNotifMode = 'auto' | 'always' | 'never';
export type SidebarSortMode = 'custom' | 'mru' | 'created' | 'alphabetical';
export type ClaudeDetailsMode = 'auto' | 'always' | 'off';

export const SORT_MODES: SidebarSortMode[] = ['custom', 'mru', 'created', 'alphabetical'];

export interface Config {
  tmuxPath: string;
  sessionPrefix: string;
  autoRestore: AutoRestoreMode;
  autoRestoreMaxAgeHours: number;
  pruneAfterDays: number;
  enableCostTracker: boolean;
  enableLongRunNotifications: boolean;
  longRunThresholdSeconds: number;
  nativeNotifications: NativeNotifMode;
  notificationSound: string;
  notifyOnClaudeStop: boolean;
  claudeStopMinDurationSeconds: number;
  autoResumeClaude: boolean;
  sidebarSortMode: SidebarSortMode;
  claudeSidebarDetails: ClaudeDetailsMode;
  contextWarnPct: number;
}

export function getConfig(): Config {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  const rawMode = c.get<string>('sidebarSortMode', 'created');
  const sortMode = (SORT_MODES as string[]).includes(rawMode)
    ? (rawMode as SidebarSortMode) : 'created';
  return {
    tmuxPath: c.get('tmuxPath', ''),
    sessionPrefix: c.get('sessionPrefix', 'ts'),
    autoRestore: c.get('autoRestore', 'ask') as AutoRestoreMode,
    autoRestoreMaxAgeHours: c.get('autoRestoreMaxAgeHours', 72),
    pruneAfterDays: c.get('pruneAfterDays', 14),
    enableCostTracker: c.get('enableCostTracker', true),
    enableLongRunNotifications: c.get('enableLongRunNotifications', true),
    longRunThresholdSeconds: c.get('longRunThresholdSeconds', 30),
    nativeNotifications: c.get('nativeNotifications', 'auto') as NativeNotifMode,
    notificationSound: c.get('notificationSound', 'Glass'),
    notifyOnClaudeStop: c.get('notifyOnClaudeStop', true),
    claudeStopMinDurationSeconds: c.get('claudeStopMinDurationSeconds', 15),
    autoResumeClaude: c.get('autoResumeClaude', false),
    sidebarSortMode: sortMode,
    claudeSidebarDetails: ((): ClaudeDetailsMode => {
      const v = c.get<string>('claudeSidebarDetails', 'auto');
      return v === 'always' || v === 'off' || v === 'auto' ? v : 'auto';
    })(),
    contextWarnPct: Math.max(0, Math.min(1, c.get<number>('contextWarnPct', 0.8))),
  };
}

export async function setSortMode(mode: SidebarSortMode): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  await c.update('sidebarSortMode', mode, vscode.ConfigurationTarget.Global);
}

export const PROFILE_ID = 'terminalSessions.persistent';
export const VIEW_ID = 'terminalSessions.sessions';

export const COMMAND = {
  newPersistent: 'terminalSessions.newPersistent',
  newPersistentInFolder: 'terminalSessions.newPersistentInFolder',
  attachTo: 'terminalSessions.attachTo',
  kill: 'terminalSessions.kill',
  killAllStale: 'terminalSessions.killAllStale',
  killWorkspace: 'terminalSessions.killWorkspace',
  refreshSidebar: 'terminalSessions.refreshSidebar',
  revealSidebar: 'terminalSessions.revealSidebar',
  preview: 'terminalSessions.preview',
  rename: 'terminalSessions.rename',
  resumeAll: 'terminalSessions.resumeAll',
  setAsDefaultProfile: 'terminalSessions.setAsDefaultProfile',
  openTmuxConfig: 'terminalSessions.openTmuxConfig',
  reloadTmuxConfig: 'terminalSessions.reloadTmuxConfig',
  setIcon: 'terminalSessions.setIcon',
  setColor: 'terminalSessions.setColor',
  mirror: 'terminalSessions.mirror',
  restoreFromIndex: 'terminalSessions.restoreFromIndex',
  testNotification: 'terminalSessions.testNotification',
  installClaudeHook: 'terminalSessions.installClaudeHook',
  uninstallClaudeHook: 'terminalSessions.uninstallClaudeHook',
  restart: 'terminalSessions.restart',
  pickSortMode: 'terminalSessions.pickSortMode',
  findSession: 'terminalSessions.findSession',
  fixClaudeRendering: 'terminalSessions.fixClaudeRendering',
} as const;
