import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { registerPersistentProfile } from './profile-provider';
import { registerCommands } from './commands';
import { registerSidebar, refreshSidebar } from './sidebar/tree-provider';
import { StatusBar } from './status-bar';
import { maybePromptResume } from './toast';
import { TerminalTracker } from './terminal-tracker';
import { registerLongRunNotifier } from './long-run-notifier';
import { maybeOfferRestore } from './restore';
import { ClaudeTracker, isClaudeHookInstalled, needsHookUpgrade } from './claude-tracker';
import { ClaudeSearchIndex } from './claude-search';
import { sessionNameForTerminal } from './profile-provider';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';

// Note: tmux.conf is bootstrapped lazily by tmux.ensureConf() when the first
// session starts. No need to pre-seed from the extension bundle.

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const index = new SessionIndex();
  const claudeTracker = new ClaudeTracker(ctx);
  claudeTracker.start();
  ctx.subscriptions.push({ dispose: () => claudeTracker.dispose() });

  const searchIndex = new ClaudeSearchIndex();
  void searchIndex.load().then(() => searchIndex.refresh());

  ctx.subscriptions.push(registerPersistentProfile(index));
  registerCommands(ctx, index, claudeTracker, searchIndex);
  registerSidebar(ctx, index, claudeTracker);

  // Prompt once to install the Claude hook (remembers declination).
  maybePromptInstallClaudeHook(ctx);

  const statusBar = new StatusBar(index);
  statusBar.start();
  ctx.subscriptions.push({ dispose: () => statusBar.stop() });

  const tracker = new TerminalTracker(index);
  tracker.start();
  ctx.subscriptions.push(tracker);

  registerLongRunNotifier(ctx);

  ctx.subscriptions.push(
    vscode.window.onDidCloseTerminal(() => refreshSidebar()),
    vscode.window.onDidOpenTerminal(() => refreshSidebar()),
    vscode.window.onDidChangeActiveTerminal(t => {
      if (!t) return;
      const name = sessionNameForTerminal(t);
      if (!name) return;
      const parsed = parseSessionName(name, getConfig().sessionPrefix);
      if (!parsed) return;
      index.setSessionLastActive(parsed.hash, name);
      if (getConfig().sidebarSortMode === 'mru') refreshSidebar();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('terminalSessions.sidebarSortMode') ||
        e.affectsConfiguration('terminalSessions.claudeSidebarDetails')
      ) refreshSidebar();
    }),
  );

  // One-shot: if hook is installed but missing new events, silently upgrade so
  // users on old v0.5 hook start capturing PreToolUse/UserPromptSubmit/etc.
  if (isClaudeHookInstalled() && needsHookUpgrade()) {
    try { await vscode.commands.executeCommand('terminalSessions.installClaudeHook'); }
    catch { /* silent — user can manually reinstall from command palette */ }
  }

  // One-shot: offer to regenerate tmux.conf if the user is on the pre-v2
  // template (missing DECSET 2026 passthrough / correct default-terminal).
  void maybeOfferConfUpgrade(ctx);

  const resumeTimer = setTimeout(async () => {
    try {
      const result = await maybeOfferRestore(index, claudeTracker);
      if (!result.ran || (result.recreated === 0 && result.attached === 0)) {
        await maybePromptResume(index);
      }
    } catch (e) {
      console.error('[terminal-sessions] resume pipeline failed:', e);
    }
  }, 1500);
  ctx.subscriptions.push({ dispose: () => clearTimeout(resumeTimer) });
}

async function maybePromptInstallClaudeHook(ctx: vscode.ExtensionContext): Promise<void> {
  if (isClaudeHookInstalled()) return;
  const KEY = 'claudeHookPromptDismissed';
  if (ctx.globalState.get(KEY)) return;
  // Delay so we don't fight the restore toast for focus.
  setTimeout(async () => {
    const choice = await vscode.window.showInformationMessage(
      'Install Claude Code hook for session tracking and macOS notifications?\n' +
      'Adds SessionStart + Stop hooks in ~/.claude/settings.json.\n' +
      'Enables: auto-resume correct conversation after reboot, notification when Claude finishes.',
      'Install', 'Not now', "Don't ask again",
    );
    if (choice === 'Install') {
      await vscode.commands.executeCommand('terminalSessions.installClaudeHook');
    } else if (choice === "Don't ask again") {
      await ctx.globalState.update(KEY, true);
    }
  }, 4000);
}

async function maybeOfferConfUpgrade(ctx: vscode.ExtensionContext): Promise<void> {
  const { isConfOutOfDate, regenerateConf } = await import('./tmux');
  if (!isConfOutOfDate()) return;
  const KEY = 'tmuxConfUpgradeDismissed-v2';
  if (ctx.globalState.get(KEY)) return;
  setTimeout(async () => {
    const choice = await vscode.window.showInformationMessage(
      'Your Terminal Sessions tmux.conf is missing Claude-Code-friendly rendering settings '
      + '(synchronized output, correct default-terminal). Update now? '
      + 'A backup is saved next to the current file.',
      'Update', 'Not now', "Don't ask again",
    );
    if (choice === 'Update') {
      const backup = regenerateConf();
      const msg = backup
        ? `tmux.conf updated. Previous version backed up at ${backup}. `
          + 'Run "Terminal Sessions: Reload tmux Config" to apply to live sessions.'
        : 'Could not update tmux.conf (permissions?). Check ~/.terminal-sessions/tmux.conf.';
      vscode.window.showInformationMessage(msg);
    } else if (choice === "Don't ask again") {
      await ctx.globalState.update(KEY, true);
    }
  }, 6000);
}

export function deactivate(): void { /* handled via ctx.subscriptions */ }
