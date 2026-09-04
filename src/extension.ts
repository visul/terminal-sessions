import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { registerPersistentProfile } from './profile-provider';
import { registerCommands, syncActiveTerminalContext, syncSpecialFolderContexts } from './commands';
import { registerSidebar, refreshSidebar, revealSessionInSidebar } from './sidebar/tree-provider';
import { StatusBar } from './status-bar';
import { maybePromptResume } from './toast';
import { TerminalTracker } from './terminal-tracker';
import { registerLongRunNotifier } from './long-run-notifier';
import { maybeOfferRestore } from './restore';
import { ClaudeTracker } from './claude-tracker';
import { AgentRegistry } from './agents/registry';
import { ClaudeSearchIndex } from './claude-search';
import { resolveTmuxNameForTerminalLive } from './profile-provider';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';
import { registerRevealPath } from './reveal-path';
import { registerTerminalLinks } from './terminal-links';
import { registerClipboardBridge } from './clipboard-bridge';
import { maybeWarnMouseEnv } from './mouse-clicks-guard';
import { registerTabState } from './tab-state';

// Note: tmux.conf is bootstrapped lazily by tmux.ensureConf() when the first
// session starts. No need to pre-seed from the extension bundle.

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  // Bake the user's NO_FLICKER preference into tmux.conf generation up front,
  // before any session (and thus ensureConf) can write the file.
  const tmuxMod = await import('./tmux');
  tmuxMod.setNoFlicker(getConfig().claudeNoFlicker);
  // Remote-SSH/WSL/Container: force tmux copy over OSC 52 (a local clipboard tool on
  // the remote can't reach the user's local clipboard). Set before ensureConf runs.
  tmuxMod.setRemoteHost(!!vscode.env.remoteName);

  const index = new SessionIndex();
  // Self-heal branch sets orphaned by a Kill (or any past path) that left a lone
  // survivor still linked — otherwise it stays chip-colored with no peer.
  index.pruneOrphanedBranchSets();
  const registry = new AgentRegistry();
  const claudeTracker = new ClaudeTracker(ctx, registry, index);
  claudeTracker.start();
  ctx.subscriptions.push({ dispose: () => claudeTracker.dispose() });

  const searchIndex = new ClaudeSearchIndex();
  void searchIndex.load().then(() => searchIndex.refresh());

  ctx.subscriptions.push(registerPersistentProfile(index));
  registerCommands(ctx, index, claudeTracker, searchIndex, registry);
  // Seed the tab-menu Kill ↔ locked-hint gate for whatever terminal is active
  // at startup (the key is falsy/Kill-shown until the first terminal switch).
  void syncActiveTerminalContext(index);
  registerRevealPath(ctx);
  registerTerminalLinks(ctx);
  // Remote-SSH only: mirror tmux copies to the local clipboard with correct UTF-8
  // (bypasses the OSC 52 path Cursor mangles). No-op on local hosts.
  registerClipboardBridge(ctx);
  registerSidebar(ctx, index, claudeTracker);
  // Agent state (running / finished / blocked / failed) in the NATIVE terminal tab
  // description. On by default, but silent until `${sequence}` is in the user's
  // tab-description template (offered once).
  registerTabState(ctx, claudeTracker);

  // Prompt once to install hooks for the enabled agents (remembers declination).
  void maybePromptInstallClaudeHook(ctx, registry);
  // Leftover CLAUDE_CODE_DISABLE_MOUSE_CLICKS (rc export / old tmux server env /
  // settings.json env) kills drag-select and clicks inside Claude. Offer a fix once;
  // delayed so it doesn't fight the restore/hook toasts.
  setTimeout(async () => {
    const tmuxPath = await tmuxMod.detectTmuxPath(getConfig().tmuxPath);
    void maybeWarnMouseEnv(ctx, tmuxPath);
  }, 8000);

  const statusBar = new StatusBar(index);
  statusBar.start();
  ctx.subscriptions.push({ dispose: () => statusBar.stop() });

  const tracker = new TerminalTracker(index);
  tracker.start();
  ctx.subscriptions.push(tracker);

  registerLongRunNotifier(ctx);

  // Monotonic token for the async active-terminal resolution below: a slow
  // PID walk for a tab you already left must not clobber the newer result
  // (the tracker's "which tab is the user looking at" depends on it).
  let activeResolveGen = 0;
  ctx.subscriptions.push(
    vscode.window.onDidCloseTerminal(() => refreshSidebar()),
    vscode.window.onDidOpenTerminal(() => refreshSidebar()),
    vscode.window.onDidChangeActiveTerminal(t => {
      const gen = ++activeResolveGen;
      // Reflect the new active terminal's lock state for the native tab menu's
      // Kill ↔ locked-hint gate. Runs on every switch (incl. t === undefined,
      // which sets the key false); does its own resolve, independent of the MRU
      // logic below.
      void syncActiveTerminalContext(index);
      if (!t) { claudeTracker.setActiveTmuxSession(undefined); return; }
      void (async () => {
        // Robust to reload-restored (⚠) tabs (trimmed shellArgs) AND renamed
        // tabs (no #tabId in the label) — falls back to the live process via PID.
        const name = await resolveTmuxNameForTerminalLive(t, index, getConfig().sessionPrefix);
        if (gen !== activeResolveGen) return; // superseded by a newer tab switch
        if (!name) { claudeTracker.setActiveTmuxSession(undefined); return; }
        // Focusing the tab "reads" its unread result.
        claudeTracker.setActiveTmuxSession(name);
        const parsed = parseSessionName(name, getConfig().sessionPrefix);
        if (!parsed) return;
        index.setSessionLastActive(parsed.hash, name);
        if (getConfig().sidebarSortMode === 'mru') refreshSidebar();
        // Highlight the matching session in our sidebar so it's easy to locate
        // when you have many terminal tabs open — but ONLY if it's already
        // visible. Never expand a collapsed group/master or scroll to a hidden
        // row on a plain tab switch; that jump is reserved for the explicit
        // right-click "Reveal in Terminal Sessions View" command (expand=true).
        // Opt-out via terminalSessions.revealActiveSession (some users find the
        // selection jumping around on every tab switch distracting — see #1).
        if (getConfig().revealActiveSession) void revealSessionInSidebar(name, false, false);
      })();
    }),
    // Coming back to the window while a finished session's tab is active counts
    // as looking at it.
    vscode.window.onDidChangeWindowState(s => { if (s.focused) claudeTracker.onWindowFocused(); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('terminalSessions.sidebarSortMode') ||
        e.affectsConfiguration('terminalSessions.claudeSidebarDetails') ||
        e.affectsConfiguration('terminalSessions.activityLimit') ||
        e.affectsConfiguration('terminalSessions.killedLimit')
      ) refreshSidebar();
      // Settings-UI edits must move the ⋯-menu Enable/Disable labels too, not
      // just our own toggle commands.
      if (
        e.affectsConfiguration('terminalSessions.showFavoritesFolder') ||
        e.affectsConfiguration('terminalSessions.showOpenFolder') ||
        e.affectsConfiguration('terminalSessions.showBackgroundFolder') ||
        e.affectsConfiguration('terminalSessions.showActivityFolder') ||
        e.affectsConfiguration('terminalSessions.showKilledFolder') ||
        e.affectsConfiguration('terminalSessions.tabStateText') ||
        e.affectsConfiguration('terminalSessions.tabStateClear')
      ) { void syncSpecialFolderContexts(); refreshSidebar(); }
      if (e.affectsConfiguration('terminalSessions.claudeNoFlicker')) {
        void applyNoFlickerChange();
      }
      // Drop the cached tmux path so a corrected terminalSessions.tmuxPath takes
      // effect immediately instead of only after a window reload.
      if (e.affectsConfiguration('terminalSessions.tmuxPath')) {
        void import('./tmux').then(m => m.clearTmuxPathCache());
      }
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

// Regenerate + reload tmux.conf so a flipped terminalSessions.claudeNoFlicker
// takes effect on the live server (and unsets the env when turned off). Already-
// running Claude processes still need a Restart to pick up the renderer change.
async function applyNoFlickerChange(): Promise<void> {
  const { setNoFlicker, setRemoteHost, regenerateConf, detectTmuxPath, reloadConfig } = await import('./tmux');
  const cfg = getConfig();
  setNoFlicker(cfg.claudeNoFlicker);
  setRemoteHost(!!vscode.env.remoteName);
  regenerateConf();
  const tmuxPath = await detectTmuxPath(cfg.tmuxPath);
  if (tmuxPath) {
    try { await reloadConfig(tmuxPath); } catch { /* no server running yet */ }
  }
  vscode.window.showInformationMessage(
    `Claude no-flicker ${cfg.claudeNoFlicker ? 'enabled' : 'disabled'}. `
    + 'Restart any running Claude session (sidebar → Restart) to apply the renderer change.',
  );
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
  const { isConfOutOfDate, regenerateConf, detectTmuxPath, reloadConfig } = await import('./tmux');
  if (!isConfOutOfDate()) return;
  // Bump this key whenever the conf gains a fix worth re-prompting dismissed
  // users for (here: v17 unsets CLAUDE_CODE_DISABLE_MOUSE_CLICKS on the server).
  const KEY = 'tmuxConfUpgradeDismissed-v17';
  if (ctx.globalState.get(KEY)) return;
  setTimeout(async () => {
    const choice = await vscode.window.showInformationMessage(
      'Your Terminal Sessions tmux.conf can be updated: v17 clears a leftover '
      + 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS from the tmux server (older versions set it; '
      + 'it makes Claude Code ignore clicks and drag-select). Update now? A backup is '
      + 'saved next to the current file and it applies to live sessions immediately.',
      'Update', 'Not now', "Don't ask again",
    );
    if (choice === 'Update') {
      const backup = regenerateConf();
      // Apply to the running tmux server too, so existing sessions get the new
      // bindings without a manual "Reload tmux Config".
      const tmuxPath = await detectTmuxPath(getConfig().tmuxPath);
      if (tmuxPath) { try { await reloadConfig(tmuxPath); } catch { /* no server yet */ } }
      const msg = backup
        ? `tmux.conf updated and reloaded. Previous version backed up at ${backup}.`
        : 'Could not update tmux.conf (permissions?). Check ~/.terminal-sessions/tmux.conf.';
      vscode.window.showInformationMessage(msg);
    } else if (choice === "Don't ask again") {
      await ctx.globalState.update(KEY, true);
    }
  }, 6000);
}

export function deactivate(): void { /* handled via ctx.subscriptions */ }
