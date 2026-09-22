// The `+` button in the terminal panel opens `terminal.integrated.defaultProfile`,
// so until that names our profile every new terminal is a plain shell that dies
// with the window. That setting belongs to the user, so it is never flipped
// behind their back: the empty sidebar offers it (viewsWelcome in package.json),
// users who already have sessions get asked once, and the value it replaced is
// kept for an undo.
//
// The setting is read and written at the scope that wins (folder > workspace >
// user), the way tab-state.ts does for the tab description: writing the user
// value under a workspace override would change nothing and then claim success.
//
// Native Windows has no tmux, so there it gets an explanation instead of an
// offer: open the folder in WSL or over Remote-SSH, where the extension runs on
// Linux and everything works.

import * as vscode from 'vscode';
import { getConfig } from './config';
import { detectTmuxPath } from './tmux';

/** How VS Code names a profile an extension contributes in the default setting. */
const PROFILE_TITLE = 'Persistent Session';

const OFFER_KEY = 'defaultProfileOffer-v1';        // 'shown' | 'accepted' | 'restored'
const PREVIOUS_KEY = 'defaultProfilePrevious-v1';  // { [settingKey]: Backup }
const WINDOWS_KEY = 'windowsNoticeDismissed-v1';

const WSL_DOCS = 'https://code.visualstudio.com/docs/remote/wsl';
const TMUX_DOCS = 'https://github.com/tmux/tmux/wiki/Installing';

type Scope = 'global' | 'workspace' | 'folder';
interface Backup { scope: Scope; value: string | null }

/** Native Windows: the extension host itself runs on Windows. A WSL or SSH
 *  window reports linux here, which is the supported way in. */
export function isNativeWindows(): boolean {
  return process.platform === 'win32';
}

function settingKey(): string {
  const platform = process.platform === 'darwin' ? 'osx'
    : process.platform === 'win32' ? 'windows' : 'linux';
  return `terminal.integrated.defaultProfile.${platform}`;
}

function winningScope(info: ReturnType<vscode.WorkspaceConfiguration['inspect']>): Scope {
  if (info?.workspaceFolderValue !== undefined) return 'folder';
  if (info?.workspaceValue !== undefined) return 'workspace';
  return 'global';
}

function valueAt(
  info: ReturnType<vscode.WorkspaceConfiguration['inspect']>,
  scope: Scope,
): string | null | undefined {
  const v = scope === 'folder' ? info?.workspaceFolderValue
    : scope === 'workspace' ? info?.workspaceValue
    : info?.globalValue;
  return v as string | null | undefined;
}

function targetOf(scope: Scope): vscode.ConfigurationTarget {
  return scope === 'folder' ? vscode.ConfigurationTarget.WorkspaceFolder
    : scope === 'workspace' ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function backups(ctx: vscode.ExtensionContext): Record<string, Backup> {
  return { ...(ctx.globalState.get<Record<string, Backup>>(PREVIOUS_KEY) ?? {}) };
}

async function showWindowsNotice(ctx: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Terminal Sessions needs tmux, which does not run on Windows. Open your folder '
    + 'in WSL or over Remote-SSH and install the extension there: sessions, the '
    + 'sidebar and agent tracking all work in those windows.',
    'How to use WSL', "Don't show again",
  );
  // Either button means it was read; only the X keeps it for next time.
  if (choice) await ctx.globalState.update(WINDOWS_KEY, true);
  if (choice === 'How to use WSL') void vscode.env.openExternal(vscode.Uri.parse(WSL_DOCS));
}

/** Point `+` at persistent sessions, remembering what it opened before. */
export async function setAsDefaultProfile(ctx: vscode.ExtensionContext): Promise<void> {
  if (isNativeWindows()) { await showWindowsNotice(ctx); return; }
  // Without tmux the profile cannot start, so `+` would only show an error.
  if (!(await detectTmuxPath(getConfig().tmuxPath))) {
    const choice = await vscode.window.showErrorMessage(
      'tmux is not installed, so persistent sessions cannot start yet. Install it first.',
      'Install Instructions',
    );
    if (choice) void vscode.env.openExternal(vscode.Uri.parse(TMUX_DOCS));
    return;
  }
  const key = settingKey();
  const cfg = vscode.workspace.getConfiguration();
  const info = cfg.inspect<string>(key);
  const scope = winningScope(info);
  if (valueAt(info, scope) === PROFILE_TITLE) {
    await ctx.globalState.update(OFFER_KEY, 'accepted');
    vscode.window.showInformationMessage('New terminals (+) already open as persistent sessions.');
    return;
  }
  // Keep the first value we replaced: a second Set while ours is active must
  // not overwrite the backup with our own title.
  const previous = backups(ctx);
  if (!previous[key]) {
    previous[key] = { scope, value: valueAt(info, scope) ?? null };
    await ctx.globalState.update(PREVIOUS_KEY, previous);
  }
  try {
    await cfg.update(key, PROFILE_TITLE, targetOf(scope));
  } catch (e) {
    vscode.window.showErrorMessage(`Could not update ${key}: ${(e as Error).message}`);
    return;
  }
  if (vscode.workspace.getConfiguration().get<string>(key) !== PROFILE_TITLE) {
    vscode.window.showErrorMessage(
      `${key} was written, but another setting still overrides it. Check the Settings editor.`,
    );
    return;
  }
  await ctx.globalState.update(OFFER_KEY, 'accepted');
  const where = scope === 'global' ? '' : ` (${scope} settings)`;
  const choice = await vscode.window.showInformationMessage(
    `New terminals (+) now open as persistent sessions${where}.`, 'Undo',
  );
  if (choice === 'Undo') await restorePreviousDefaultProfile(ctx);
}

/** Put back the default `+` opened before setAsDefaultProfile. */
export async function restorePreviousDefaultProfile(ctx: vscode.ExtensionContext): Promise<void> {
  const key = settingKey();
  const cfg = vscode.workspace.getConfiguration();
  const info = cfg.inspect<string>(key);
  const previous = backups(ctx);
  const backup = previous[key];
  // Restore at the scope we wrote; without a backup (set by hand, or before
  // this version), at the scope that currently carries our title.
  const scope = backup && valueAt(info, backup.scope) === PROFILE_TITLE
    ? backup.scope
    : (['folder', 'workspace', 'global'] as Scope[]).find(s => valueAt(info, s) === PROFILE_TITLE);
  if (!scope) {
    vscode.window.showInformationMessage('New terminals do not open as persistent sessions; nothing to restore.');
    return;
  }
  // No backup, or a backup of "nothing": remove ours and let the platform
  // default (the login shell) take over again.
  const value = backup?.value ?? undefined;
  try {
    await cfg.update(key, value, targetOf(scope));
  } catch (e) {
    vscode.window.showErrorMessage(`Could not update ${key}: ${(e as Error).message}`);
    return;
  }
  delete previous[key];
  await ctx.globalState.update(PREVIOUS_KEY, previous);
  // An undo is not a decline, but it is an answer: no toast comes back.
  await ctx.globalState.update(OFFER_KEY, 'restored');
  vscode.window.showInformationMessage(
    `New terminals (+) open ${value ? `"${value}"` : 'the default shell'} again.`,
  );
}

/** Marks the sidebar welcome variant for native Windows. */
export function setPlatformContext(): void {
  void vscode.commands.executeCommand('setContext', 'terminalSessions.nativeWindows', isNativeWindows());
}

/**
 * Startup prompt, run from the startup queue. Explains native Windows once.
 * Elsewhere, asks once, and only users who already have sessions: a user with
 * none sees the same offer as buttons in the empty sidebar, which stays until
 * they choose, so a toast on top would be noise.
 */
export async function maybeOfferDefaultProfile(
  ctx: vscode.ExtensionContext,
  hasSessions: () => boolean,
): Promise<void> {
  if (isNativeWindows()) {
    if (!ctx.globalState.get(WINDOWS_KEY)) await showWindowsNotice(ctx);
    return;
  }
  if (ctx.globalState.get(OFFER_KEY)) return;
  if (!hasSessions()) return;
  if (vscode.workspace.getConfiguration().get<string>(settingKey()) === PROFILE_TITLE) {
    await ctx.globalState.update(OFFER_KEY, 'accepted');
    return;
  }
  if (!(await detectTmuxPath(getConfig().tmuxPath))) return;
  const choice = await vscode.window.showInformationMessage(
    'Terminals opened with the panel\'s + are plain shells that die with the '
    + 'window. Open them as persistent sessions instead? This asks once; '
    + '"Terminal Sessions: Set as Default Terminal Profile" does it later.',
    'Make + persistent', 'Not now',
  );
  // Any answer, the X included, is the one time we ask.
  await ctx.globalState.update(OFFER_KEY, 'shown');
  if (choice === 'Make + persistent') await setAsDefaultProfile(ctx);
}
