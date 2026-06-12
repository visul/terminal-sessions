import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { registerPersistentProfile } from './profile-provider';
import { registerCommands } from './commands';
import { registerSidebar, refreshSidebar, revealSessionInSidebar } from './sidebar/tree-provider';
import { StatusBar } from './status-bar';
import { maybePromptResume } from './toast';
import { TerminalTracker } from './terminal-tracker';
import { registerLongRunNotifier } from './long-run-notifier';
import { maybeOfferRestore } from './restore';
import { ClaudeTracker, isClaudeHookInstalled, needsHookUpgrade } from './claude-tracker';
import { AgentRegistry } from './agents/registry';
import { ClaudeSearchIndex } from './claude-search';
import { resolveTmuxNameForTerminalLive } from './profile-provider';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';
import { registerRevealPath } from './reveal-path';

// Note: tmux.conf is bootstrapped lazily by tmux.ensureConf() when the first
// session starts. No need to pre-seed from the extension bundle.

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const index = new SessionIndex();
  const registry = new AgentRegistry();
  const claudeTracker = new ClaudeTracker(ctx, registry, index);
  claudeTracker.start();
  ctx.subscriptions.push({ dispose: () => claudeTracker.dispose() });

  const searchIndex = new ClaudeSearchIndex();
  void searchIndex.load().then(() => searchIndex.refresh());

  ctx.subscriptions.push(registerPersistentProfile(index));
  registerCommands(ctx, index, claudeTracker, searchIndex, registry);
  registerRevealPath(ctx);
  registerSidebar(ctx, index, claudeTracker);

  // Prompt once to install hooks for the enabled agents (remembers declination).
  void maybePromptInstallClaudeHook(ctx, registry);

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
      void (async () => {
        // Robust to reload-restored (⚠) tabs (trimmed shellArgs) AND renamed
        // tabs (no #tabId in the label) — falls back to the live process via PID.
        const name = await resolveTmuxNameForTerminalLive(t, index, getConfig().sessionPrefix);
        if (!name) return;
        const parsed = parseSessionName(name, getConfig().sessionPrefix);
        if (!parsed) return;
        index.setSessionLastActive(parsed.hash, name);
        if (getConfig().sidebarSortMode === 'mru') refreshSidebar();
        // Highlight the matching session in our sidebar so it's easy to locate
        // when you have many terminal tabs open.
        void revealSessionInSidebar(name);
      })();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('terminalSessions.sidebarSortMode') ||
        e.affectsConfiguration('terminalSessions.claudeSidebarDetails')
      ) refreshSidebar();
    }),
  );

  // One-shot: silently upgrade any enabled agent whose hook is installed but
  // stale — missing newer events, or (for Claude) still on the legacy
  // claude-hook.sh that predates the shared agent-hook.sh forwarder.
  const needsUpgrade = registry.enabled().some(p => p.isHookInstalled() && p.needsHookUpgrade());
  if (needsUpgrade) {
    try { await claudeTracker.upgradeInstalledAgentHooks(); }
    catch { /* silent — user can manually reinstall from command palette */ }
  }

  // One-shot: offer to regenerate tmux.conf if the user is on the pre-v2
  // template (missing DECSET 2026 passthrough / correct default-terminal).
  void maybeOfferConfUpgrade(ctx);

  const resumeTimer = setTimeout(async () => {
    try {
      const result = await maybeOfferRestore(index, registry, claudeTracker);
      if (!result.ran || (result.recreated === 0 && result.attached === 0)) {
        await maybePromptResume(index);
      }
    } catch (e) {
      console.error('[terminal-sessions] resume pipeline failed:', e);
    }
  }, 1500);
  ctx.subscriptions.push({ dispose: () => clearTimeout(resumeTimer) });
}

async function maybePromptInstallClaudeHook(
  ctx: vscode.ExtensionContext,
  registry: AgentRegistry,
): Promise<void> {
  const enabled = registry.enabled();
  const missing = enabled.filter(p => !p.isHookInstalled());
  if (missing.length === 0) return;
  const KEY = 'claudeHookPromptDismissed';
  if (ctx.globalState.get(KEY)) return;
  const names = missing.map(p => p.displayName).join(', ');
  // Delay so we don't fight the restore toast for focus.
  setTimeout(async () => {
    const choice = await vscode.window.showInformationMessage(
      `Install AI agent hooks for ${names}? ` +
      'Enables sidebar status (working/waiting/idle), context %, auto-resume after reboot, ' +
      'and a notification when the agent finishes.',
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
  const KEY = 'tmuxConfUpgradeDismissed-v5';
  if (ctx.globalState.get(KEY)) return;
  setTimeout(async () => {
    const choice = await vscode.window.showInformationMessage(
      'Your Terminal Sessions tmux.conf can be updated. The new version copies via '
      + 'pbcopy/xclip instead of OSC 52, which fixes mangled non-ASCII text '
      + '(e.g. ș → È™) when pasting terminal selections into other apps. '
      + 'Update now? A backup is saved next to the current file.',
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
