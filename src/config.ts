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
  unreadBadges: boolean;
  transcriptExpiryWarnDays: number;
  notifyOnClaudeWaiting: boolean;
  waitingAlertStyle: WaitingAlertStyle;
  claudeStopMinDurationSeconds: number;
  autoResumeClaude: boolean;
  sidebarSortMode: SidebarSortMode;
  sidebarFilterMode: SidebarFilterMode;
  claudeSidebarDetails: ClaudeDetailsMode;
  contextWarnPct: number;
  showCompletedSubagents: boolean;
  claudeNoFlicker: boolean;
  revealActiveSession: boolean;
  confirmYoloSwitch: boolean;
  showFavoritesFolder: boolean;
  showOpenFolder: boolean;
  showBackgroundFolder: boolean;
  showActivityFolder: boolean;
  showKilledFolder: boolean;
  activityLimit: number;
  killedLimit: number;
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
    unreadBadges: c.get('unreadBadges', true),
    transcriptExpiryWarnDays: c.get('transcriptExpiryWarnDays', 20),
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
    claudeNoFlicker: ((): boolean => {
      const raw = c.get<string | boolean>('claudeNoFlicker', 'auto');
      if (raw === true || raw === 'on') return true;
      if (raw === false || raw === 'off') return false;
      // 'auto': NO_FLICKER on everywhere. tmux's MouseDrag binding pipes selections
      // through pbcopy/xclip, so copy works in alt-screen too (drag the visible text)
      // without relying on Claude's OSC 52 — the old reason to disable it on Cursor.
      // On = the wheel scrolls Claude's conversation natively (smooth).
      return true;
    })(),
    revealActiveSession: c.get('revealActiveSession', true),
    confirmYoloSwitch: c.get('confirmYoloSwitch', true),
    showFavoritesFolder: c.get('showFavoritesFolder', true),
    showOpenFolder: c.get('showOpenFolder', true),
    showBackgroundFolder: c.get('showBackgroundFolder', true),
    showActivityFolder: c.get('showActivityFolder', true),
    showKilledFolder: c.get('showKilledFolder', true),
    activityLimit: Math.max(1, c.get<number>('activityLimit', 50)),
    killedLimit: Math.max(1, c.get<number>('killedLimit', 50)),
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
// resourceUri scheme for fork branch-set members. The BranchSetDecorationProvider
// matches this scheme and reads the chip color/name from the uri query, so it
// needs no index lookup. Distinct from the stopped scheme; a row has one
// resourceUri, so a stopped+branched session keeps the stopped decoration.
export const BRANCH_URI_SCHEME = 'terminal-sessions-branch';

export const COMMAND = {
  toggleAllAlerts: 'terminalSessions.toggleAllAlerts',
  alertsEnable: 'terminalSessions.alertsEnable',
  alertsDisable: 'terminalSessions.alertsDisable',
  muteSession: 'terminalSessions.muteSession',
  dismissAttention: 'terminalSessions.dismissAttention',
  markAllSeen: 'terminalSessions.markAllSeen',
  unmuteSession: 'terminalSessions.unmuteSession',
  favoriteOn: 'terminalSessions.favoriteOn',
  favoriteOff: 'terminalSessions.favoriteOff',
  toggleFavorite: 'terminalSessions.toggleFavorite',
  lockSession: 'terminalSessions.lockSession',
  unlockSession: 'terminalSessions.unlockSession',
  lockedHint: 'terminalSessions.lockedHint',
  newPersistent: 'terminalSessions.newPersistent',
  newPersistentInFolder: 'terminalSessions.newPersistentInFolder',
  attachTo: 'terminalSessions.attachTo',
  kill: 'terminalSessions.kill',
  killDelete: 'terminalSessions.killDelete',
  killAllStale: 'terminalSessions.killAllStale',
  killWorkspace: 'terminalSessions.killWorkspace',
  refreshSidebar: 'terminalSessions.refreshSidebar',
  revealSidebar: 'terminalSessions.revealSidebar',
  rename: 'terminalSessions.rename',
  resumeAll: 'terminalSessions.resumeAll',
  setAsDefaultProfile: 'terminalSessions.setAsDefaultProfile',
  openTmuxConfig: 'terminalSessions.openTmuxConfig',
  reloadTmuxConfig: 'terminalSessions.reloadTmuxConfig',
  setIcon: 'terminalSessions.setIcon',
  setColor: 'terminalSessions.setColor',
  restoreFromIndex: 'terminalSessions.restoreFromIndex',
  testNotification: 'terminalSessions.testNotification',
  installClaudeHook: 'terminalSessions.installClaudeHook',
  uninstallClaudeHook: 'terminalSessions.uninstallClaudeHook',
  restart: 'terminalSessions.restart',
  switchToYolo: 'terminalSessions.switchToYolo',
  switchToNormal: 'terminalSessions.switchToNormal',
  toggleYolo: 'terminalSessions.toggleYolo',
  stop: 'terminalSessions.stop',
  forkConversation: 'terminalSessions.forkConversation',
  unlinkBranch: 'terminalSessions.unlinkBranch',
  start: 'terminalSessions.start',
  pickSortMode: 'terminalSessions.pickSortMode',
  pickFilterMode: 'terminalSessions.pickFilterMode',
  findSession: 'terminalSessions.findSession',
  searchSessions: 'terminalSessions.searchSessions',
  filterSessions: 'terminalSessions.filterSessions',
  clearSidebarTextFilter: 'terminalSessions.clearSidebarTextFilter',
  fixTranscriptCleanup: 'terminalSessions.fixTranscriptCleanup',
  dismissCleanupNotice: 'terminalSessions.dismissCleanupNotice',
  fixClaudeRendering: 'terminalSessions.fixClaudeRendering',
  fixClaudeMouseEnv: 'terminalSessions.fixClaudeMouseEnv',
  openSubagentTranscript: 'terminalSessions.openSubagentTranscript',
  viewConversation: 'terminalSessions.viewConversation',
  nameSession: 'terminalSessions.nameSession',
  toggleShowCompletedSubagents: 'terminalSessions.toggleShowCompletedSubagents',
  collapseSessions: 'terminalSessions.collapseSessions',
  reattachAll: 'terminalSessions.reattachAll',
  newGroup: 'terminalSessions.newGroup',
  renameGroup: 'terminalSessions.renameGroup',
  deleteGroup: 'terminalSessions.deleteGroup',
  setGroupColor: 'terminalSessions.setGroupColor',
  moveSessionToGroup: 'terminalSessions.moveSessionToGroup',
  resumeOtherClaude: 'terminalSessions.resumeOtherClaude',
  resumeFromArchive: 'terminalSessions.resumeFromArchive',
  cleanupSessions: 'terminalSessions.cleanupSessions',
  newMasterGroup: 'terminalSessions.newMasterGroup',
  moveGroupToMaster: 'terminalSessions.moveGroupToMaster',
  revealSessionFolder: 'terminalSessions.revealSessionFolder',
  revealSessionFolderFinder: 'terminalSessions.revealSessionFolderFinder',
  revealSessionInSidebar: 'terminalSessions.revealSessionInSidebar',
  copySessionId: 'terminalSessions.copySessionId',
  copySessionPath: 'terminalSessions.copySessionPath',
  enableFavoritesFolder: 'terminalSessions.enableFavoritesFolder',
  disableFavoritesFolder: 'terminalSessions.disableFavoritesFolder',
  enableOpenFolder: 'terminalSessions.enableOpenFolder',
  disableOpenFolder: 'terminalSessions.disableOpenFolder',
  enableBackgroundFolder: 'terminalSessions.enableBackgroundFolder',
  disableBackgroundFolder: 'terminalSessions.disableBackgroundFolder',
  enableActivityFolder: 'terminalSessions.enableActivityFolder',
  disableActivityFolder: 'terminalSessions.disableActivityFolder',
  enableKilledFolder: 'terminalSessions.enableKilledFolder',
  disableKilledFolder: 'terminalSessions.disableKilledFolder',
  restoreKilled: 'terminalSessions.restoreKilled',
} as const;
