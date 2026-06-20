import * as vscode from 'vscode';

export type AutoRestoreMode = 'auto' | 'ask' | 'off';
export type NativeNotifMode = 'auto' | 'always' | 'never';
export type SidebarSortMode = 'custom' | 'mru' | 'created' | 'alphabetical';
export type SidebarFilterMode = 'all' | 'running' | 'stopped';
export const FILTER_MODES: SidebarFilterMode[] = ['all', 'running', 'stopped'];
export type ClaudeDetailsMode = 'auto' | 'always' | 'collapsed' | 'off';

export const SORT_MODES: SidebarSortMode[] = ['custom', 'mru', 'created', 'alphabetical'];

export type WaitingAlertStyle = 'banner' | 'alert';

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
  notificationSoundWaiting: string;
  notifyOnClaudeStop: boolean;
  notifyOnClaudeWaiting: boolean;
  waitingAlertStyle: WaitingAlertStyle;
  claudeStopMinDurationSeconds: number;
  autoResumeClaude: boolean;
  sidebarSortMode: SidebarSortMode;
  sidebarFilterMode: SidebarFilterMode;
  claudeSidebarDetails: ClaudeDetailsMode;
  contextWarnPct: number;
  showCompletedSubagents: boolean;
}

export function getConfig(): Config {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  const rawMode = c.get<string>('sidebarSortMode', 'created');
  const sortMode = (SORT_MODES as string[]).includes(rawMode)
    ? (rawMode as SidebarSortMode) : 'created';
  const rawFilter = c.get<string>('sidebarFilterMode', 'all');
  const filterMode = (FILTER_MODES as string[]).includes(rawFilter)
    ? (rawFilter as SidebarFilterMode) : 'all';
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
    notificationSoundWaiting: c.get('notificationSoundWaiting', 'Sosumi'),
    notifyOnClaudeStop: c.get('notifyOnClaudeStop', true),
    notifyOnClaudeWaiting: c.get('notifyOnClaudeWaiting', true),
    waitingAlertStyle: ((): WaitingAlertStyle => {
      const v = c.get<string>('waitingAlertStyle', 'banner');
      return v === 'alert' ? 'alert' : 'banner';
    })(),
    claudeStopMinDurationSeconds: c.get('claudeStopMinDurationSeconds', 15),
    autoResumeClaude: c.get('autoResumeClaude', false),
    sidebarSortMode: sortMode,
    sidebarFilterMode: filterMode,
    claudeSidebarDetails: ((): ClaudeDetailsMode => {
      const v = c.get<string>('claudeSidebarDetails', 'auto');
      return v === 'always' || v === 'off' || v === 'auto' || v === 'collapsed' ? v : 'auto';
    })(),
    contextWarnPct: Math.max(0, Math.min(1, c.get<number>('contextWarnPct', 0.8))),
    showCompletedSubagents: c.get('showCompletedSubagents', true),
  };
}

export async function setSortMode(mode: SidebarSortMode): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  await c.update('sidebarSortMode', mode, vscode.ConfigurationTarget.Global);
}

export async function setFilterMode(mode: SidebarFilterMode): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  await c.update('sidebarFilterMode', mode, vscode.ConfigurationTarget.Global);
}

export const PROFILE_ID = 'terminalSessions.persistent';
export const VIEW_ID = 'terminalSessions.sessions';
export const STOPPED_URI_SCHEME = 'terminal-sessions-stopped';

export const COMMAND = {
  toggleAllAlerts: 'terminalSessions.toggleAllAlerts',
  alertsEnable: 'terminalSessions.alertsEnable',
  alertsDisable: 'terminalSessions.alertsDisable',
  muteSession: 'terminalSessions.muteSession',
  unmuteSession: 'terminalSessions.unmuteSession',
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
  stop: 'terminalSessions.stop',
  start: 'terminalSessions.start',
  pickSortMode: 'terminalSessions.pickSortMode',
  pickFilterMode: 'terminalSessions.pickFilterMode',
  findSession: 'terminalSessions.findSession',
  fixClaudeRendering: 'terminalSessions.fixClaudeRendering',
  openSubagentTranscript: 'terminalSessions.openSubagentTranscript',
  viewConversation: 'terminalSessions.viewConversation',
  nameSession: 'terminalSessions.nameSession',
  toggleShowCompletedSubagents: 'terminalSessions.toggleShowCompletedSubagents',
  collapseSessions: 'terminalSessions.collapseSessions',
  reattachAll: 'terminalSessions.reattachAll',
  newGroup: 'terminalSessions.newGroup',
  renameGroup: 'terminalSessions.renameGroup',
  deleteGroup: 'terminalSessions.deleteGroup',
  moveSessionToGroup: 'terminalSessions.moveSessionToGroup',
  resumeOtherClaude: 'terminalSessions.resumeOtherClaude',
  resumeFromArchive: 'terminalSessions.resumeFromArchive',
  cleanupSessions: 'terminalSessions.cleanupSessions',
  newMasterGroup: 'terminalSessions.newMasterGroup',
  newGroupInMaster: 'terminalSessions.newGroupInMaster',
  moveGroupToMaster: 'terminalSessions.moveGroupToMaster',
  revealSessionFolder: 'terminalSessions.revealSessionFolder',
  revealSessionFolderFinder: 'terminalSessions.revealSessionFolderFinder',
  revealSessionInSidebar: 'terminalSessions.revealSessionInSidebar',
  copySessionId: 'terminalSessions.copySessionId',
  copySessionPath: 'terminalSessions.copySessionPath',
} as const;
