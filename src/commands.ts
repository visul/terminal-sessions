import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND, getConfig, setSortMode, setFilterMode, SidebarSortMode, SidebarFilterMode, SORT_MODES } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';
import { openTerminalForSession, findTerminalForSession, metaIconAndColor, sessionNameForTerminal, resolveTmuxNameForTerminalLive, nextSafeTabId } from './profile-provider';
import { currentWorkspace, hashPath, sessionName as buildSessionName, parseSessionName } from './workspace-id';
import { SessionTreeItem, SubagentTreeItem, GroupTreeItem, WorkspaceTreeItem, KilledSessionItem } from './sidebar/items';
import { refreshSidebar, collapseAllSessions, revealSessionInSidebar, setSidebarTextFilter, getSidebarTextFilter } from './sidebar/tree-provider';
import { SessionInfo } from './types';
import { humanAge, sleep } from './util';
import { maybeOfferRestore } from './restore';
import { notify } from './notifications';
import { conversationTitle } from './conversation-title';
import { maybeWarnMouseEnv, findMouseEnvLines, commentOutMouseEnv } from './mouse-clicks-guard';
import { ClaudeTracker } from './claude-tracker';
import { ClaudeSearchIndex, SessionIndexEntry } from './claude-search';
import { transcriptPathFor, findTranscriptBySessionId, readTranscriptCwd, readTranscriptSummary, writeClaudeCustomTitle } from './claude-transcript';
import { transcriptToMarkdown } from './transcript-render';
import { scanArchive, ArchivedSession, classifyForCleanup, softDeleteSession } from './archive';
import { planTrash, executeTrash, formatBytes } from './trash';
import { AgentRegistry, isForkableAgent, yoloSpecFor, yoloFlagsFor } from './agents/registry';
import { isYolo, setYolo } from './agents/launch-flags';
import { readClaudeCleanupDays, setClaudeCleanupDays, snoozeCleanupNotice, countExpiringTranscripts, clearExpiryCache, KEEP_FOREVER_DAYS } from './notices';
import type { AgentProvider, AgentId } from './agents/types';

/** Delay between opening the attached terminal and sending `claude --resume`,
 *  giving the shell time to finish rc/zshrc init. Heavy zsh setups (oh-my-zsh,
 *  starship, nvm autoload) need > 1 s before sendText lands in a prompt that
 *  actually reads it. */
const SHELL_INIT_DELAY_MS = 1500;

/**
 * Build the `claude --resume <id>` command, prepending `cd <cwd> && ` when the
 * transcript was written from a cwd that differs from the terminal's launch
 * directory. `claude --resume` only finds the conversation if invoked from the
 * SAME project (= same cwd-slug) it was originally launched from, so a session
 * recorded in `__DPF_DB/_Categories` cannot be resumed from `__DPF_DB`.
 */
function buildResumeCommand(
  provider: AgentProvider,
  sessionId: string,
  transcriptPath: string | undefined,
  terminalCwd: string,
  extraFlags?: readonly string[],
): string {
  // The provider owns its resume syntax (`claude --resume`, `codex resume`,
  // `agy --conversation`), whether it needs a `cd` to the recorded cwd, and how
  // to re-apply the captured launch flags (filtering out dead path flags).
  return provider.buildResumeCommand(sessionId, terminalCwd, transcriptPath, extraFlags);
}

/** A history sessionId with everything needed to rank it as resume candidate. */
interface ResumeCandidate {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  firstUserMessage?: string;
  customTitle?: string;
  autoTitle?: string;
  lineCount: number;
  byteSize: number;
  mtimeMs: number;
}

/** Brief-touch threshold. A transcript under this many bytes is almost
 *  certainly a fired-and-cancelled session — open `claude --resume <X>`,
 *  see context, immediately Esc. Skip it from auto-resume so it doesn't
 *  shadow a real conversation deeper in history. The picker still shows it. */
const BRIEF_TOUCH_BYTES = 5 * 1024;

/** Walk every dedup'd candidate sessionId (live → lastClaudeSessionId →
 *  full claudeSessionHistory) and return rich summaries for those with a
 *  transcript on disk. Sort order is unchanged (most-recent-first by
 *  history position); callers apply their own ranking on top.
 */
function gatherResumeCandidates(
  provider: AgentProvider,
  history: string[],
  cwd: string,
): ResumeCandidate[] {
  const seen = new Set<string>();
  const out: ResumeCandidate[] = [];
  for (const sid of history) {
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const tp = provider.resolveTranscriptPath(sid, cwd, undefined);
    if (!tp || !fs.existsSync(tp)) continue;
    const summary = provider.readTranscriptSummary?.(tp);
    let byteSize = summary?.byteSize ?? 0;
    let mtimeMs = summary?.mtimeMs ?? 0;
    if (!byteSize) {
      try { const st = fs.statSync(tp); byteSize = st.size; mtimeMs = st.mtimeMs; }
      catch { continue; }
    }
    out.push({
      sessionId: sid,
      transcriptPath: tp,
      cwd: summary?.cwd,
      firstUserMessage: summary?.firstUserMessage,
      customTitle: summary?.customTitle,
      autoTitle: summary?.autoTitle,
      lineCount: summary?.lineCount ?? 0,
      byteSize,
      mtimeMs,
    });
  }
  return out;
}

/** Resolve the provider + ordered session-id history for resuming the agent
 *  that last ran in a tmux session (live id first, then recorded history). */
function resumeContextFor(
  index: SessionIndex,
  registry: AgentRegistry,
  tracker: ClaudeTracker,
  hash: string,
  name: string,
): { provider: AgentProvider; history: string[] } {
  const agent = tracker.getAgent(name) ?? index.getLastAgent(hash, name);
  const provider = registry.providerForAgent(agent);
  const live = tracker.getSessionId(name);
  const recorded = index.getAgentSessionHistory(hash, name, agent);
  const seen = new Set<string>();
  const history: string[] = [];
  for (const id of [live, ...recorded]) {
    if (id && !seen.has(id)) { seen.add(id); history.push(id); }
  }
  return { provider, history };
}

/** True when `child` is the same dir as `parent` or a descendant of it.
 *  Both paths must be absolute and already normalized (no `..`). */
function isCwdUnder(parent: string, child: string | undefined): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const p = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(p);
}

/**
 * Pick the best sessionId to auto-resume for a tmux session. Walks every
 * candidate (live + lastClaudeSessionId + full claudeSessionHistory) and
 * applies two filters that the naive head-first walk missed:
 *
 *   1. **cwd subset filter** — drop any candidate whose transcript cwd is
 *      outside the tmux session's folderPath (or workspace root if no
 *      folderPath). Otherwise a brief `claude --resume <id>` glance at a
 *      foreign session pollutes the history and gets picked over the real
 *      conversation.
 *   2. **history order** — among the survivors, keep the order from the
 *      history (live/running conversation first, then the most-recently-
 *      recorded one for this pane). The substantial-bytes filter already
 *      drops tiny "open then Esc" glances, so we never override the
 *      conversation the pane is actually on with a larger sibling.
 *
 * Brief touches under BRIEF_TOUCH_BYTES are dropped from auto-resume entirely.
 * They're still visible in the manual "Resume Other Claude Session..." picker.
 *
 * Falls back to the first transcript-on-disk candidate (head-first) if every
 * candidate fails the cwd filter — better to resume *something* than nothing,
 * and the user can always switch to a different one via the picker.
 */
function resolveResumeFromHistory(
  provider: AgentProvider,
  history: string[],
  cwd: string,
  workspacePath?: string,
): { sessionId: string; transcriptPath: string } | undefined {
  const candidates = gatherResumeCandidates(provider, history, cwd);
  if (candidates.length === 0) return undefined;

  // Anchor the cwd-subset check at the most-specific known folder for this
  // tmux. Sessions launched in a subfolder of the workspace pass the check;
  // sessions launched in an unrelated workspace (e.g. polluted history from a
  // brief cross-workspace resume) are rejected.
  const anchor = cwd || workspacePath || '';
  const inScope = candidates.filter(c => isCwdUnder(anchor, c.cwd));
  const substantial = inScope.filter(c => c.byteSize >= BRIEF_TOUCH_BYTES);

  // Pool: substantial in-scope > any in-scope > unknown-cwd fallback.
  let pool: ResumeCandidate[];
  if (substantial.length > 0) pool = substantial;
  else if (inScope.length > 0) pool = inScope;
  else {
    // Nothing sits under this tmux session's folder. NEVER fall back to a
    // candidate whose transcript cwd is KNOWN to be a different workspace — that
    // is polluted history (a brief cross-workspace `claude --resume` glance, or a
    // stale/mis-attributed head), and resuming it drops a stranger's conversation
    // into this pane. That is the "restart resumed the wrong session" bug. Only
    // rescue candidates whose cwd could not be read at all (legit-but-unreadable,
    // e.g. a summary-only transcript); otherwise resume nothing and leave a clean
    // shell — the user can pick the right one via "Resume Other Session…".
    const unknownCwd = candidates.filter(c => !c.cwd);
    if (unknownCwd.length === 0) return undefined;
    pool = unknownCwd;
  }

  // Keep HISTORY ORDER — the conversation actually running in this pane (the
  // live tracker id, which gatherResumeCandidates puts first) or, failing that,
  // the most recently recorded one for this pane. Do NOT sort by size: a larger
  // sibling conversation in the same folder must not be resumed instead of the
  // one the pane is actually on. The substantial-bytes filter above already
  // drops tiny "open then Esc" glances.
  return { sessionId: pool[0].sessionId, transcriptPath: pool[0].transcriptPath };
}

async function requireTmux(): Promise<string | undefined> {
  const cfg = getConfig();
  const p = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!p) {
    vscode.window.showErrorMessage('tmux is not installed. Run: brew install tmux');
    return undefined;
  }
  return p;
}

export function registerCommands(
  ctx: vscode.ExtensionContext,
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  searchIndex: ClaudeSearchIndex,
  registry: AgentRegistry,
): void {
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(CONVERSATION_SCHEME, conversationDocProvider),
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.newPersistent, () => cmdNewPersistent(index)),
    vscode.commands.registerCommand(COMMAND.newPersistentInFolder, (uri?: vscode.Uri) => cmdNewPersistent(index, uri)),
    vscode.commands.registerCommand(COMMAND.attachTo, (item?: SessionTreeItem) => cmdAttachTo(index, item)),
    vscode.commands.registerCommand(COMMAND.kill, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      return many ? cmdKillMany(index, many) : cmdKill(index, item);
    }),
    vscode.commands.registerCommand(COMMAND.killDelete, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      return many
        ? cmdKillDeleteMany(index, claudeTracker, registry, many)
        : cmdKillDelete(index, claudeTracker, registry, item);
    }),
    vscode.commands.registerCommand(COMMAND.killWorkspace, () => cmdKillWorkspace(index)),
    vscode.commands.registerCommand(COMMAND.killAllStale, () => cmdKillStale(index)),
    vscode.commands.registerCommand(COMMAND.rename, (item?: SessionTreeItem) => cmdRename(index, item)),
    vscode.commands.registerCommand(COMMAND.refreshSidebar, () => refreshSidebar()),
    vscode.commands.registerCommand(COMMAND.revealSidebar,
      // <viewId>.focus reveals the view wherever the user has placed it (Explorer
      // by default, or a container they've dragged it to) — the old
      // workbench.view.extension.<container> id no longer exists now that the
      // view is contributed to the built-in Explorer container.
      () => vscode.commands.executeCommand('terminalSessions.sessions.focus')),
    vscode.commands.registerCommand(COMMAND.resumeAll, () => cmdResumeAll(index)),
    vscode.commands.registerCommand(COMMAND.setAsDefaultProfile, () => cmdSetDefaultProfile()),
    vscode.commands.registerCommand(COMMAND.openTmuxConfig, () => cmdOpenTmuxConfig()),
    vscode.commands.registerCommand(COMMAND.reloadTmuxConfig, () => cmdReloadTmuxConfig()),
    vscode.commands.registerCommand(COMMAND.setIcon, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => cmdSetIcon(index, item, selection)),
    vscode.commands.registerCommand(COMMAND.setColor, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => cmdSetColor(index, item, selection)),
    vscode.commands.registerCommand(COMMAND.restoreFromIndex, () => cmdRestoreFromIndex(index, registry, claudeTracker)),
    vscode.commands.registerCommand(COMMAND.testNotification, () => cmdTestNotification()),
    vscode.commands.registerCommand(COMMAND.installClaudeHook, () => cmdInstallClaudeHook(claudeTracker)),
    vscode.commands.registerCommand(COMMAND.uninstallClaudeHook, () => cmdUninstallClaudeHook(registry)),
    vscode.commands.registerCommand(COMMAND.restart, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      return many ? cmdRestartMany(index, registry, claudeTracker, many) : cmdRestart(index, registry, claudeTracker, item);
    }),
    vscode.commands.registerCommand(COMMAND.switchToYolo, async (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      // Bulk YOLO stays deliberately per-session: each row runs the full
      // single-session flow with its own confirmation — auto-approve is too
      // sharp for one blanket "yes" over N sessions.
      const many = selectionTargets(selection);
      if (!many) return cmdSwitchYolo(index, registry, claudeTracker, true, item);
      // eslint-disable-next-line no-await-in-loop
      for (const r of many) await cmdSwitchYolo(index, registry, claudeTracker, true, r);
    }),
    vscode.commands.registerCommand(COMMAND.switchToNormal, async (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      if (!many) return cmdSwitchYolo(index, registry, claudeTracker, false, item);
      // eslint-disable-next-line no-await-in-loop
      for (const r of many) await cmdSwitchYolo(index, registry, claudeTracker, false, r);
    }),
    vscode.commands.registerCommand(COMMAND.toggleYolo, (item?: SessionTreeItem | vscode.Terminal) => cmdSwitchYolo(index, registry, claudeTracker, undefined, item)),
    vscode.commands.registerCommand(COMMAND.stop, async (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      if (!many) return cmdStop(index, claudeTracker, item);
      for (const r of many) {
        if (r.session.stopped) continue;
        // eslint-disable-next-line no-await-in-loop
        await cmdStop(index, claudeTracker, r);
      }
    }),
    vscode.commands.registerCommand(COMMAND.forkConversation, (item?: SessionTreeItem | vscode.Terminal) => cmdForkConversation(index, registry, claudeTracker, item)),
    vscode.commands.registerCommand(COMMAND.unlinkBranch, (item?: SessionTreeItem) => cmdUnlinkBranch(index, item)),
    vscode.commands.registerCommand(COMMAND.start, async (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      if (!many) return cmdStart(index, registry, claudeTracker, item);
      for (const r of many) {
        if (!r.session.stopped) continue;
        // eslint-disable-next-line no-await-in-loop
        await cmdStart(index, registry, claudeTracker, r);
      }
    }),
    vscode.commands.registerCommand(COMMAND.pickSortMode, () => cmdPickSortMode(index)),
    vscode.commands.registerCommand(COMMAND.pickFilterMode, () => cmdPickFilterMode()),
    vscode.commands.registerCommand(COMMAND.findSession, () => cmdFindSession(index, searchIndex)),
    vscode.commands.registerCommand(COMMAND.searchSessions, () => cmdSearchSessions(index, registry, claudeTracker)),
    vscode.commands.registerCommand(COMMAND.filterSessions, () => cmdFilterSessions()),
    vscode.commands.registerCommand(COMMAND.clearSidebarTextFilter, () => setSidebarTextFilter(undefined)),
    vscode.commands.registerCommand(COMMAND.fixTranscriptCleanup, () => cmdFixTranscriptCleanup()),
    vscode.commands.registerCommand(COMMAND.dismissCleanupNotice, () => { snoozeCleanupNotice(); refreshSidebar(); }),
    vscode.commands.registerCommand(COMMAND.fixClaudeRendering, () => cmdFixClaudeRendering()),
    vscode.commands.registerCommand(COMMAND.fixClaudeMouseEnv, () => cmdFixClaudeMouseEnv(ctx)),
    vscode.commands.registerCommand(COMMAND.toggleAllAlerts, () => cmdSetAllAlerts()),
    vscode.commands.registerCommand(COMMAND.alertsEnable, () => cmdSetAllAlerts(true)),
    vscode.commands.registerCommand(COMMAND.alertsDisable, () => cmdSetAllAlerts(false)),
    vscode.commands.registerCommand(COMMAND.muteSession, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => cmdSetSessionMuted(index, item, selection, true)),
    vscode.commands.registerCommand(COMMAND.unmuteSession, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => cmdSetSessionMuted(index, item, selection, false)),
    vscode.commands.registerCommand(COMMAND.dismissAttention, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => {
      // Works from any row (incl. mirror rows in the pinned folders) and in bulk.
      const rows = selectionTargets(selection) ?? (item ? [item] : []);
      if (rows.length === 0) {
        vscode.window.showErrorMessage('Use the sidebar context menu on a session.');
        return;
      }
      for (const r of rows) claudeTracker.dismiss(r.session.name);
      refreshSidebar();
    }),
    vscode.commands.registerCommand(COMMAND.markAllSeen, () => {
      const n = claudeTracker.markAllSeen();
      refreshSidebar();
      vscode.window.showInformationMessage(n ? `${n} session${n === 1 ? '' : 's'} marked as seen.` : 'No unread sessions.');
    }),
    vscode.commands.registerCommand(COMMAND.favoriteOn, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => cmdSetSessionFavorite(index, item, selection, true)),
    vscode.commands.registerCommand(COMMAND.favoriteOff, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => cmdSetSessionFavorite(index, item, selection, false)),
    vscode.commands.registerCommand(COMMAND.toggleFavorite, (item?: SessionTreeItem | vscode.Terminal) => cmdToggleFavorite(index, item)),
    vscode.commands.registerCommand(COMMAND.lockSession, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      if (!many) return cmdSetSessionLocked(index, item, true);
      bulkApply(many, (hash, name) => index.setSessionLocked(hash, name, true), n => `${n} sessions locked (protected from Kill).`);
    }),
    vscode.commands.registerCommand(COMMAND.unlockSession, (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => {
      const many = selectionTargets(selection);
      if (!many) return cmdSetSessionLocked(index, item, false);
      bulkApply(many, (hash, name) => index.setSessionLocked(hash, name, false), n => `${n} sessions unlocked.`);
    }),
    vscode.commands.registerCommand(COMMAND.lockedHint, (item?: SessionTreeItem) => cmdLockedHint(item)),
    vscode.commands.registerCommand(COMMAND.openSubagentTranscript, (item?: SubagentTreeItem) => cmdOpenSubagentTranscript(item)),
    vscode.commands.registerCommand(COMMAND.viewConversation, (arg?: SessionTreeItem | vscode.Terminal | { transcriptPath: string; title?: string }) => cmdViewConversation(index, registry, claudeTracker, arg)),
    vscode.commands.registerCommand(COMMAND.nameSession, (arg?: SessionTreeItem | vscode.Terminal | { sessionId: string; current?: string; transcriptPath?: string; agent?: AgentId }) => cmdNameSession(index, registry, claudeTracker, arg)),
    vscode.commands.registerCommand(COMMAND.toggleShowCompletedSubagents, () => cmdToggleShowCompletedSubagents()),
    vscode.commands.registerCommand(COMMAND.collapseSessions, () => collapseAllSessions()),
    vscode.commands.registerCommand(COMMAND.reattachAll, () => cmdReattachAll(index, registry, claudeTracker)),
    vscode.commands.registerCommand(COMMAND.newGroup, (item?: WorkspaceTreeItem | GroupTreeItem) => cmdNewGroup(index, item)),
    vscode.commands.registerCommand(COMMAND.newMasterGroup, (item?: WorkspaceTreeItem | GroupTreeItem) => cmdNewMasterGroup(index, item)),
    vscode.commands.registerCommand(COMMAND.moveGroupToMaster, (item?: GroupTreeItem) => cmdMoveGroupToMaster(index, item)),
    vscode.commands.registerCommand(COMMAND.renameGroup, (item?: GroupTreeItem) => cmdRenameGroup(index, item)),
    vscode.commands.registerCommand(COMMAND.deleteGroup, (item?: GroupTreeItem) => cmdDeleteGroup(index, item)),
    vscode.commands.registerCommand(COMMAND.setGroupColor, (item?: GroupTreeItem) => cmdSetGroupColor(index, item)),
    vscode.commands.registerCommand(COMMAND.moveSessionToGroup, (item?: SessionTreeItem, selection?: vscode.TreeItem[]) => cmdMoveSessionToGroup(index, item, selection)),
    vscode.commands.registerCommand(COMMAND.resumeOtherClaude, (item?: SessionTreeItem) => cmdResumeOtherClaude(index, registry, claudeTracker, item)),
    vscode.commands.registerCommand(COMMAND.resumeFromArchive, () => cmdResumeFromArchive(index, registry)),
    vscode.commands.registerCommand(COMMAND.cleanupSessions, () => cmdCleanupSessions(index, registry)),
    vscode.commands.registerCommand(COMMAND.revealSessionFolder, (arg?: unknown) => cmdRevealSessionFolder(index, 'explorer', arg)),
    vscode.commands.registerCommand(COMMAND.revealSessionFolderFinder, (arg?: unknown) => cmdRevealSessionFolder(index, 'finder', arg)),
    vscode.commands.registerCommand(COMMAND.copySessionId, (item?: SessionTreeItem | vscode.Terminal) => cmdCopySessionId(index, item)),
    vscode.commands.registerCommand(COMMAND.copySessionPath, (item?: SessionTreeItem | vscode.Terminal) => cmdCopySessionPath(index, registry, item)),
    vscode.commands.registerCommand(COMMAND.revealSessionInSidebar, (arg?: unknown) => cmdRevealSessionInSidebar(index, arg)),
    vscode.commands.registerCommand(COMMAND.enableFavoritesFolder, () => cmdSetSpecialFolder('showFavoritesFolder', true)),
    vscode.commands.registerCommand(COMMAND.disableFavoritesFolder, () => cmdSetSpecialFolder('showFavoritesFolder', false)),
    vscode.commands.registerCommand(COMMAND.enableOpenFolder, () => cmdSetSpecialFolder('showOpenFolder', true)),
    vscode.commands.registerCommand(COMMAND.disableOpenFolder, () => cmdSetSpecialFolder('showOpenFolder', false)),
    vscode.commands.registerCommand(COMMAND.enableBackgroundFolder, () => cmdSetSpecialFolder('showBackgroundFolder', true)),
    vscode.commands.registerCommand(COMMAND.disableBackgroundFolder, () => cmdSetSpecialFolder('showBackgroundFolder', false)),
    vscode.commands.registerCommand(COMMAND.enableActivityFolder, () => cmdSetSpecialFolder('showActivityFolder', true)),
    vscode.commands.registerCommand(COMMAND.disableActivityFolder, () => cmdSetSpecialFolder('showActivityFolder', false)),
    vscode.commands.registerCommand(COMMAND.enableKilledFolder, () => cmdSetSpecialFolder('showKilledFolder', true)),
    vscode.commands.registerCommand(COMMAND.disableKilledFolder, () => cmdSetSpecialFolder('showKilledFolder', false)),
    vscode.commands.registerCommand(COMMAND.restoreKilled, (item?: KilledSessionItem) => cmdRestoreKilled(index, registry, claudeTracker, item)),
  );
  // Seed the ⋯-menu Enable/Disable labels for the two special folders.
  void syncSpecialFolderContexts();

  // Keep a VS Code context var in sync with the global alert setting so the
  // view-title icon can toggle its appearance via "when" clauses.
  const syncAlertsContext = () => {
    const on = vscode.workspace.getConfiguration('terminalSessions').get<boolean>('notifyOnClaudeWaiting', true);
    void vscode.commands.executeCommand('setContext', 'terminalSessions.alertsEnabled', on);
  };
  syncAlertsContext();
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('terminalSessions.notifyOnClaudeWaiting')) syncAlertsContext();
  }));
}

async function cmdSetAllAlerts(value?: boolean): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  const current = c.get<boolean>('notifyOnClaudeWaiting', true);
  const next = value === undefined ? !current : value;
  if (next === current) return;
  await c.update('notifyOnClaudeWaiting', next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Claude waiting alerts ${next ? 'enabled' : 'disabled'} globally.`,
  );
}

/**
 * Open a readable Markdown rendering of a conversation in VS Code's preview.
 * Two entry shapes:
 *   - a SessionTreeItem (live session right-click) → resolve its current agent's
 *     newest transcript via the resume context;
 *   - { transcriptPath, title } (from the archive picker's eye button).
 */
// Read-only virtual documents for rendered conversation transcripts, so
// "View Conversation" opens a Markdown preview with a meaningful tab title
// ("Preview <conversation>") instead of "Untitled-N", and never prompts to save.
const CONVERSATION_SCHEME = 'ts-conversation';

class ConversationDocProvider implements vscode.TextDocumentContentProvider {
  private static readonly MAX_DOCS = 12;
  private readonly docs = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '_No content._';
  }
  set(uri: vscode.Uri, content: string): void {
    // Bounded LRU: a long-lived window that previews many conversations (the
    // archive picker's eye button renders one per row) used to pin every rendered
    // transcript — tens/hundreds of MB — in extension-host memory forever. Keep
    // only the most recent MAX_DOCS; re-set moves a key to newest.
    const key = uri.toString();
    this.docs.delete(key);
    this.docs.set(key, content);
    while (this.docs.size > ConversationDocProvider.MAX_DOCS) {
      const oldest = this.docs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
    this._onDidChange.fire(uri);
  }
}

const conversationDocProvider = new ConversationDocProvider();

async function cmdViewConversation(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  arg?: SessionTreeItem | vscode.Terminal | { transcriptPath: string; title?: string },
): Promise<void> {
  let transcriptPath: string | undefined;
  let title: string | undefined;

  // A sidebar row or a terminal tab resolves to its session; the archive picker
  // passes the transcript directly.
  const session = arg && 'transcriptPath' in arg
    ? undefined
    : await resolveSessionInfoFromInvocation(arg as SessionTreeItem | vscode.Terminal | undefined, index);
  if (arg && 'transcriptPath' in arg) {
    transcriptPath = arg.transcriptPath;
    title = arg.title;
  } else if (session) {
    const { provider, history } =
      resumeContextFor(index, registry, claudeTracker, session.workspaceHash, session.name);
    const cwd = index.getSessionMeta(session.workspaceHash, session.name)?.folderPath
      || session.workspacePath || '';
    // Walk the history (live/running first, then most-recently-recorded for this
    // pane), with the same cwd + transcript-on-disk filters as resume, so a
    // stopped session — or one whose head id was pruned — still resolves to the
    // right transcript on disk.
    const resolved = resolveResumeFromHistory(provider, history, cwd, session.workspacePath);
    if (resolved) {
      transcriptPath = resolved.transcriptPath;
      const summary = provider.readTranscriptSummary?.(resolved.transcriptPath);
      title = conversationTitle(
        { sessionId: resolved.sessionId, customTitle: summary?.customTitle, autoTitle: summary?.autoTitle },
        id => index.getSessionName(id),
      ).title || session.label || session.name;
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    vscode.window.showInformationMessage('No conversation transcript found for this session yet.');
    return;
  }

  try {
    const md = transcriptToMarkdown(transcriptPath, { title });
    // Read-only virtual doc → preview tab reads "Preview <conversation>" (not
    // "Untitled-N") and never prompts to save. The .md path drives markdown mode.
    const safe = (title || 'Conversation').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
    const base = transcriptPath.split('/').pop() || '';
    const sid = /^([0-9a-fA-F]{8})/.exec(base)?.[1] ?? '';
    const uri = vscode.Uri.from({ scheme: CONVERSATION_SCHEME, path: `/${safe}${sid ? ` (${sid})` : ''}.md` });
    conversationDocProvider.set(uri, md);
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch (e) {
    // Fall back to the raw file so the user still sees something.
    vscode.window.showWarningMessage(`Render failed (${String(e).slice(0, 120)}); opening raw transcript.`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(transcriptPath));
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Rename a conversation. The name goes to the extension's sidecar map (any agent)
 * AND, for Claude, to Claude's own `<id>/custom-title.json` — the file `/rename`
 * writes and `claude --resume` reads — so the two stay one name. Empty input
 * clears both. Accepts a sidebar row, a terminal tab, or an explicit
 * { sessionId, current, transcriptPath, agent } from the archive picker.
 * Returns the saved name (undefined when cleared/cancelled).
 */
async function cmdNameSession(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  arg?: SessionTreeItem | vscode.Terminal | { sessionId: string; current?: string; transcriptPath?: string; agent?: AgentId },
): Promise<string | undefined> {
  let sessionId: string | undefined;
  let current: string | undefined;
  let transcriptPath: string | undefined;
  let agent: AgentId | undefined;

  if (arg && 'sessionId' in arg) {
    sessionId = arg.sessionId;
    current = arg.current;
    transcriptPath = arg.transcriptPath;
    agent = arg.agent;
  } else {
    const session = await resolveSessionInfoFromInvocation(arg as SessionTreeItem | vscode.Terminal | undefined, index);
    if (session) {
      const { provider, history } =
        resumeContextFor(index, registry, claudeTracker, session.workspaceHash, session.name);
      const cwd = index.getSessionMeta(session.workspaceHash, session.name)?.folderPath
        || session.workspacePath || '';
      const resolved = resolveResumeFromHistory(provider, history, cwd, session.workspacePath);
      sessionId = resolved?.sessionId ?? history[0];
      transcriptPath = resolved?.transcriptPath;
      agent = provider.id;
    }
  }

  if (!sessionId) {
    vscode.window.showInformationMessage('No agent session id to name yet (run the agent once first).');
    return undefined;
  }

  // Prefill with what the user currently sees for this conversation (a native
  // /rename title first), so "rename" edits the visible name rather than a blank.
  if (current === undefined) {
    const summary = transcriptPath && agent
      ? registry.getProvider(agent)?.readTranscriptSummary?.(transcriptPath)
      : undefined;
    current = conversationTitle(
      { sessionId, customTitle: summary?.customTitle, autoTitle: summary?.autoTitle },
      id => index.getSessionName(id),
      200,
    ).title;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Name for this conversation (empty to clear)',
    value: current ?? '',
  });
  if (input === undefined) return current; // cancelled
  const name = input.trim() || undefined;
  index.setSessionName(sessionId, name);
  let native = '';
  if (agent === 'claude' && transcriptPath) {
    native = writeClaudeCustomTitle(transcriptPath, name)
      ? (name ? ' Claude shows it in `claude --resume` too.' : ' Cleared in Claude too.')
      : ' (Could not write Claude\'s custom-title.json.)';
  }
  refreshSidebar();
  vscode.window.setStatusBarMessage(
    name ? `Conversation renamed to "${name}".${native}` : `Conversation name cleared.${native}`,
    3500,
  );
  return name;
}

async function cmdOpenSubagentTranscript(item?: SubagentTreeItem): Promise<void> {
  if (!item) {
    vscode.window.showErrorMessage('Use the sidebar context menu on a subagent.');
    return;
  }
  if (!item.transcriptPath || !fs.existsSync(item.transcriptPath)) {
    vscode.window.showWarningMessage('Transcript file is no longer on disk.');
    return;
  }
  try {
    // Convert the subagent's byte offset to a line number so VS Code can
    // scroll the editor to the exact spot where this subagent begins.
    let line = 0;
    if (item.subagent.firstOffset !== undefined && item.subagent.firstOffset > 0) {
      const head = fs.readFileSync(item.transcriptPath).slice(0, item.subagent.firstOffset);
      line = head.toString('utf8').split('\n').length - 1;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.transcriptPath));
    const editor = await vscode.window.showTextDocument(doc);
    if (line > 0) {
      const pos = new vscode.Position(line, 0);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Open transcript failed: ${String(e).slice(0, 200)}`);
  }
}

async function cmdToggleShowCompletedSubagents(): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  const current = c.get<boolean>('showCompletedSubagents', false);
  await c.update('showCompletedSubagents', !current, vscode.ConfigurationTarget.Global);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Completed subagents ${!current ? 'shown' : 'hidden'} in the sidebar.`,
  );
}

async function cmdSetSessionMuted(
  index: SessionIndex,
  item: SessionTreeItem | vscode.Terminal | undefined,
  selection: vscode.TreeItem[] | undefined,
  muted: boolean,
): Promise<void> {
  const many = selectionTargets(selection);
  if (many) {
    bulkApply(
      many,
      (hash, name) => index.setSessionMuted(hash, name, muted),
      n => `${n} sessions: notifications ${muted ? 'muted' : 'unmuted'}.`,
    );
    return;
  }
  // A sidebar row or a terminal tab (Mute/Unmute live on the tab menu too).
  const session = await resolveSessionInfoFromInvocation(item, index);
  if (!session) {
    vscode.window.showErrorMessage('Use the sidebar context menu or a terminal tab on a session.');
    return;
  }
  const name = session.name;
  const parsed = parseSessionName(name, getConfig().sessionPrefix);
  if (!parsed) return;
  index.setSessionMuted(parsed.hash, name, muted);
  refreshSidebar();
  // Flip the tab menu's Mute ↔ Unmute right away for the active terminal.
  void syncActiveTerminalContext(index);
  vscode.window.showInformationMessage(
    `${session.label || name}: notifications ${muted ? 'muted' : 'unmuted'}.`,
  );
}

/** Set the favorite star. Persisted in the index; drives the .fav
 *  contextValue token (which star action shows), the ★ description hint and
 *  membership in the Favorite Sessions folder. Works from mirror rows in the
 *  special folders too — they are ordinary SessionTreeItems. With the tree's
 *  canSelectMany, a context-menu invocation passes the full selection as the
 *  second argument, so starring a multi-selection stars every selected row. */
async function cmdSetSessionFavorite(
  index: SessionIndex,
  item: SessionTreeItem | undefined,
  selection: vscode.TreeItem[] | undefined,
  favorite: boolean,
): Promise<void> {
  // Dedup by session name: the same session can be selected twice via its
  // canonical row and a mirror row in a pinned folder.
  const targets = new Map<string, SessionTreeItem>();
  const all = (selection?.length ? selection : [item]).filter(
    (i): i is SessionTreeItem => i instanceof SessionTreeItem,
  );
  for (const i of all) targets.set(i.session.name, i);
  if (targets.size === 0) {
    vscode.window.showErrorMessage('Use the star on a session row in the sidebar.');
    return;
  }
  const prefix = getConfig().sessionPrefix;
  for (const name of targets.keys()) {
    const parsed = parseSessionName(name, prefix);
    if (parsed) index.setSessionFavorite(parsed.hash, name, favorite);
  }
  refreshSidebar();
}

/** Terminal-tab variant: one entry that flips the star for the clicked tab.
 *  The tab menus have no per-tab state for `when` clauses (only the ACTIVE
 *  terminal can drive a context key, which would mislabel right-clicks on
 *  inactive tabs), so a single always-correct toggle beats an Add/Remove pair. */
async function cmdToggleFavorite(
  index: SessionIndex,
  item: SessionTreeItem | vscode.Terminal | undefined,
): Promise<void> {
  const cfg = getConfig();
  const name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) {
    vscode.window.showErrorMessage('Not a Terminal Sessions tab.');
    return;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const next = !index.isSessionFavorite(parsed.hash, name);
  index.setSessionFavorite(parsed.hash, name, next);
  refreshSidebar();
  const label = index.getSessionMeta(parsed.hash, name)?.label || name;
  vscode.window.showInformationMessage(
    next ? `★ ${label} added to Favorites.` : `${label} removed from Favorites.`,
  );
}

/** Toggle the per-session Kill lock. When locked, the sidebar hides the Kill
 *  action (a 🔒 hint appears on the row) and cmdKill refuses, guarding an
 *  important session from an accidental Kill click. Restart/Stop stay available. */
async function cmdSetSessionLocked(
  index: SessionIndex,
  item: SessionTreeItem | vscode.Terminal | undefined,
  locked: boolean,
): Promise<void> {
  // Accepts a sidebar row OR a native terminal tab (Unlock (Allow Kill) is
  // offered on the tab menu in place of Kill when the session is locked).
  const cfg = getConfig();
  const name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) {
    vscode.window.showErrorMessage('Use the sidebar context menu or a terminal tab on a session.');
    return;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  index.setSessionLocked(parsed.hash, name, locked);
  refreshSidebar();
  // If the just-(un)locked session is the active terminal, refresh the tab-menu
  // gate immediately so Kill Session ↔ Unlock flips without waiting for a
  // terminal re-activation.
  void syncActiveTerminalContext(index);
  const label = index.getSessionLabel(parsed.hash, name) || name;
  vscode.window.setStatusBarMessage(
    `${label}: ${locked ? '🔒 locked — protected from Kill' : '🔓 unlocked'}`,
    2500,
  );
}

/** Context keys mirroring the ACTIVE terminal's session state, for the native
 *  terminal-tab right-click menu: a `when` clause can't read the right-clicked
 *  tab's session, so it keys off the active terminal (the one being acted on).
 *    terminalSessions.activeTerminalLocked   — Kill Session ↔ Unlock, Lock shown when false
 *    terminalSessions.activeTerminalMuted    — Mute ↔ Unmute Notifications
 *    terminalSessions.activeTerminalYolo     — 'on' | 'off' | 'none' → Switch to Normal / YOLO / hidden
 *    terminalSessions.activeTerminalForkable — Fork Conversation shown
 *  Every key falls to its "safe" value on a resolve miss; the commands re-check
 *  the real state, so a momentarily stale key only degrades to "warn on click". */
export async function syncActiveTerminalContext(index: SessionIndex): Promise<void> {
  const set = (locked: boolean, muted: boolean, yolo: 'on' | 'off' | 'none', forkable: boolean): void => {
    void vscode.commands.executeCommand('setContext', 'terminalSessions.activeTerminalLocked', locked);
    void vscode.commands.executeCommand('setContext', 'terminalSessions.activeTerminalMuted', muted);
    void vscode.commands.executeCommand('setContext', 'terminalSessions.activeTerminalYolo', yolo);
    void vscode.commands.executeCommand('setContext', 'terminalSessions.activeTerminalForkable', forkable);
  };
  const t = vscode.window.activeTerminal;
  if (!t) { set(false, false, 'none', false); return; }
  const s = await resolveSessionInfoFromInvocation(t, index);
  if (!s) { set(false, false, 'none', false); return; }
  set(Boolean(s.locked), Boolean(s.muted), s.yoloCapable ? (s.yolo ? 'on' : 'off') : 'none', Boolean(s.forkable));
}

/** Inline padlock button on a locked row. It is a deliberate no-op on the lock
 *  state: clicking the padlock does NOT unlock (that would make an accidental
 *  click undo the protection). It only reminds the user to unlock via right-click,
 *  keeping the lock "sticky". */
async function cmdLockedHint(item?: SessionTreeItem): Promise<void> {
  const label = item?.session.label || item?.session.name || 'This session';
  vscode.window.showInformationMessage(
    `🔒 "${label}" is locked. Right-click → Unlock (Allow Kill) to remove the lock.`,
  );
}

async function cmdFixClaudeRendering(): Promise<void> {
  const shell = process.env.SHELL || '';
  const home = process.env.HOME || os.homedir();
  const rcFile = shell.includes('zsh') ? '.zshrc'
    : shell.includes('bash') ? '.bashrc'
    : shell.includes('fish') ? '.config/fish/config.fish'
    : '.profile';
  const rcPath = path.join(home, rcFile);
  const isFish = rcFile.endsWith('config.fish');

  // Only NO_FLICKER. Up to v0.20.40 this command ALSO appended
  // CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1, which makes Claude ignore every mouse
  // click/drag (only wheel scroll survives) and so kills drag-select, copy on
  // release and buttons inside Claude's fullscreen view. See mouse-clicks-guard.ts.
  const line = isFish ? 'set -gx CLAUDE_CODE_NO_FLICKER 1' : 'export CLAUDE_CODE_NO_FLICKER=1';
  const block = '\n# Terminal Sessions — Claude Code rendering fix\n' + line + '\n';

  let existing = '';
  try { existing = fs.readFileSync(rcPath, 'utf8'); } catch { /* file may not exist yet */ }

  // Migration: an rc file written by an older version still carries the mouse var.
  const mouseLines = findMouseEnvLines(existing);
  if (mouseLines.length) {
    const choice = await vscode.window.showWarningMessage(
      `~/${rcFile} still sets CLAUDE_CODE_DISABLE_MOUSE_CLICKS (line ${mouseLines.join(', ')}), `
      + 'added by an older Terminal Sessions. It makes Claude Code ignore every mouse click '
      + 'and drag (drag-select and buttons stop working). Comment it out? A backup is saved '
      + 'next to the file.',
      { modal: true },
      'Comment out', 'Keep',
    );
    if (choice === 'Comment out') {
      try {
        const { changed, backup } = commentOutMouseEnv(rcPath);
        existing = fs.readFileSync(rcPath, 'utf8');
        vscode.window.showInformationMessage(
          `Commented out ${changed} line(s) in ~/${rcFile} (backup: ${path.basename(backup)}). `
          + 'Restart running Claude sessions to pick it up.',
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Could not write to ${rcPath}: ${String(e).slice(0, 120)}`);
        return;
      }
    }
  }

  if (existing.includes(line)) {
    const action = await vscode.window.showInformationMessage(
      `CLAUDE_CODE_NO_FLICKER=1 is already in ~/${rcFile}. `
      + 'Open a new shell (or restart the tmux pane) to pick it up in a running Claude session.',
      'Open rc file',
    );
    if (action === 'Open rc file') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rcPath));
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Append the Claude Code rendering env var to ~/${rcFile}?\n\n`
    + line + '\n\n'
    + 'This puts Claude Code into fullscreen (alt-screen) mode so the scrollback stays '
    + 'clean; Claude then owns the mouse (drag-select, copy on release, clicks, wheel). '
    + 'The managed tmux.conf already sets this for every tmux pane — you only need the '
    + 'rc export for shells outside tmux.\n\n'
    + 'Requires Claude Code ≥ 2.1.110. Running tmux panes pick up the change only '
    + 'after Restart Session + relaunch of claude.',
    { modal: true },
    'Append', 'Show only (I paste manually)',
  );
  if (!choice) return;
  if (choice === 'Show only (I paste manually)') {
    const doc = await vscode.workspace.openTextDocument({
      content: block,
      language: isFish ? 'fish' : 'shellscript',
    });
    await vscode.window.showTextDocument(doc);
    return;
  }
  try {
    fs.appendFileSync(rcPath, block);
    vscode.window.showInformationMessage(
      `Appended CLAUDE_CODE_NO_FLICKER=1 to ~/${rcFile}. Open a new terminal (or reload shell) to activate. `
      + 'Note: running tmux panes need to be restarted to pick up the new environment.',
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Could not write to ${rcPath}: ${String(e).slice(0, 120)}`);
  }
}

/** On-demand version of the startup guard: scan rc files, the tmux server env,
 *  ~/.claude/settings.json and this process for the mouse-killing vars, offer the fix. */
async function cmdFixClaudeMouseEnv(ctx: vscode.ExtensionContext): Promise<void> {
  const tmuxPath = await tmux.detectTmuxPath(getConfig().tmuxPath);
  await maybeWarnMouseEnv(ctx, tmuxPath, { force: true });
}

async function cmdFindSession(index: SessionIndex, searchIndex: ClaudeSearchIndex): Promise<void> {
  // Best-effort refresh in the background while the picker is open; re-render
  // once it lands so a title renamed/cleared since the last scan shows fresh.
  let disposed = false;
  void searchIndex.refresh().then(n => { if (n > 0 && !disposed) render(qp.value); });
  interface Pick extends vscode.QuickPickItem { entry: SessionIndexEntry }
  const qp = vscode.window.createQuickPick<Pick>();
  qp.placeholder = 'Search Claude sessions by prompt, cwd, or session id…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const render = (q: string): void => {
    const entries = q ? searchIndex.search(q, id => index.getSessionName(id)) : searchIndex.list();
    qp.items = entries.slice(0, 100).map(e => ({
      label: conversationTitle(
        { sessionId: e.sessionId, customTitle: e.customTitle, autoTitle: e.aiTitle, firstUserMessage: e.title },
        id => index.getSessionName(id),
      ).title || '(no prompt)',
      description: `${path.basename(e.cwd || '')} · ${e.turns} turns · ${humanAge(new Date(e.lastModified))}`,
      detail: e.lastPrompt !== e.firstPrompt ? `last: ${e.lastPrompt}` : undefined,
      entry: e,
    }));
  };
  qp.onDidChangeValue(render);
  render('');
  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (!sel) return;
    await openSessionActions(sel.entry);
  });
  qp.onDidHide(() => { disposed = true; qp.dispose(); });
  qp.show();
}

/**
 * Filter the SIDEBAR sessions (live + stopped) by keyword — label, folder path,
 * group name, workspace — and jump to the picked one. Complements Find Session
 * (which searches transcript CONTENT): this one answers "where is my linkody
 * pane again?" without scrolling the tree. Accept = reveal in the sidebar and
 * attach (or Start, when the session is stopped — same as clicking its row).
 */
async function cmdSearchSessions(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  if (all.length === 0) {
    vscode.window.showInformationMessage('No sessions to search.');
    return;
  }
  interface Pick extends vscode.QuickPickItem { session: SessionInfo }
  const picks: Pick[] = all.map(s => {
    const groupName = s.groupId
      ? index.getWorkspace(s.workspaceHash)?.groups?.[s.groupId]?.name
      : undefined;
    const state = s.stopped ? 'stopped' : s.attached ? 'attached' : 'detached';
    return {
      label: `$(${s.stopped ? 'debug-stop' : s.icon || 'terminal'}) ${s.label || `#${s.tabId}`}`,
      description: [s.workspaceLabel, groupName, state, `idle ${humanAge(s.lastAttached)}`]
        .filter(Boolean).join(' · '),
      detail: s.folderPath || s.workspacePath,
      session: s,
    };
  });
  const pick = await vscode.window.showQuickPick<Pick>(picks, {
    placeHolder: 'Filter sessions by name, folder, group, or workspace…',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;
  const s = pick.session;
  await revealSessionInSidebar(s.name, true);
  if (s.stopped) {
    await cmdStart(index, registry, claudeTracker, undefined, s.name);
  } else {
    await openTerminalForSession(s.name, undefined, index);
    refreshSidebar();
  }
}

/**
 * Live in-tree filter (the sidebar funnel button). An InputBox stays open while
 * the tree filters ON EVERY KEYSTROKE — matching sessions render as a flat list
 * with a "Filter: …" header row. Enter/Esc just close the box; the filter
 * STAYS until cleared (header row click, empty text, or the view description
 * reminds you it's on). This is the closest VS Code lets an extension get to
 * "type directly into the tree".
 */
function cmdFilterSessions(): void {
  const ib = vscode.window.createInputBox();
  ib.placeholder = 'Filter sessions — name, folder, group, workspace (all words must match)';
  ib.value = getSidebarTextFilter() ?? '';
  ib.prompt = 'The sidebar filters live as you type. The filter persists after closing — click the "Filter:" row to clear it.';
  ib.onDidChangeValue(v => setSidebarTextFilter(v));
  ib.onDidAccept(() => ib.hide());
  ib.onDidHide(() => ib.dispose());
  ib.show();
}

/**
 * Click on the transcript-cleanup notice row. One modal, two real choices:
 * write `cleanupPeriodDays: 3650` into ~/.claude/settings.json (surgical text
 * edit — the rest of the file is preserved byte-for-byte), or snooze the
 * notice for 30 days. Escape does nothing and the notice stays.
 */
async function cmdFixTranscriptCleanup(): Promise<void> {
  const current = readClaudeCleanupDays();
  const warnDays = getConfig().transcriptExpiryWarnDays;
  const expiring = warnDays > 0 ? countExpiringTranscripts(warnDays) : { count: 0, soonestDays: 0 };
  const atRisk = expiring.count > 0
    ? ` ${expiring.count} transcript${expiring.count === 1 ? '' : 's'} will be deleted within the next `
      + `${warnDays} days — the first in ~${expiring.soonestDays} day${expiring.soonestDays === 1 ? '' : 's'}.`
    : '';
  const choice = await vscode.window.showWarningMessage(
    `Claude Code deletes conversation transcripts after ${current ?? 30} days of inactivity `
    + `(its cleanupPeriodDays setting). A stopped session older than that starts as an EMPTY shell — `
    + `the conversation is permanently gone.${atRisk} Keep transcripts for ~10 years instead?`,
    { modal: true },
    'Keep Transcripts (3650 days)',
    'Hide for 30 Days',
  );
  if (choice === 'Keep Transcripts (3650 days)') {
    const err = setClaudeCleanupDays(KEEP_FOREVER_DAYS);
    if (err) {
      vscode.window.showErrorMessage(`Couldn't update Claude settings: ${err}`);
      return;
    }
    clearExpiryCache(); // expiry dates just moved ~10 years out
    vscode.window.showInformationMessage(
      'Done — "cleanupPeriodDays": 3650 written to ~/.claude/settings.json. Claude will keep transcripts for ~10 years.',
    );
  } else if (choice === 'Hide for 30 Days') {
    snoozeCleanupNotice();
  } else {
    return; // Escape — leave the notice as is.
  }
  refreshSidebar();
}

async function openSessionActions(entry: SessionIndexEntry): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(file-code) Open transcript file', action: 'open' as const },
      { label: '$(copy) Copy session ID', action: 'copyId' as const },
      { label: '$(folder-opened) Reveal cwd in OS', action: 'revealCwd' as const },
    ],
    { placeHolder: entry.title || entry.sessionId },
  );
  if (!pick) return;
  switch (pick.action) {
    case 'open': {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.transcriptPath));
      await vscode.window.showTextDocument(doc, { preview: true });
      break;
    }
    case 'copyId':
      await vscode.env.clipboard.writeText(entry.sessionId);
      vscode.window.setStatusBarMessage(`Copied session ID ${entry.sessionId}`, 2500);
      break;
    case 'revealCwd':
      if (entry.cwd) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.cwd));
      }
      break;
  }
}

const SORT_MODE_LABELS: Record<SidebarSortMode, { label: string; detail: string }> = {
  custom: {
    label: 'Custom',
    detail: 'Drag sessions in the sidebar to set your own order',
  },
  mru: {
    label: 'Recently used',
    detail: 'Most recently focused session first',
  },
  created: {
    label: 'Creation order',
    detail: 'Oldest session first (default)',
  },
  alphabetical: {
    label: 'Alphabetical',
    detail: 'By session label (A to Z)',
  },
};

async function cmdPickSortMode(index: SessionIndex): Promise<void> {
  const current = getConfig().sidebarSortMode;
  interface Pick extends vscode.QuickPickItem { mode: SidebarSortMode }
  const items: Pick[] = SORT_MODES.map(m => {
    const meta = SORT_MODE_LABELS[m];
    return {
      label: m === current ? `$(check) ${meta.label}` : `     ${meta.label}`,
      detail: meta.detail,
      mode: m,
    };
  });
  items.push({
    label: '     Reset custom order',
    detail: 'Clear drag-reorder memory for every workspace (sort mode unchanged)',
    mode: current,
    description: 'reset',
  } as Pick & { description: string });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Sidebar sort (current: ${SORT_MODE_LABELS[current].label})`,
  });
  if (!pick) return;
  if ((pick as Pick & { description?: string }).description === 'reset') {
    for (const hash of Object.keys(index.getAllWorkspaces())) {
      index.clearWorkspaceSortOrder(hash);
    }
    refreshSidebar();
    vscode.window.setStatusBarMessage('Terminal Sessions: custom order cleared', 2500);
    return;
  }
  if (pick.mode === current) return;
  await setSortMode(pick.mode);
  refreshSidebar();
  vscode.window.setStatusBarMessage(
    `Terminal Sessions: sort → ${SORT_MODE_LABELS[pick.mode].label}`,
    2500,
  );
}

async function cmdPickFilterMode(): Promise<void> {
  interface Pick extends vscode.QuickPickItem { mode: SidebarFilterMode }
  const current = getConfig().sidebarFilterMode;
  const items: Pick[] = [
    { mode: 'all',      label: '$(list-flat) Show All Sessions',     description: current === 'all'      ? '(current)' : '' },
    { mode: 'running',  label: '$(pass-filled) Show Running Only',   description: current === 'running'  ? '(current)' : '' },
    { mode: 'stopped',  label: '$(debug-stop) Show Stopped Only',    description: current === 'stopped'  ? '(current)' : '' },
  ];
  const pick = await vscode.window.showQuickPick<Pick>(items, {
    placeHolder: 'Filter sidebar by session state',
  });
  if (!pick) return;
  await setFilterMode(pick.mode);
  refreshSidebar();
}

/**
 * Resolve the tmux session name an action should target from whatever the
 * command handler was invoked with. The sidebar right-click passes a
 * SessionTreeItem; the native terminal-tab / terminal context menu passes the
 * vscode.Terminal for that tab (same shape cmdRevealSessionInSidebar relies on).
 * Returns undefined when neither yields a session — callers fall back to their
 * own session picker. Deliberately does NOT fall back to the active terminal:
 * for stop/restart, silently targeting a different session than the one the user
 * right-clicked would be destructive.
 */
/** Expand a context-menu invocation into unique session-row targets when a
 *  real multi-selection exists (2+ session rows; mirror rows in the pinned
 *  folders dedup by session name). Returns undefined for a single row so the
 *  command's own resolution path (clicked row / terminal / quick pick) runs
 *  unchanged. */
function selectionTargets(selection: vscode.TreeItem[] | undefined): SessionTreeItem[] | undefined {
  const rows = (selection ?? []).filter((i): i is SessionTreeItem => i instanceof SessionTreeItem);
  if (rows.length < 2) return undefined;
  const seen = new Map<string, SessionTreeItem>();
  for (const r of rows) if (!seen.has(r.session.name)) seen.set(r.session.name, r);
  return [...seen.values()];
}

/** Apply a per-session index mutation over a multi-selection, then refresh
 *  once and report once. Backs the simple bulk actions (mute, lock, icon,
 *  color, group) where the operation itself cannot fail per session. */
function bulkApply(
  rows: SessionTreeItem[],
  apply: (hash: string, name: string) => void,
  doneMsg: (n: number) => string,
): void {
  const prefix = getConfig().sessionPrefix;
  let n = 0;
  for (const r of rows) {
    const parsed = parseSessionName(r.session.name, prefix);
    if (parsed) { apply(parsed.hash, r.session.name); n++; }
  }
  refreshSidebar();
  if (n > 0) vscode.window.showInformationMessage(doneMsg(n));
}

async function resolveSessionNameFromInvocation(
  arg: SessionTreeItem | vscode.Terminal | undefined,
  index: SessionIndex,
  prefix: string,
): Promise<string | undefined> {
  const asItem = arg as SessionTreeItem | undefined;
  if (asItem?.session?.name) return asItem.session.name;
  const asTerm = arg as vscode.Terminal | undefined;
  if (asTerm && typeof asTerm.sendText === 'function') {
    return resolveTmuxNameForTerminalLive(asTerm, index, prefix);
  }
  return undefined;
}

/** Like resolveSessionNameFromInvocation, but yields the full SessionInfo the
 *  session commands work on. A sidebar row already carries it; a terminal tab is
 *  resolved to its tmux session and the row is rebuilt from the index (same
 *  fields enrichSessions fills for a live row, minus the tmux timestamps). */
async function resolveSessionInfoFromInvocation(
  arg: SessionTreeItem | vscode.Terminal | undefined,
  index: SessionIndex,
): Promise<SessionInfo | undefined> {
  const asItem = arg as SessionTreeItem | undefined;
  if (asItem?.session?.name) return asItem.session;
  const cfg = getConfig();
  const name = await resolveSessionNameFromInvocation(arg, index, cfg.sessionPrefix);
  if (!name) return undefined;
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return undefined;
  const ws = index.getWorkspace(parsed.hash);
  const meta = index.getSessionMeta(parsed.hash, name);
  const agent = latestAgentSession(index, parsed.hash, name)?.agent;
  const yoloHits = agent ? yoloFlagsFor(agent, meta?.resumeFlags?.[agent] ?? []) : [];
  return {
    name,
    workspaceHash: parsed.hash,
    workspacePath: ws?.path || '',
    workspaceLabel: ws?.label || `(${parsed.hash})`,
    tabId: parsed.tabId,
    label: meta?.label,
    icon: meta?.icon,
    color: meta?.color,
    createdAt: meta?.createdAt ? new Date(meta.createdAt) : new Date(0),
    lastAttached: new Date(),
    lastActiveAt: meta?.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
    attached: true,
    muted: meta?.muted,
    favorite: meta?.favorite,
    locked: meta?.locked,
    stopped: false,
    groupId: meta?.groupId,
    branchSetId: meta?.branchSetId,
    forkable: isForkableAgent(agent),
    yolo: yoloHits.length > 0,
    yoloCapable: Boolean(yoloSpecFor(agent)),
    yoloFlags: yoloHits,
    folderPath: meta?.folderPath,
  };
}

/** A session resolved down to everything needed to tear it down and bring it
 *  back with its conversation resumed. Shared by Restart and the YOLO switch,
 *  which differ only in the confirmation text and the launch flags they pass. */
interface RelaunchTarget {
  name: string;
  hash: string;
  /** cwd to re-create the tmux session in. */
  cwd: string;
  /** `"my label"` or `#3`, for user-facing messages. */
  labelDisplay: string;
  provider: AgentProvider;
  /** Conversation to auto-resume, when one was found on disk. */
  sessionId?: string;
  transcriptPath?: string;
}

/**
 * Resolve the session a relaunch command was invoked on — from the clicked
 * sidebar row / terminal, or a quick pick when invoked from the palette — plus
 * its cwd and the conversation to resume.
 */
async function resolveRelaunchTarget(
  tmuxPath: string,
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item: SessionTreeItem | vscode.Terminal | undefined,
  placeHolder: string,
): Promise<RelaunchTarget | undefined> {
  const cfg = getConfig();
  let name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string; wsHash: string; wsPath: string }
    const picks: Pick[] = all.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      sessionName: s.name,
      wsHash: s.workspaceHash,
      wsPath: s.workspacePath,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder });
    if (!pick) return undefined;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return undefined;
  const ws = index.getWorkspace(parsed.hash);
  if (!ws) return undefined;
  const meta = index.getSessionMeta(parsed.hash, name);

  // Resolve the cwd to re-create the tmux session in.
  // Priority: stored folderPath → live tmux session_path → workspace root.
  // The live read backfills folderPath for sessions created before this
  // field existed, so a single restart "self-heals" old index entries.
  let restartCwd = meta?.folderPath || '';
  if (!restartCwd) {
    const live = await tmux.getSessionPath(tmuxPath, name);
    if (live) {
      restartCwd = live;
      index.setSessionFolderPath(parsed.hash, name, live);
    }
  }
  if (!restartCwd) restartCwd = ws.path;

  // Detect Claude session so we can auto-resume the conversation after restart.
  // Live map first (current ownership), then the historical record in the
  // index (set on every hook event, survives the cleanup that fires when a
  // sessionId moves to another tmux). Verify the transcript is still on disk
  // — Claude prunes old transcripts and the index can hold stale entries.
  // Use the session's own folderPath (where the transcript actually lives),
  // not the workspace root — subfolder sessions write to a different Claude
  // project directory.
  // Walk the full history to skip past dead sessionIds (Claude prunes empty
  // sessions, so the head may be a 0-turn ghost while the real conversation
  // lives one or two slots deeper).
  const { provider, history } =
    resumeContextFor(index, registry, claudeTracker, parsed.hash, name);
  // Skip conversations another pane already holds — confirmed live, or a resume
  // dispatched moments ago that hasn't booted yet. Two Restarts a few seconds
  // apart would otherwise both resolve the same id from a not-yet-updated index
  // and point both panes at one conversation.
  const resumeInfo = resolveResumeFromHistory(
    provider,
    history.filter(id => !claudeTracker.isConversationTaken(id, name)),
    restartCwd,
    ws.path,
  );

  return {
    name,
    hash: parsed.hash,
    cwd: restartCwd,
    labelDisplay: meta?.label ? `"${meta.label}"` : `#${parsed.tabId}`,
    provider,
    sessionId: resumeInfo?.sessionId,
    transcriptPath: resumeInfo?.transcriptPath,
  };
}

/**
 * Kill the tmux session, recreate it in the same place, and resume its
 * conversation with `flags`. `flags` is passed explicitly rather than read from
 * the index so the YOLO switch can relaunch with a modified set.
 *
 * Pass a THUNK to defer the read to the moment the resume command is built.
 * `captureLaunchFlags` writes the live process's flags fire-and-forget, so a
 * Restart fired seconds after the agent's last hook event can otherwise read the
 * index before that write lands and silently relaunch without `--model`,
 * `--add-dir` or the yolo flag. Restart passes a thunk for exactly that reason;
 * the YOLO switch passes an array, since it must use the flags it just computed.
 */
async function relaunchSession(
  tmuxPath: string,
  target: RelaunchTarget,
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  flags: readonly string[] | (() => readonly string[]),
  failureLabel: string,
): Promise<boolean> {
  const { name, hash, cwd } = target;
  try {
    await tmux.killSession(tmuxPath, name);
    // Close the now-orphaned VS Code tab (the shell inside it sees its tmux
    // session die and hangs on "process exited"). Without this, the next open
    // finds the dead tab and any sendText goes nowhere. dispose() is sync on
    // our side but the actual close fires onDidCloseTerminal async — wait for
    // it (with a 500 ms ceiling) before creating the replacement.
    const dead = findTerminalForSession(name);
    if (dead) await disposeAndWait(dead, 500);
    // recordSession keeps existing label/icon/color; just ensures entry exists.
    index.recordSession(hash, name);
    await tmux.createDetachedSession(tmuxPath, name, cwd);
    // Clear any lingering stopped flag (mirrors cmdStart) — otherwise a session
    // restarted from the palette stays marked stopped and post-reboot restore
    // filters it out as "intentionally stopped", losing its auto-resume.
    index.setSessionStopped(hash, name, false);
    const term = await openTerminalForSession(name, cwd, index, true);
    if (term && target.sessionId) {
      // Give the shell a moment to init (rc files, prompt) before sending
      // the resume command. Heavy zshrc / oh-my-zsh setups need > 1 s.
      await sleep(SHELL_INIT_DELAY_MS);
      // Between openTerminalForSession() returning and now, the user may have
      // closed the tab manually. Verify liveness before firing into the void.
      if (vscode.window.terminals.includes(term)) {
        try {
          // Hold the conversation for this pane until its agent boots and the
          // hooks confirm ownership, so a second Restart moments later can't
          // resolve the same id from an index that hasn't caught up.
          claudeTracker.reserveResume(target.sessionId, name);
          term.sendText(buildResumeCommand(
            target.provider, target.sessionId, target.transcriptPath, cwd,
            typeof flags === 'function' ? flags() : flags,
          ));
        } catch (e) { console.error('[terminal-sessions] sendText failed:', e); }
      }
    }
    refreshSidebar();
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`${failureLabel} failed: ${String(e).slice(0, 200)}`);
    return false;
  }
}

async function cmdRestart(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const target = await resolveRelaunchTarget(
    tmuxPath, index, registry, claudeTracker, item,
    'Restart which session? (kills any running process, keeps label/icon/color)',
  );
  if (!target) return;

  const claudeLine = target.sessionId
    ? `\n\nDetected ${target.provider.displayName} session ${target.sessionId.slice(0, 8)}… — will auto-resume after restart.`
    : '';
  const confirm = await vscode.window.showWarningMessage(
    `Restart session ${target.labelDisplay}?\n\nKills the current tmux session (any running program in it, including Claude Code) and creates a fresh empty shell with the same name, workspace, icon, and color.${claudeLine}`,
    { modal: true }, 'Restart',
  );
  if (confirm !== 'Restart') return;

  // Restart preserves the session's character, YOLO included — switching modes
  // is what cmdSwitchYolo is for. Read the flags late (thunk) so a capture still
  // in flight when Restart was clicked isn't missed.
  await relaunchSession(
    tmuxPath, target, index, claudeTracker,
    () => index.getResumeFlags(target.hash, target.name, target.provider.id),
    'Restart',
  );
}

/**
 * Switch a session between YOLO (auto-approve) and normal permission mode.
 *
 * The permission mode is fixed at launch, so switching means relaunching: the
 * tmux session is recreated and the conversation resumed with the yolo flag
 * added or removed. Nothing is lost — the conversation continues, only its
 * launch flags change.
 *
 * `on === undefined` toggles, which is what the palette command does; the two
 * context-menu entries pass an explicit target so they always mean what they say.
 */
async function cmdSwitchYolo(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  on: boolean | undefined,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const target = await resolveRelaunchTarget(
    tmuxPath, index, registry, claudeTracker, item,
    'Switch permission mode for which session?',
  );
  if (!target) return;

  const spec = target.provider.yolo;
  if (!spec) {
    vscode.window.showInformationMessage(
      `${target.provider.displayName} has no auto-approve mode this extension can set.`,
    );
    return;
  }

  // The mode is a launch flag, so it can only be applied by relaunching the
  // conversation. With nothing to resume, a relaunch would kill the shell and
  // change nothing — refuse instead of destroying the session for no gain.
  if (!target.sessionId) {
    vscode.window.showWarningMessage(
      `No ${target.provider.displayName} conversation found in ${target.labelDisplay} to switch. `
      + `Start one first — the permission mode is chosen when the agent launches.`,
    );
    return;
  }

  const current = index.getResumeFlags(target.hash, target.name, target.provider.id);
  const isOn = isYolo(current, spec);
  const want = on ?? !isOn;
  if (want === isOn) {
    vscode.window.showInformationMessage(
      `Session ${target.labelDisplay} is already in ${isOn ? 'YOLO' : 'normal'} mode.`,
    );
    return;
  }

  // A session mid-tool-call loses that work when the process dies, so it is
  // always worth a prompt — regardless of direction or the confirm setting.
  const state = claudeTracker.getSnapshot(target.name)?.state;
  const busy = state === 'working' || state === 'tool';
  const cfg = getConfig();

  if (want && (cfg.confirmYoloSwitch || busy)) {
    const flagList = spec.on.join(' ');
    const busyLine = busy
      ? `\n\n${target.provider.displayName} is working right now — restarting will interrupt the current step.`
      : '';
    // Conflicting flags have to be dropped for the CLI to accept the yolo flag,
    // and nothing restores them on the way back. Say so rather than silently
    // discarding a setting the user deliberately chose.
    const dropped = (spec.conflicts || []).filter(f => current.includes(f));
    const droppedLine = dropped.length
      ? `\n\nThis also removes ${dropped.map(f => `\`${f}\``).join(', ')}, which cannot be combined with it. `
        + `Switching back to normal mode will not restore it.`
      : '';
    const resumeLine = target.sessionId
      ? `\n\nThe conversation (${target.sessionId.slice(0, 8)}…) is resumed; only the permission mode changes.`
      : '';
    const choice = await vscode.window.showWarningMessage(
      `Switch session ${target.labelDisplay} to YOLO mode?\n\n`
      + `${target.provider.displayName} will be relaunched with ${flagList}. `
      + `It will no longer ask you to approve tool use, file writes, or shell commands `
      + `in this session.${droppedLine}${resumeLine}${busyLine}`,
      { modal: true },
      'Switch to YOLO', "Switch and don't ask again",
    );
    if (choice !== 'Switch to YOLO' && choice !== "Switch and don't ask again") return;
    if (choice === "Switch and don't ask again") {
      await vscode.workspace.getConfiguration('terminalSessions')
        .update('confirmYoloSwitch', false, vscode.ConfigurationTarget.Global);
    }
  } else if (!want && busy) {
    // Turning safety back on needs no gate of its own, but interrupting live
    // work still does.
    const choice = await vscode.window.showWarningMessage(
      `Switch session ${target.labelDisplay} to normal mode?\n\n`
      + `${target.provider.displayName} is working right now — restarting will interrupt the current step.`,
      { modal: true }, 'Switch to Normal',
    );
    if (choice !== 'Switch to Normal') return;
  }

  const next = setYolo(current, spec, want);
  // Persist before relaunching so the 🚨 chip and the menu gating reflect the new
  // mode even if the relaunch fails partway, and so a later plain Restart keeps
  // the mode the user just chose.
  index.recordResumeFlags(target.hash, target.name, target.provider.id, next);

  const ok = await relaunchSession(tmuxPath, target, index, claudeTracker, next, 'Mode switch');
  if (!ok) return;
  vscode.window.showInformationMessage(
    want
      ? `🚨 ${target.labelDisplay} is now in YOLO mode — tool use is auto-approved.`
      : `${target.labelDisplay} is back to normal mode — you'll be asked to approve again.`,
  );
}

/**
 * Fork the conversation running in a session into a NEW parallel session/tab.
 * Sidebar-only (the `forkable` contextValue gate keeps it off non-Claude rows).
 * The new session resumes the same conversation with the provider's fork command
 * (Claude: `--fork-session` → a brand-new conversation id), so the two branches
 * are independent from the first message. Both are linked into a "branch set"
 * (peers) so the shared ⑂ chip shows the relationship; Unlink dissolves it.
 */
async function cmdForkConversation(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  const src = await resolveSessionInfoFromInvocation(item, index);
  if (!src) {
    vscode.window.showInformationMessage('Right-click a Claude session in the sidebar or its terminal tab to fork it.');
    return;
  }
  const parsed = parseSessionName(src.name, cfg.sessionPrefix);
  if (!parsed) return;
  const ws = index.getWorkspace(parsed.hash);
  if (!ws) return;

  // Resolve WHICH conversation to fork, reusing the restart resolution so we
  // fork the exact conversation this pane is on (walks history, skips dead ids).
  const { provider, history } = resumeContextFor(index, registry, claudeTracker, parsed.hash, src.name);
  if (!provider.supportsFork || !provider.buildForkCommand) {
    vscode.window.showWarningMessage(`Fork is not supported for ${provider.displayName} sessions yet.`);
    return;
  }

  // Fork cwd: stored folderPath → live tmux path → workspace root (mirrors restart).
  let forkCwd = index.getSessionMeta(parsed.hash, src.name)?.folderPath || '';
  if (!forkCwd) {
    const live = await tmux.getSessionPath(tmuxPath, src.name);
    if (live) forkCwd = live;
  }
  if (!forkCwd) forkCwd = ws.path;

  const resumeInfo = resolveResumeFromHistory(provider, history, forkCwd, ws.path);
  if (!resumeInfo) {
    vscode.window.showWarningMessage('No agent conversation to fork yet — start Claude in this session first.');
    return;
  }

  // Optional branch name (default "{origin} · fork N" within the origin's set).
  // The base label comes from the SET's origin (not this pane's label), so
  // forking a fork stays "{origin} · fork N" instead of nesting "· fork" suffixes.
  const originLabel = src.label || `#${parsed.tabId}`;
  const existingSetId = index.getSessionMeta(parsed.hash, src.name)?.branchSetId;
  const existingSet = existingSetId ? index.getBranchSet(parsed.hash, existingSetId) : undefined;
  const baseLabel = existingSet
    ? (existingSet.baseLabel ?? existingSet.name.replace(/\s*⑂\s*$/, ''))
    : originLabel;
  const memberCount = existingSetId ? index.branchSetMembers(parsed.hash, existingSetId).length : 1;
  const defaultName = `${baseLabel} · fork ${memberCount + 1}`;
  const input = await vscode.window.showInputBox({
    prompt: `Name this fork of "${originLabel}" (optional)`,
    value: defaultName,
    ignoreFocusOut: true,
  });
  if (input === undefined) return; // cancelled
  const label = input.trim() || defaultName;

  try {
    // Allocate a fresh session in the same workspace and create its tmux.
    const newTabId = await nextSafeTabId(index, tmuxPath, cfg.sessionPrefix, parsed.hash);
    const newName = buildSessionName(cfg.sessionPrefix, parsed.hash, newTabId);
    await tmux.createDetachedSession(tmuxPath, newName, forkCwd);
    index.recordSession(parsed.hash, newName, label, forkCwd !== ws.path ? forkCwd : undefined);
    index.setSessionStopped(parsed.hash, newName, false);
    // Inherit the origin's group so all members share a container — the fork
    // cluster can only render when its peers live at the same level. No-op when
    // the origin is ungrouped or its groupId is stale/a master (guarded inside).
    if (src.groupId) index.setSessionGroup(parsed.hash, newName, src.groupId);

    // Link both into a branch set (peers). Reuse the origin's set, else create a
    // new one seeded from the origin label (baseLabel drives the cluster header)
    // and add the origin too.
    let setId = existingSetId;
    if (!setId) {
      setId = index.createBranchSet(parsed.hash, `${baseLabel} ⑂`, baseLabel);
      if (setId) index.addSessionToBranchSet(parsed.hash, src.name, setId);
    }
    if (setId) index.addSessionToBranchSet(parsed.hash, newName, setId);

    // Open the tab and type the fork command once the shell has initialized.
    const term = await openTerminalForSession(newName, forkCwd, index, true);
    if (term) {
      await sleep(SHELL_INIT_DELAY_MS);
      if (vscode.window.terminals.includes(term)) {
        try {
          term.sendText(provider.buildForkCommand(
            resumeInfo.sessionId, forkCwd, resumeInfo.transcriptPath,
            index.getResumeFlags(parsed.hash, src.name, provider.id),
          ));
        } catch (e) { console.error('[terminal-sessions] fork sendText failed:', e); }
      }
    }
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Fork failed: ${String(e).slice(0, 200)}`);
  }
}

/**
 * Unlink a session from its fork branch set (it becomes standalone). The set
 * auto-dissolves when fewer than two members remain. Purely a metadata change —
 * the forked conversation is untouched (it was independent all along).
 */
async function cmdUnlinkBranch(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  const s = item?.session;
  if (!s?.branchSetId) {
    vscode.window.showInformationMessage('Right-click a session with a ⑂ branch chip to unlink it.');
    return;
  }
  index.removeSessionFromBranchSet(s.workspaceHash, s.name);
  refreshSidebar();
}

async function cmdStop(
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const live = all.filter(s => !s.stopped);
    const picks: Pick[] = live.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      sessionName: s.name,
    }));
    if (picks.length === 0) {
      vscode.window.showInformationMessage('No live sessions to stop.');
      return;
    }
    const pick = await vscode.window.showQuickPick<Pick>(picks, {
      placeHolder: 'Stop which session? (entry stays in sidebar, can be started again)',
    });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const label = index.getSessionLabel(parsed.hash, name);
  const labelDisplay = label ? `"${label}"` : name;

  // Confirm only if Claude is actively working/tool — silent otherwise.
  const snap = claudeTracker.getSnapshot(name);
  if (snap && (snap.state === 'working' || snap.state === 'tool')) {
    const confirm = await vscode.window.showWarningMessage(
      `Stop session ${labelDisplay}? Claude is currently working — its turn will be interrupted.`,
      { modal: true }, 'Stop',
    );
    if (confirm !== 'Stop') return;
  }

  try {
    await tmux.killSession(tmuxPath, name);
    const dead = findTerminalForSession(name);
    if (dead) await disposeAndWait(dead, 500);
    index.setSessionStopped(parsed.hash, name, true);
    // Clear tracker state so the sidebar doesn't keep mirroring a Claude
    // session that this tab no longer owns. Without this, snap.sessionId
    // points at a transcript another tab may still be writing to, and the
    // freshness check would keep this row spinning on foreign activity.
    claudeTracker.forgetSession(name);
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Stop failed: ${String(e).slice(0, 200)}`);
  }
}

async function cmdStart(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem,
  explicitName?: string,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name = explicitName ?? item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const stopped = all.filter(s => s.stopped);
    const picks: Pick[] = stopped.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · stopped`,
      sessionName: s.name,
    }));
    if (picks.length === 0) {
      vscode.window.showInformationMessage('No stopped sessions to start.');
      return;
    }
    const pick = await vscode.window.showQuickPick<Pick>(picks, {
      placeHolder: 'Start which session?',
    });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const ws = index.getWorkspace(parsed.hash);
  if (!ws) return;
  const meta = index.getSessionMeta(parsed.hash, name);

  // Resolve cwd the same way cmdRestart does.
  let startCwd = meta?.folderPath || '';
  if (!startCwd) startCwd = ws.path;

  // Claude session id: prefer the live map (current ownership). If empty,
  // fall back to the historical mapping in the index — set on every hook
  // event and preserved across the cleanup that fires when a sessionId
  // moves to another tmux. Use the session's own folder path (where the
  // transcript actually lives) for the existence check, not the workspace
  // root — sessions created in a subfolder write to a different Claude
  // project directory.
  const { provider: startProvider, history: startHistory } =
    resumeContextFor(index, registry, claudeTracker, parsed.hash, name);
  const startResume = resolveResumeFromHistory(
    startProvider,
    // Don't start on a conversation another pane already holds (live, or a resume
    // dispatched seconds ago that hasn't booted). Starting two tangled tabs one
    // after the other is the ordinary cleanup workflow and used to land both on
    // the same conversation.
    startHistory.filter(id => !claudeTracker.isConversationTaken(id, name)),
    startCwd,
    ws.path,
  );
  const claudeSessionId = startResume?.sessionId;
  const claudeTranscriptPath = startResume?.transcriptPath;

  // The pane has recorded conversations but none can be resumed — usually the
  // transcripts were pruned from disk (Claude Code deletes them after
  // ~30 days, `cleanupPeriodDays`). Without this the session just opens as an
  // inexplicable empty shell.
  if (!startResume && startHistory.length > 0) {
    vscode.window.showWarningMessage(
      `"${meta?.label || name}" started as a clean shell — its recorded conversation(s) are no longer on disk `
      + `(Claude Code deletes old transcripts after ~30 days).`,
    );
  }

  try {
    // If the tmux session somehow already exists (rare race), skip create and just attach.
    const exists = await tmux.hasSession(tmuxPath, name);
    if (!exists) await tmux.createDetachedSession(tmuxPath, name, startCwd);
    index.setSessionStopped(parsed.hash, name, false);
    const term = await openTerminalForSession(name, startCwd, index, true);
    if (term && claudeSessionId) {
      await sleep(SHELL_INIT_DELAY_MS);
      if (vscode.window.terminals.includes(term)) {
        try {
  // Hold it for this pane until its agent boots (see reserveResume).
  claudeTracker.reserveResume(claudeSessionId, name);
          term.sendText(buildResumeCommand(
            startProvider, claudeSessionId, claudeTranscriptPath, startCwd,
            index.getResumeFlags(parsed.hash, name, startProvider.id),
          ));
        } catch (e) { console.error('[terminal-sessions] sendText failed:', e); }
      }
    }
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Start failed: ${String(e).slice(0, 200)}`);
  }
}

/**
 * Dispose a terminal and wait for its onDidCloseTerminal event (or timeout).
 * VS Code's dispose() is synchronous on our side but the teardown + close
 * event fire on a later tick; a subsequent createTerminal with the same name
 * can race the tear-down if we don't wait.
 */
function disposeAndWait(term: vscode.Terminal, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; sub.dispose(); clearTimeout(timer); resolve(); };
    const sub = vscode.window.onDidCloseTerminal((t) => { if (t === term) finish(); });
    const timer = setTimeout(finish, timeoutMs);
    try { term.dispose(); } catch { finish(); }
  });
}

async function cmdInstallClaudeHook(tracker: ClaudeTracker): Promise<void> {
  // Installs the unified forwarder as hooks for every ENABLED agent (Claude
  // always; Codex/Antigravity when their CLI is detected or explicitly enabled).
  // Also migrates an existing Claude install from the legacy claude-hook.sh to
  // the shared agent-hook.sh.
  const installed = await tracker.installHooksForEnabledAgents();
  if (installed.length > 0) {
    vscode.window.showInformationMessage(
      `Installed AI agent hooks for: ${installed.join(', ')}. Next time you run them in a tmux session, they'll be tracked.`,
    );
  } else {
    vscode.window.showWarningMessage(
      'No agent hooks installed. Check that at least one AI CLI is enabled (terminalSessions.enabledAgents) or detected on PATH.',
    );
  }
}

async function cmdUninstallClaudeHook(registry: AgentRegistry): Promise<void> {
  const removed: string[] = [];
  for (const p of registry.all()) {
    try { if (await p.uninstallHook()) removed.push(p.displayName); }
    catch { /* best effort */ }
  }
  if (removed.length > 0) {
    vscode.window.showInformationMessage(`Removed AI agent hooks for: ${removed.join(', ')}.`);
  } else {
    vscode.window.showWarningMessage('Could not uninstall any hooks — check the agents\' settings files manually.');
  }
}

async function cmdTestNotification(): Promise<void> {
  await notify({
    title: '✓ Test notification',
    subtitle: 'Terminal Sessions',
    body: 'macOS Notification Center works. Adjust sound & mode in settings.',
  });
}

async function cmdRestoreFromIndex(index: SessionIndex, registry: AgentRegistry, claudeTracker: ClaudeTracker): Promise<void> {
  const result = await maybeOfferRestore(index, registry, claudeTracker);
  if (!result.ran) {
    vscode.window.showInformationMessage(
      'Nothing to restore — either live sessions already exist, or the index has no entries for this workspace.',
    );
  }
}

// ── Terminal name helpers ────────────────────────────────────────────────

function defaultTermName(wsLabel: string, tabId: number, label?: string): string {
  const trimmed = (label || '').trim();
  if (trimmed.length > 0) return `${trimmed} #${tabId}`;
  return `${wsLabel}#${tabId}`;
}

// ── Tmux config commands ─────────────────────────────────────────────────

async function cmdOpenTmuxConfig(): Promise<void> {
  const uri = vscode.Uri.file(tmux.CONF_PATH);
  try {
    await vscode.window.showTextDocument(uri);
  } catch {
    vscode.window.showErrorMessage(`tmux.conf not found at ${tmux.CONF_PATH}. Reload the extension to regenerate it.`);
  }
}

async function cmdReloadTmuxConfig(): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  try {
    await tmux.reloadConfig(tmuxPath);
    vscode.window.showInformationMessage('tmux config reloaded. Existing sessions use the new settings.');
  } catch (e) {
    vscode.window.showWarningMessage(`Could not reload — is a persistent terminal open? (${String(e).slice(0, 100)})`);
  }
}

// ── Session lifecycle commands ───────────────────────────────────────────

async function cmdNewPersistent(index: SessionIndex, targetUri?: vscode.Uri): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();

  let wsPath: string;
  let wsHash: string;
  let wsLabel: string;
  let cwd: string;
  let folderLabel: string | undefined;

  if (targetUri) {
    let folderPath = targetUri.fsPath;
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      if (stat.type !== vscode.FileType.Directory) folderPath = path.dirname(folderPath);
    } catch { /* assume directory */ }
    cwd = folderPath;
    const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath));
    if (wsFolder) {
      wsPath = wsFolder.uri.fsPath;
      wsHash = hashPath(wsPath);
      wsLabel = wsFolder.name || path.basename(wsPath);
    } else {
      wsPath = folderPath;
      wsHash = hashPath(folderPath);
      wsLabel = path.basename(folderPath);
    }
    const sub = path.basename(folderPath);
    if (folderPath !== wsPath) folderLabel = sub;
  } else {
    const ws = currentWorkspace();
    if (!ws) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
    wsPath = ws.path;
    wsHash = ws.hash;
    wsLabel = ws.label;
    cwd = ws.path;
  }

  index.recordWorkspace(wsHash, wsPath, wsLabel);
  const tabId = await nextSafeTabId(index, tmuxPath, cfg.sessionPrefix, wsHash);
  const name = buildSessionName(cfg.sessionPrefix, wsHash, tabId);
  // Persist folderPath only when it differs from the workspace root so a
  // simple "new session in workspace" still inherits future workspace renames.
  const folderPathToStore = cwd !== wsPath ? cwd : undefined;
  index.recordSession(wsHash, name, folderLabel, folderPathToStore);
  const meta = index.getSessionMeta(wsHash, name);
  const { icon, color } = metaIconAndColor(meta);
  const termName = defaultTermName(wsLabel, tabId, meta?.label);
  const term = vscode.window.createTerminal({
    name: termName,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachOrCreateArgs(name, cwd),
    cwd,
    iconPath: icon,
    color,
  });
  term.show();
  refreshSidebar();
}

/**
 * Re-attach every session whose VS Code terminal is a "process exited" ghost.
 * Skips:
 *   - stopped sessions (use Start instead)
 *   - sessions without any terminal tab in the panel (user isn't using them)
 *   - sessions whose terminal is already live (no need to disturb scroll buffer)
 * Iterates in the current sidebar sort order so the new terminals append in
 * the order the user expects. After Cursor restart this is the common path —
 * everything is a ghost, everything gets recreated in sidebar order.
 */
async function cmdReattachAll(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  const sessions = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);

  // Index live sessions by tmux name for quick lookup once a terminal resolves.
  const byName = new Map<string, SessionInfo>();
  for (const s of sessions) byName.set(s.name, s);

  // Scan the OPEN terminals in panel order (window.terminals is creation/restore
  // order) instead of iterating sessions. This: (a) catches tabs the user
  // renamed so they no longer carry the `#<tabId>` we'd match on — we recover
  // the tmux name from the live process via PID; and (b) re-creates the tabs
  // exactly where they sat, since we dispose+create left-to-right.
  let skippedStopped = 0;
  let skippedLive = 0;
  let unresolved = 0;
  const queued = new Set<string>();
  const toReattach: Array<{ session: SessionInfo; ghost: vscode.Terminal; softReconnect: boolean }> = [];
  for (const term of vscode.window.terminals) {
    const exited = !!term.exitStatus;
    // A reload-restored tab keeps showing the ⚠ "disconnected" badge but carries
    // NO exitStatus, and VS Code trims its creationOptions so shellArgs are gone.
    // That absence (no shellArgs, not exited) is our signal it's stale. A tab we
    // created this session still has its shellArgs and is genuinely live.
    const restoredDisconnected = !exited && sessionNameForTerminal(term) === undefined;
    if (!exited && !restoredDisconnected) { skippedLive++; continue; }
    // eslint-disable-next-line no-await-in-loop
    const name = await resolveTmuxNameForTerminalLive(term, index, cfg.sessionPrefix);
    const s = name ? byName.get(name) : undefined;
    if (!name || !s) { unresolved++; continue; }
    if (s.stopped) { skippedStopped++; continue; }
    if (queued.has(name)) continue;
    queued.add(name);
    // Soft reconnect: the tmux session is still alive with its program inside,
    // so `tmux attach` fully restores it. Skip the agent resume that would
    // otherwise type into a live TUI — resume stays reserved for exited ghosts
    // whose pane may have fallen back to a bare shell.
    toReattach.push({ session: s, ghost: term, softReconnect: restoredDisconnected });
  }

  if (toReattach.length === 0) {
    const parts: string[] = ['No ghost terminals to re-attach.'];
    if (skippedLive > 0) parts.push(`${skippedLive} already live`);
    if (unresolved > 0) parts.push(`${unresolved} unrecognized`);
    if (skippedStopped > 0) parts.push(`${skippedStopped} stopped`);
    vscode.window.showInformationMessage(parts.join(' · '));
    return;
  }

  let attached = 0;
  let failed = 0;
  const resumes: Array<{
    term: vscode.Terminal;
    provider: AgentProvider;
    sessionName: string;
    sessionId: string;
    label: string;
    transcriptPath?: string;
    cwd: string;
    flags: string[];
  }> = [];

  // Conversations already claimed by a pane in THIS reattach (see below).
  const claimed = new Set<string>();
  // Strongest claim per conversation, so the winner is decided by evidence (held
  // as the resume head, most recently recorded) and not by loop order.
  const ownersByWs = new Map<string, Map<string, string>>();
  for (const { session: s } of toReattach) {
    if (ownersByWs.has(s.workspaceHash)) continue;
    ownersByWs.set(s.workspaceHash, index.conversationOwners(
      s.workspaceHash,
      toReattach.filter(t => t.session.workspaceHash === s.workspaceHash).map(t => t.session.name),
    ));
  }

  for (const { session: s, ghost, softReconnect } of toReattach) {
    try {
      // Dispose the ghost first so its slot is freed before we createTerminal
      // again — otherwise tmux sees a stale client briefly and the new tab
      // may race-attach into a zombie state.
      await disposeAndWait(ghost, 500);
      const meta = index.getSessionMeta(s.workspaceHash, s.name);
      const cwd = meta?.folderPath || s.workspacePath;
      const term = await openTerminalForSession(s.name, cwd, index, true);
      if (!term) { failed++; continue; }
      attached++;

      // Walk full history to skip dead head sessions (agents prune 0-turn
      // sessions, leaving the head ghost-pointing at a deleted transcript).
      // Only for true exited ghosts — a soft reconnect re-attaches the live
      // tmux session as-is, so there is nothing to resume.
      if (!softReconnect) {
        const { provider: rProvider, history: rHistory } =
          resumeContextFor(index, registry, claudeTracker, s.workspaceHash, s.name);
        const reattachResume = resolveResumeFromHistory(
          rProvider,
          // Drop conversations already handed to an earlier pane in this batch so
          // this one resolves to its own next-most-recent instead. Sibling tabs on
          // the same folder share a history head often enough that without this
          // they both resume the same id and interleave into one transcript.
          rHistory.filter(id => {
            if (claimed.has(id)) return false;
            const owner = ownersByWs.get(s.workspaceHash)?.get(`${rProvider.id} ${id}`);
            return !owner || owner === s.name;
          }),
          cwd,
          s.workspacePath,
        );
        // Owner-gated pass found nothing — retry over anything still unclaimed, so
        // a conversation whose assigned owner can't actually use it (cwd scope,
        // pruned transcript) still gets picked up. restore.ts does the same; this
        // keeps the two batch paths on one policy.
        const finalResume = reattachResume ?? resolveResumeFromHistory(
          rProvider,
          rHistory.filter(id => !claimed.has(id)),
          cwd,
          s.workspacePath,
        );
        if (finalResume) {
          claimed.add(finalResume.sessionId);
          resumes.push({
            term,
            provider: rProvider,
            sessionName: s.name,
            sessionId: finalResume.sessionId,
            label: s.label || s.name,
            transcriptPath: finalResume.transcriptPath,
            cwd,
            flags: index.getResumeFlags(s.workspaceHash, s.name, rProvider.id),
          });
        }
      }
      // Tiny pause between createTerminal calls so the tmux server isn't
      // hammered with N attach requests at once on big workspaces.
      await sleep(150);
    } catch (e) {
      console.error('[terminal-sessions] reattach failed:', s.name, e);
      failed++;
    }
  }

  // Batch `claude --resume <id>` after a single shell-init wait. Doing it
  // per-session would be N × 1.5s on a 16-session workspace.
  let resumed = 0;
  if (resumes.length > 0) {
    await sleep(SHELL_INIT_DELAY_MS);
    for (const r of resumes) {
      if (!vscode.window.terminals.includes(r.term)) continue;
      try {
        claudeTracker.reserveResume(r.sessionId, r.sessionName);
        r.term.sendText(buildResumeCommand(r.provider, r.sessionId, r.transcriptPath, r.cwd, r.flags));
        resumed++;
      } catch (e) {
        console.error('[terminal-sessions] reattach resume sendText failed:', r.label, e);
      }
    }
  }

  const parts: string[] = [
    `Re-attached ${attached}/${toReattach.length} session${toReattach.length === 1 ? '' : 's'}`,
  ];
  if (resumed > 0) parts.push(`auto-resumed Claude in ${resumed}`);
  if (skippedLive > 0) parts.push(`${skippedLive} already live`);
  if (unresolved > 0) parts.push(`${unresolved} unrecognized`);
  if (failed > 0) parts.push(`${failed} failed`);
  vscode.window.showInformationMessage(parts.join(' · '));
  refreshSidebar();
}

/**
 * Resolve the workspace hash + optional parent-master from a group/workspace
 * tree item. Right-clicking a master → create inside it; right-clicking the
 * workspace (or no item) → create at root.
 */
function resolveContainer(
  item: WorkspaceTreeItem | GroupTreeItem | undefined,
): { hash: string; parentMasterId?: string } | undefined {
  if (item instanceof GroupTreeItem) {
    // Only masters can hold groups; if the user invoked this on a normal group,
    // create as a sibling at that group's level (its parent master or root).
    return { hash: item.workspaceHash, parentMasterId: item.kind === 'master' ? item.groupId : undefined };
  }
  if (item instanceof WorkspaceTreeItem) {
    return { hash: item.workspaceHash };
  }
  const ws = currentWorkspace();
  if (!ws) return undefined;
  return { hash: ws.hash };
}

/**
 * Create a new normal group. At workspace root, or inside a master when
 * right-clicked on one. Empty name aborts.
 */
async function cmdNewGroup(index: SessionIndex, item?: WorkspaceTreeItem | GroupTreeItem): Promise<void> {
  const ctx = resolveContainer(item);
  if (!ctx) { vscode.window.showErrorMessage('No workspace open — groups need a workspace.'); return; }
  const name = await vscode.window.showInputBox({
    prompt: ctx.parentMasterId ? 'Group name (inside master)' : 'Group name',
    placeHolder: 'e.g., Stores, Blog, Linkbuilding',
    validateInput: v => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
  });
  if (!name) return;
  index.createGroup(ctx.hash, name, 'group', ctx.parentMasterId);
  refreshSidebar();
}

/**
 * Create a new master group (a "group of groups"). At workspace root, or
 * nested inside another master when right-clicked on one.
 */
async function cmdNewMasterGroup(index: SessionIndex, item?: WorkspaceTreeItem | GroupTreeItem): Promise<void> {
  const ctx = resolveContainer(item);
  if (!ctx) { vscode.window.showErrorMessage('No workspace open — groups need a workspace.'); return; }
  const name = await vscode.window.showInputBox({
    prompt: ctx.parentMasterId ? 'Master group name (inside master)' : 'Master group name',
    placeHolder: 'e.g., Marketing, Clients, Archive',
    validateInput: v => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
  });
  if (!name) return;
  index.createGroup(ctx.hash, name, 'master', ctx.parentMasterId);
  refreshSidebar();
}

/**
 * Move a group (or master) into a master via quick pick. Lists all masters in
 * the workspace except the group itself and its own descendants (no cycles),
 * plus a "Move to root" option.
 */
async function cmdMoveGroupToMaster(index: SessionIndex, item?: GroupTreeItem): Promise<void> {
  if (!item) return;
  const hash = item.workspaceHash;
  const groups = index.getGroups(hash);
  interface Pick extends vscode.QuickPickItem { action: 'master' | 'root'; masterId?: string }
  const picks: Pick[] = [];
  for (const [gid, g] of Object.entries(groups)) {
    if (g.kind !== 'master') continue;
    if (gid === item.groupId) continue;
    if (index.isDescendantGroup(hash, item.groupId, gid)) continue; // would create a cycle
    picks.push({ action: 'master', masterId: gid, label: `$(library) ${g.name}` });
  }
  // Offer "move to root" only if it isn't already at root.
  const cur = groups[item.groupId];
  if (cur?.parentGroupId) {
    picks.push({ action: 'root', label: '$(home) Move to workspace root' });
  }
  if (picks.length === 0) {
    vscode.window.showInformationMessage('No master group to move into. Create one first (right-click workspace → New Master Group).');
    return;
  }
  const pick = await vscode.window.showQuickPick<Pick>(picks, {
    placeHolder: `Move "${item.groupName}" into:`,
  });
  if (!pick) return;
  const ok = index.setGroupParent(hash, item.groupId, pick.action === 'root' ? undefined : pick.masterId);
  if (!ok) {
    vscode.window.showWarningMessage('Couldn\'t move the group there (cycle or invalid target).');
    return;
  }
  refreshSidebar();
}

// Richer, extension-registered palette for group/master icons (see
// package.json contributes.colors → terminalSessions.color.*). Unlike the ANSI
// session palette these are fixed, vivid hues, and because each is a registered
// theme color we can show a *colored* dot in the picker via QuickPickItem.iconPath.
const GROUP_COLOR_CHOICES: { label: string; id: string }[] = [
  { label: 'Red',    id: 'terminalSessions.color.red' },
  { label: 'Orange', id: 'terminalSessions.color.orange' },
  { label: 'Amber',  id: 'terminalSessions.color.amber' },
  { label: 'Yellow', id: 'terminalSessions.color.yellow' },
  { label: 'Lime',   id: 'terminalSessions.color.lime' },
  { label: 'Green',  id: 'terminalSessions.color.green' },
  { label: 'Teal',   id: 'terminalSessions.color.teal' },
  { label: 'Cyan',   id: 'terminalSessions.color.cyan' },
  { label: 'Sky',    id: 'terminalSessions.color.sky' },
  { label: 'Blue',   id: 'terminalSessions.color.blue' },
  { label: 'Indigo', id: 'terminalSessions.color.indigo' },
  { label: 'Purple', id: 'terminalSessions.color.purple' },
  { label: 'Pink',   id: 'terminalSessions.color.pink' },
  { label: 'Gray',   id: 'terminalSessions.color.gray' },
];

async function cmdSetGroupColor(index: SessionIndex, item?: GroupTreeItem): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a group in the sidebar to set its color.');
    return;
  }
  interface ColorPick extends vscode.QuickPickItem { colorId: string }
  const picks: ColorPick[] = [
    { label: 'Default (no color)', iconPath: new vscode.ThemeIcon('close'), colorId: '' },
    ...GROUP_COLOR_CHOICES.map(c => ({
      label: c.label,
      // A ThemeIcon carrying a ThemeColor renders a *colored* swatch in the
      // QuickPick (the inline `$(icon)` label syntax can't be colored).
      iconPath: new vscode.ThemeIcon('circle-large-filled', new vscode.ThemeColor(c.id)),
      colorId: c.id,
    })),
  ];
  const kindLabel = item.kind === 'master' ? 'master group' : 'group';
  const pick = await vscode.window.showQuickPick<ColorPick>(picks, {
    placeHolder: `Pick a color for "${item.groupName}" (${kindLabel})`,
  });
  if (!pick) return;
  index.setGroupColor(item.workspaceHash, item.groupId, pick.colorId || undefined);
  refreshSidebar();
}

async function cmdRenameGroup(index: SessionIndex, item?: GroupTreeItem): Promise<void> {
  if (!item) return;
  const next = await vscode.window.showInputBox({
    prompt: 'Rename group',
    value: item.groupName,
    validateInput: v => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
  });
  if (!next || next === item.groupName) return;
  index.renameGroup(item.workspaceHash, item.groupId, next);
  refreshSidebar();
}

async function cmdDeleteGroup(index: SessionIndex, item?: GroupTreeItem): Promise<void> {
  if (!item) return;
  let tail: string;
  let title: string;
  if (item.kind === 'master') {
    const n = item.childGroupCount;
    title = `Delete master group "${item.groupName}"?`;
    tail = n > 0
      ? `\n\n${n} group${n === 1 ? '' : 's'} inside will move up one level (to this master's parent, or the workspace root). No sessions are touched.`
      : '';
  } else {
    const count = item.sessions.length;
    title = `Delete group "${item.groupName}"?`;
    tail = count > 0
      ? `\n\n${count} session${count === 1 ? '' : 's'} inside will move to the workspace root (none are killed).`
      : '';
  }
  const confirm = await vscode.window.showWarningMessage(`${title}${tail}`, { modal: true }, 'Delete');
  if (confirm !== 'Delete') return;
  index.deleteGroup(item.workspaceHash, item.groupId);
  refreshSidebar();
}

async function cmdMoveSessionToGroup(index: SessionIndex, item?: SessionTreeItem, selection?: vscode.TreeItem[]): Promise<void> {
  if (!item) return;
  const hash = item.session.workspaceHash;
  // Bulk: pick the destination once, move the whole selection. Groups are
  // workspace-scoped, so rows from other workspaces are left alone.
  const many = selectionTargets(selection)?.filter(r => r.session.workspaceHash === hash);
  const targets = many && many.length > 1 ? many : [item];
  const groups = index.getGroups(hash);
  // `action` instead of `kind` — `kind` collides with QuickPickItem.kind
  // (QuickPickItemKind.Separator etc.) and breaks the type extension.
  interface Pick extends vscode.QuickPickItem { action: 'group' | 'new' | 'remove'; groupId?: string }
  const picks: Pick[] = [];
  for (const [gid, g] of Object.entries(groups)) {
    // Single-target: hide the group it's already in. Multi: offer everything —
    // members already there just stay put.
    if (targets.length === 1 && targets[0].session.groupId === gid) continue;
    if (g.kind === 'master') continue; // masters hold only groups; a session moved
    // into one would render nowhere and vanish from the sidebar (drag-drop already
    // rejects this; the picker must too).
    picks.push({ action: 'group', groupId: gid, label: `$(folder-library) ${g.name}` });
  }
  picks.push({ action: 'new', label: '$(add) New group...' });
  if (targets.some(t => t.session.groupId)) {
    picks.push({ action: 'remove', label: '$(circle-slash) Remove from group (move to root)' });
  }
  const pick = await vscode.window.showQuickPick<Pick>(picks, {
    placeHolder: targets.length > 1
      ? `Move ${targets.length} sessions to:`
      : `Move "${item.session.label || item.session.name}" to:`,
  });
  if (!pick) return;
  let destGroupId: string | undefined;
  if (pick.action === 'new') {
    const name = await vscode.window.showInputBox({
      prompt: 'New group name',
      validateInput: v => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
    });
    if (!name) return;
    const gid = index.createGroup(hash, name);
    if (!gid) return;
    destGroupId = gid;
  } else if (pick.action === 'group' && pick.groupId) {
    destGroupId = pick.groupId;
  } // 'remove' leaves destGroupId undefined → move to root
  for (const t of targets) index.setSessionGroup(hash, t.session.name, destGroupId);
  refreshSidebar();
}

/**
 * Resume ANY past session from disk (cross-agent), even when nothing is live in
 * tmux for it. Scans every enabled provider's on-disk sessions (default: the
 * current workspace's cwd; a toggle widens to all projects). Each row has an eye
 * button (View Conversation) and an edit button (Name Conversation). Accepting a
 * row resumes it into the active Terminal Sessions terminal (if any) or a new
 * persistent session.
 */
async function cmdResumeFromArchive(
  index: SessionIndex,
  registry: AgentRegistry,
): Promise<void> {
  const ws = currentWorkspace();
  let scopeCwd: string | undefined = ws?.path;

  const eyeBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('book'), tooltip: 'View Conversation' };
  const editBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename Conversation' };

  interface Pick extends vscode.QuickPickItem { sess?: ArchivedSession; toggle?: boolean }

  const build = (): Pick[] => {
    const sessions = scanArchive(registry.enabled(), (id) => index.getSessionName(id), scopeCwd);
    const rows: Pick[] = sessions.slice(0, 500).map(s => {
      const provider = registry.getProvider(s.agent);
      const badge = provider?.displayName || s.agent;
      const primary = conversationTitle(s, id => index.getSessionName(id)).title || '(no user message)';
      const lines = (s.lineCount ?? 0).toLocaleString();
      const ageMs = Date.now() - (s.mtimeMs ?? Date.now());
      const ageMin = Math.round(ageMs / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 24 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 60 / 24)}d`;
      const cwdShort = s.cwd ? s.cwd.replace(/^\/Users\/[^/]+\//, '~/') : '?';
      return {
        sess: s,
        label: `$(comment-discussion) ${primary}`,
        description: `${badge} · ${lines} lines · ${ageStr} ago · ${s.sessionId.slice(0, 8)}`,
        detail: cwdShort,
        buttons: [eyeBtn, editBtn],
      };
    });
    const toggle: Pick = {
      toggle: true,
      label: scopeCwd ? '$(globe) Show sessions from all projects...' : '$(home) Show only this workspace',
      alwaysShow: true,
    };
    return [toggle, ...rows];
  };

  const qp = vscode.window.createQuickPick<Pick>();
  qp.matchOnDetail = true;
  // Keep the picker open when a row button (View / Name) opens another UI —
  // otherwise the focus change hides it and the user must re-run the command and
  // scroll back, defeating the browse-then-resume flow the buttons exist for.
  qp.ignoreFocusOut = true;
  const refresh = () => {
    qp.placeholder = scopeCwd
      ? `Resume a past session (this workspace${ws?.label ? ' — ' + ws.label : ''})`
      : 'Resume a past session (all projects)';
    qp.items = build();
  };
  refresh();

  const chosen = await new Promise<Pick | undefined>((resolve) => {
    qp.onDidTriggerItemButton(async (e) => {
      const s = e.item.sess;
      if (!s || !s.transcriptPath) return;
      if (e.button === eyeBtn) {
                await vscode.commands.executeCommand(COMMAND.viewConversation, { transcriptPath: s.transcriptPath, title: conversationTitle(s, id => index.getSessionName(id)).title });
      } else if (e.button === editBtn) {
                const name = await vscode.commands.executeCommand<string | undefined>(COMMAND.nameSession, {
          sessionId: s.sessionId,
          current: conversationTitle(s, id => index.getSessionName(id), 200).title,
          transcriptPath: s.transcriptPath,
          agent: s.agent,
        });
        if (name !== undefined) refresh();
      }
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel?.toggle) { scopeCwd = scopeCwd ? undefined : ws?.path; refresh(); return; }
      resolve(sel);
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.hide();
  qp.dispose();
  if (!chosen?.sess?.transcriptPath) return;

  const s = chosen.sess;
  const provider = registry.getProvider(s.agent);
  if (!provider) return;

  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();

  // Resume target: reuse the active TS terminal if the user has one, else make a
  // new persistent session. The provider's buildResumeCommand handles cd-to-cwd.
  const active = vscode.window.activeTerminal;
  const activeName = active ? await resolveTmuxNameForTerminalLive(active, index, cfg.sessionPrefix) : undefined;
  let useActive = false;
  if (active && activeName) {
    const choice = await vscode.window.showQuickPick(['Resume in active session', 'New session'], {
      placeHolder: 'Where should this conversation resume?',
    });
    if (!choice) return;
    useActive = choice === 'Resume in active session';
  }

  if (useActive && active) {
    active.sendText(buildResumeCommand(provider, s.sessionId, s.transcriptPath, s.cwd || ''));
    active.show();
    return;
  }

  // New persistent session (mirrors cmdNewPersistent), then send resume.
  if (!ws) { vscode.window.showErrorMessage('No workspace folder open to create a session in.'); return; }
  index.recordWorkspace(ws.hash, ws.path, ws.label);
  const tabId = await nextSafeTabId(index, tmuxPath, cfg.sessionPrefix, ws.hash);
  const name = buildSessionName(cfg.sessionPrefix, ws.hash, tabId);
  index.recordSession(ws.hash, name);
  const meta = index.getSessionMeta(ws.hash, name);
  const { icon, color } = metaIconAndColor(meta);
  const term = vscode.window.createTerminal({
    name: `${ws.label} ${tabId}`,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachOrCreateArgs(name, ws.path),
    cwd: ws.path,
    iconPath: icon,
    color,
  });
  term.show();
  refreshSidebar();
  await sleep(SHELL_INIT_DELAY_MS);
  term.sendText(buildResumeCommand(provider, s.sessionId, s.transcriptPath, ws.path));
}

/**
 * Find empty / invalid sessions and soft-delete them into ~/.claude/projects/.bak.
 * Default scope is the current workspace; a scope step can widen to all projects.
 * HARD BOUNDARY: only session .jsonl files (+ subagents dirs) are moved. Claude's
 * __store.db / index are never touched.
 */
async function cmdCleanupSessions(
  index: SessionIndex,
  registry: AgentRegistry,
): Promise<void> {
  const ws = currentWorkspace();
  const scopeChoice = await vscode.window.showQuickPick(
    [
      { label: '$(home) This workspace only', all: false },
      { label: '$(globe) All projects', all: true },
    ],
    { placeHolder: 'Scan which sessions for cleanup?' },
  );
  if (!scopeChoice) return;
  const scopeCwd = scopeChoice.all ? undefined : ws?.path;

  // Claude ONLY. The 'empty'/'invalid' classifier below is Claude-format
  // (readTranscriptSummary sniffs Claude JSONL) and the .bak soft-delete scheme
  // assumes the ~/.claude/projects layout. Scanning every enabled provider made
  // it score every Codex/agy/grok rollout as 'empty' (0 Claude-shaped turns) and
  // bulk-move real, resumable conversations out of ~/.codex/sessions. Restrict to
  // Claude so a foreign agent's transcripts are never classified or moved.
  const claudeProvider = registry.getProvider('claude');
  if (!claudeProvider) {
    vscode.window.showInformationMessage('Session cleanup applies to Claude sessions only, and Claude is not enabled.');
    return;
  }
  const sessions = scanArchive([claudeProvider], (id) => index.getSessionName(id), scopeCwd);
  const targets: Array<{ s: ArchivedSession; verdict: 'empty' | 'invalid' }> = [];
  for (const s of sessions) {
    if (!s.transcriptPath) continue;
    const summary = readTranscriptSummary(s.transcriptPath);
    const verdict = classifyForCleanup(summary);
    if (verdict === 'empty' || verdict === 'invalid') targets.push({ s, verdict });
  }

  if (targets.length === 0) {
    vscode.window.showInformationMessage('No empty or invalid sessions found.');
    return;
  }

  const nEmpty = targets.filter(t => t.verdict === 'empty').length;
  const nInvalid = targets.filter(t => t.verdict === 'invalid').length;
  const confirm = await vscode.window.showWarningMessage(
    `Move ${targets.length} session(s) to .bak (${nEmpty} empty, ${nInvalid} invalid)? Claude's database is left untouched; files go to ~/.claude/projects/.bak and can be restored manually.`,
    { modal: true },
    'Move to .bak',
  );
  if (confirm !== 'Move to .bak') return;

  let moved = 0;
  let failed = 0;
  for (const t of targets) {
    const r = softDeleteSession(t.s.transcriptPath!);
    if (r.ok) moved++; else { failed++; console.error('[terminal-sessions] cleanup failed:', t.s.transcriptPath, r.error); }
  }
  vscode.window.showInformationMessage(`Cleanup done: moved ${moved}${failed ? `, skipped ${failed} (see console)` : ''}.`);
}

/**
 * Manual resume picker. Right-click on a session → "Resume Other Claude
 * Session..." surfaces every sessionId Claude ever recorded a hook for in this
 * tmux (the `claudeSessionHistory`), with cwd, line count, last-modified time,
 * and the first user prompt preview. The user picks one explicitly; we send
 * `cd <cwd> && claude --resume <id>` to the session's terminal.
 *
 * Useful when auto-resume's smart pick is still wrong (history pollution from
 * brief cross-workspace touches, multiple substantial conversations that all
 * live under the same folderPath, etc.) or when the user wants to revisit an
 * older conversation that's been dropped from auto-resume's preference order.
 */
async function cmdResumeOtherClaude(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem,
): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a session and choose "Resume Other Session..." — the picker scopes to that session\'s history.');
    return;
  }
  const session = item.session;
  const meta = index.getSessionMeta(session.workspaceHash, session.name);
  const cwd = meta?.folderPath || session.workspacePath || '';
  const { provider, history } =
    resumeContextFor(index, registry, claudeTracker, session.workspaceHash, session.name);
  const candidates = gatherResumeCandidates(provider, history, cwd);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      `No resumable ${provider.displayName} transcripts in this session's history. Either none have ever run here, or all their transcripts were deleted.`,
    );
    return;
  }

  // Sort by mtime DESC so the most recently touched ones surface first.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  interface Pick extends vscode.QuickPickItem { sid: string; transcriptPath: string; recordedCwd?: string }
  const picks: Pick[] = candidates.map(c => {
    // Native /rename title → sidecar name → agent's auto title → first prompt.
    const firstUser = conversationTitle(c, id => index.getSessionName(id)).title || '(no user message yet)';
    const prompt = c.firstUserMessage?.replace(/\s+/g, ' ').slice(0, 80);
    const cwdShort = (c.cwd ? c.cwd.replace(/^\/Users\/[^/]+\//, '~/') : '?')
      + (prompt && prompt !== firstUser ? ` · ${prompt}` : '');
    const lines = c.lineCount.toLocaleString();
    const ageMs = Date.now() - c.mtimeMs;
    const ageMin = Math.round(ageMs / 60000);
    const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 24 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 60 / 24)}d`;
    return {
      sid: c.sessionId,
      transcriptPath: c.transcriptPath,
      recordedCwd: c.cwd,
      label: `$(comment-discussion) ${firstUser}`,
      description: `${lines} lines · ${ageStr} ago · ${c.sessionId.slice(0, 8)}`,
      detail: cwdShort,
    };
  });
  const pick = await vscode.window.showQuickPick<Pick>(picks, {
    placeHolder: `Pick a ${provider.displayName} conversation to resume in "${session.label || session.name}"`,
    matchOnDetail: true,
  });
  if (!pick) return;

  // Find or create the terminal. If session is stopped, we can't resume —
  // the tmux session has no process to attach to. Prompt user to Start first.
  if (session.stopped) {
    const choice = await vscode.window.showInformationMessage(
      `Session "${session.label || session.name}" is stopped. Start it first?`,
      'Start and Resume', 'Cancel',
    );
    if (choice !== 'Start and Resume') return;
    // Re-create tmux + attach. We don't call cmdStart because it would auto-pick
    // a different sessionId; instead, mimic the minimum: setSessionStopped(false),
    // tmux.createDetachedSession, openTerminalForSession.
    const tmuxPath = await requireTmux();
    if (!tmuxPath) return;
    const exists = await tmux.hasSession(tmuxPath, session.name);
    if (!exists) await tmux.createDetachedSession(tmuxPath, session.name, cwd);
    index.setSessionStopped(session.workspaceHash, session.name, false);
    await openTerminalForSession(session.name, cwd, index, true);
    await sleep(SHELL_INIT_DELAY_MS);
    refreshSidebar();
  }

  const term = findTerminalForSession(session.name);
  if (!term) {
    vscode.window.showWarningMessage(
      `Couldn't find an attached terminal for "${session.label || session.name}". Click the session to attach, then try Resume again.`,
    );
    return;
  }

  // The provider builds its own resume command (and cd-to-recorded-cwd when
  // it's cwd-sensitive).
  term.sendText(buildResumeCommand(provider, pick.sid, pick.transcriptPath, cwd));
  term.show();
}

/**
 * Reveal the folder a session was opened in (its recorded `folderPath`, or the
 * workspace root when the session is workspace-level) — in the VS Code Explorer
 * or in Finder. Works from two places:
 *   - the sidebar session right-click (the SessionTreeItem is passed in);
 *   - the integrated-terminal right-click (no item → resolve the ACTIVE
 *     terminal back to its tmux session, then look up the folder).
 * This is the "take me to where I started this" action, distinct from the
 * selection-based "Reveal in Finder/Explorer" (reveal-path.ts) which resolves a
 * path the user highlighted in the terminal output.
 */
async function cmdRevealSessionFolder(
  index: SessionIndex,
  target: 'explorer' | 'finder',
  arg?: unknown,
): Promise<void> {
  let folder: string | undefined;
  const asItem = arg as SessionTreeItem | undefined;
  if (asItem?.session) {
    const s = asItem.session;
    const meta = index.getSessionMeta(s.workspaceHash, s.name);
    folder = meta?.folderPath || s.workspacePath;
  } else {
    // Terminal context (body or tab). Prefer a Terminal VS Code handed us; fall
    // back to the active terminal (right-clicking a tab activates it). Map it
    // back to its tmux session to find the folder it was opened in.
    const maybeTerm = arg as vscode.Terminal | undefined;
    const term = (maybeTerm && typeof maybeTerm.sendText === 'function')
      ? maybeTerm
      : vscode.window.activeTerminal;
    // Robust to reload-restored (⚠) terminals whose shellArgs were trimmed, and
    // to renamed tabs (resolves from the live process via PID as a last resort).
    const name = term ? await resolveTmuxNameForTerminalLive(term, index, getConfig().sessionPrefix) : undefined;
    const parsed = name ? parseSessionName(name, getConfig().sessionPrefix) : undefined;
    if (parsed && name) {
      const meta = index.getSessionMeta(parsed.hash, name);
      folder = meta?.folderPath || index.getWorkspace(parsed.hash)?.path;
    }
  }

  if (!folder) {
    vscode.window.showWarningMessage(
      'Could not determine the session folder. Right-click a session in the Terminal Sessions sidebar, or click inside a session terminal first.',
    );
    return;
  }
  if (!fs.existsSync(folder)) {
    vscode.window.showWarningMessage(`Session folder no longer exists on disk:\n${folder}`);
    return;
  }

  const uri = vscode.Uri.file(folder);
  if (target === 'finder') {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  } else {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }
}

/**
 * From a terminal tab / body, locate and select that session in the Terminal
 * Sessions sidebar — expanding any parent group/master so it scrolls into view.
 * VS Code exposes no double-click or inline-hover action for terminal tabs, so
 * this rides the right-click context menu (and tab focus already auto-reveals
 * via the onDidChangeActiveTerminal handler in extension.ts).
 */
async function cmdRevealSessionInSidebar(index: SessionIndex, arg?: unknown): Promise<void> {
  const maybeTerm = arg as vscode.Terminal | undefined;
  const term = (maybeTerm && typeof maybeTerm.sendText === 'function')
    ? maybeTerm
    : vscode.window.activeTerminal;
  const name = term
    ? await resolveTmuxNameForTerminalLive(term, index, getConfig().sessionPrefix)
    : undefined;
  if (!name) {
    vscode.window.showWarningMessage(
      'Could not determine the session for this terminal. Click inside a session terminal first.',
    );
    return;
  }
  // Make sure the view container is visible, then select + focus the session.
  await vscode.commands.executeCommand(COMMAND.revealSidebar);
  await revealSessionInSidebar(name, true);
}

/**
 * The most recent AI-agent session (its id + which agent) recorded for a tmux
 * session, newest first. Reads the agent-tagged `agentSessions` head and falls
 * back to the legacy Claude-only fields for index entries written before the
 * agent dimension existed. Returns undefined when no agent has ever run here.
 */
function latestAgentSession(
  index: SessionIndex,
  hash: string,
  name: string,
): { agent: AgentId; id: string } | undefined {
  const meta = index.getSessionMeta(hash, name);
  if (!meta) return undefined;
  const head = meta.agentSessions?.[0];
  if (head) return { agent: head.agent, id: head.id };
  const legacy = meta.claudeSessionHistory?.[0] ?? meta.lastClaudeSessionId;
  return legacy ? { agent: 'claude', id: legacy } : undefined;
}

/**
 * Copy the most-recent agent (Claude/Codex/agy) session UUID for a session to
 * the clipboard. Driven from the sidebar right-click; with no item (e.g. invoked
 * from the command palette) it explains what to do instead of failing silently.
 */
async function cmdCopySessionId(index: SessionIndex, item?: SessionTreeItem | vscode.Terminal): Promise<void> {
  const s = await resolveSessionInfoFromInvocation(item, index);
  if (!s) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar or a Terminal Sessions tab to copy its session ID.');
    return;
  }
  const latest = latestAgentSession(index, s.workspaceHash, s.name);
  if (!latest) {
    vscode.window.showInformationMessage(`No agent session has run in "${s.label || s.name}" yet — nothing to copy.`);
    return;
  }
  await vscode.env.clipboard.writeText(latest.id);
  vscode.window.setStatusBarMessage(`Copied last session ID ${latest.id}`, 2500);
}

/**
 * Copy the full path to a session's transcript .jsonl (e.g.
 * `~/.claude/projects/<slug>/<uuid>.jsonl`) to the clipboard. Resolves the path
 * through the owning agent's provider so it works for Claude/Codex/agy alike,
 * returning the computed path even when the file isn't written yet.
 */
async function cmdCopySessionPath(index: SessionIndex, registry: AgentRegistry, item?: SessionTreeItem | vscode.Terminal): Promise<void> {
  const s = await resolveSessionInfoFromInvocation(item, index);
  if (!s) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar or a Terminal Sessions tab to copy its transcript path.');
    return;
  }
  const latest = latestAgentSession(index, s.workspaceHash, s.name);
  if (!latest) {
    vscode.window.showInformationMessage(`No agent session has run in "${s.label || s.name}" yet — no transcript to copy.`);
    return;
  }
  const meta = index.getSessionMeta(s.workspaceHash, s.name);
  const cwd = meta?.folderPath || s.workspacePath || '';
  const provider = registry.getProvider(latest.agent) ?? registry.providerForAgent('claude');
  const transcriptPath = provider.resolveTranscriptPath(latest.id, cwd);
  if (!transcriptPath) {
    vscode.window.showWarningMessage(`Couldn't resolve a transcript path for ${latest.id}.`);
    return;
  }
  await vscode.env.clipboard.writeText(transcriptPath);
  vscode.window.setStatusBarMessage(`Copied last session path ${transcriptPath}`, 3000);
}

async function cmdAttachTo(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name: string | undefined = item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    if (all.length === 0) {
      vscode.window.showInformationMessage('No persistent sessions found.');
      return;
    }
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const picks: Pick[] = all.map(s => ({
      label: `$(${s.icon || (s.attached ? 'pass-filled' : 'circle-outline')}) ${s.label || `#${s.tabId}`}`,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      detail: s.workspacePath,
      sessionName: s.name,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Select a session to attach to' });
    if (!pick) return;
    name = pick.sessionName;
  }
  await openTerminalForSession(name, undefined, index);
  refreshSidebar();
}

async function cmdKill(
  index: SessionIndex,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  // Accepts a sidebar row OR a native terminal tab (right-click → Kill Session);
  // the shared resolver maps a vscode.Terminal back to its tmux session name.
  let name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    // Locked sessions are protected from Kill — keep them out of the picker.
    const picks: Pick[] = all.filter(s => !s.locked).map(s => ({
      label: s.label || s.name,
      description: s.workspaceLabel,
      sessionName: s.name,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Kill which session?' });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsedForLabel = parseSessionName(name, cfg.sessionPrefix);
  const label = parsedForLabel ? index.getSessionLabel(parsedForLabel.hash, name) : undefined;
  // Backstop: a locked session must be unlocked first. The sidebar hides Kill on
  // locked rows, but the command palette or a stale tree item could still land here.
  if (parsedForLabel && index.isSessionLocked(parsedForLabel.hash, name)) {
    vscode.window.showWarningMessage(
      `🔒 "${label || name}" is locked. Right-click → Unlock it first to kill.`,
    );
    return;
  }
  const displayName = label ? `"${label}" (${name})` : name;
  const confirm = await vscode.window.showWarningMessage(
    `Kill session ${displayName}? All processes inside will terminate.`,
    { modal: true }, 'Kill',
  );
  if (confirm !== 'Kill') return;
  await tmux.killSession(tmuxPath, name);
  if (parsedForLabel) index.removeSession(parsedForLabel.hash, name, cfg.killedLimit);
  refreshSidebar();
}

/** Bulk Kill over a multi-selection: one aggregate confirmation, then each
 *  session goes to the graveyard exactly like a single Kill. Locked rows are
 *  skipped (and said so), never silently killed. */
async function cmdKillMany(index: SessionIndex, rows: SessionTreeItem[]): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  const targets: { hash: string; name: string }[] = [];
  let lockedSkipped = 0;
  for (const r of rows) {
    const parsed = parseSessionName(r.session.name, cfg.sessionPrefix);
    if (!parsed) continue;
    if (index.isSessionLocked(parsed.hash, r.session.name)) { lockedSkipped++; continue; }
    targets.push({ hash: parsed.hash, name: r.session.name });
  }
  if (targets.length === 0) {
    if (lockedSkipped > 0) vscode.window.showWarningMessage('All selected sessions are locked. Unlock them first to kill.');
    return;
  }
  const lockedNote = lockedSkipped > 0 ? `\n\n${lockedSkipped} locked session(s) will be kept.` : '';
  const confirm = await vscode.window.showWarningMessage(
    `Kill ${targets.length} sessions? All processes inside them will terminate.${lockedNote}`,
    { modal: true }, 'Kill All',
  );
  if (confirm !== 'Kill All') return;
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    try { await tmux.killSession(tmuxPath, t.name); } catch { /* already dead — still remove below */ }
    index.removeSession(t.hash, t.name, cfg.killedLimit);
  }
  refreshSidebar();
}

/** Kill a session AND permanently delete its conversations' on-disk data
 *  (transcripts, sidecar dirs, todos, scratchpads) across every agent. The
 *  session is hard-removed from the index — no graveyard entry, since Restore
 *  without a conversation would be meaningless. Conversations that another
 *  session still uses (live in its pane, or recorded as its resume history)
 *  are skipped so we never destroy someone else's discussion. */
async function cmdKillDelete(
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  registry: AgentRegistry,
  item?: SessionTreeItem | vscode.Terminal,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  const name = await resolveSessionNameFromInvocation(item, index, cfg.sessionPrefix);
  if (!name) return; // context-menu only — no picker for a destructive command
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const ws = index.getWorkspace(parsed.hash);
  const meta = ws?.sessions[name];
  const label = meta?.label;
  const displayName = label ? `"${label}" (${name})` : name;
  if (index.isSessionLocked(parsed.hash, name)) {
    vscode.window.showWarningMessage(
      `🔒 "${label || name}" is locked. Right-click → Unlock it first.`,
    );
    return;
  }
  const plan = buildTrashPlan(index, claudeTracker, registry, parsed.hash, name);
  const convCount = plan.targets.length;
  const skippedNote = plan.skipped.length > 0
    ? `\n${plan.skipped.length} conversation(s) will be kept — still used by other sessions.`
    : '';
  const detail = convCount > 0
    ? `Deletes ${convCount} conversation(s), ${plan.fileCount} file(s), ${formatBytes(plan.totalBytes)} from disk.${skippedNote}`
    : `No conversation data found on disk.${skippedNote}`;
  const confirm = await vscode.window.showWarningMessage(
    `Kill ${displayName} and permanently delete its data?\n\n${detail}\n\nThis cannot be undone. The session will NOT appear in Killed Sessions.`,
    { modal: true }, 'Delete Data & Kill',
  );
  if (confirm !== 'Delete Data & Kill') return;
  await tmux.killSession(tmuxPath, name);
  claudeTracker.forgetSession(name);
  const result = executeTrash(plan);
  index.removeSession(parsed.hash, name, 0); // cap 0 = hard delete, no graveyard
  refreshSidebar();
  if (result.failures.length > 0) {
    vscode.window.showWarningMessage(
      `Session killed; freed ${formatBytes(result.freedBytes)}, but ${result.failures.length} item(s) could not be deleted: ${result.failures[0]}`,
    );
  } else if (result.deletedPaths > 0) {
    vscode.window.showInformationMessage(
      `Session killed. Deleted ${result.deletedPaths} item(s), freed ${formatBytes(result.freedBytes)}.`,
    );
  }
}

/** Ownership-guarded deletion plan for one session's conversations — shared by
 *  the single and bulk Kill & Delete paths. A conversation is only deletable
 *  when THIS session is its strongest claimant in the index and no other live
 *  pane is running it. */
function buildTrashPlan(
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  registry: AgentRegistry,
  hash: string,
  name: string,
): ReturnType<typeof planTrash> {
  const ws = index.getWorkspace(hash);
  const meta = ws?.sessions[name];
  const owners = ws
    ? index.conversationOwners(hash, Object.keys(ws.sessions))
    : new Map<string, string>();
  const shouldSkip = (agent: AgentId, id: string): string | undefined => {
    if (claudeTracker.isConversationTaken(id, name)) return 'live in another session';
    const owner = owners.get(`${agent} ${id}`);
    if (owner && owner !== name) return `used by ${owner}`;
    return undefined;
  };
  const cwd = meta?.folderPath || ws?.path || '';
  return meta
    ? planTrash(
      meta,
      cwd,
      (agent, id, c) => registry.getProvider(agent)?.resolveTranscriptPath(id, c),
      shouldSkip,
    )
    : { targets: [], skipped: [], totalBytes: 0, fileCount: 0 };
}

/** Bulk Kill & Delete Data: per-session ownership-guarded plans, ONE aggregate
 *  confirmation with the combined size, then each session is killed and
 *  hard-removed exactly like the single-session path. Locked rows are skipped.
 *  Plans are re-validated path-by-path at execute time (see executeTrash), so
 *  a stale plan can refuse, never mis-delete. */
async function cmdKillDeleteMany(
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  registry: AgentRegistry,
  rows: SessionTreeItem[],
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  interface Target { hash: string; name: string; plan: ReturnType<typeof planTrash> }
  const targets: Target[] = [];
  let lockedSkipped = 0;
  for (const r of rows) {
    const parsed = parseSessionName(r.session.name, cfg.sessionPrefix);
    if (!parsed) continue;
    if (index.isSessionLocked(parsed.hash, r.session.name)) { lockedSkipped++; continue; }
    targets.push({
      hash: parsed.hash,
      name: r.session.name,
      plan: buildTrashPlan(index, claudeTracker, registry, parsed.hash, r.session.name),
    });
  }
  if (targets.length === 0) {
    if (lockedSkipped > 0) vscode.window.showWarningMessage('All selected sessions are locked. Unlock them first.');
    return;
  }
  const convCount = targets.reduce((a, t) => a + t.plan.targets.length, 0);
  const fileCount = targets.reduce((a, t) => a + t.plan.fileCount, 0);
  const totalBytes = targets.reduce((a, t) => a + t.plan.totalBytes, 0);
  const keptCount = targets.reduce((a, t) => a + t.plan.skipped.length, 0);
  const notes = [
    keptCount > 0 ? `${keptCount} conversation(s) will be kept — still used by other sessions.` : '',
    lockedSkipped > 0 ? `${lockedSkipped} locked session(s) will be kept.` : '',
  ].filter(Boolean).join('\n');
  const detail = convCount > 0
    ? `Deletes ${convCount} conversation(s), ${fileCount} file(s), ${formatBytes(totalBytes)} from disk.${notes ? `\n${notes}` : ''}`
    : `No conversation data found on disk.${notes ? `\n${notes}` : ''}`;
  const confirm = await vscode.window.showWarningMessage(
    `Kill ${targets.length} sessions and permanently delete their data?\n\n${detail}\n\nThis cannot be undone. The sessions will NOT appear in Killed Sessions.`,
    { modal: true }, 'Delete Data & Kill All',
  );
  if (confirm !== 'Delete Data & Kill All') return;
  let freed = 0;
  let deleted = 0;
  const failures: string[] = [];
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    try { await tmux.killSession(tmuxPath, t.name); } catch { /* already dead */ }
    claudeTracker.forgetSession(t.name);
    const result = executeTrash(t.plan);
    freed += result.freedBytes;
    deleted += result.deletedPaths;
    failures.push(...result.failures);
    index.removeSession(t.hash, t.name, 0); // cap 0 = hard delete, no graveyard
  }
  refreshSidebar();
  if (failures.length > 0) {
    vscode.window.showWarningMessage(
      `${targets.length} sessions killed; freed ${formatBytes(freed)}, but ${failures.length} item(s) could not be deleted: ${failures[0]}`,
    );
  } else if (deleted > 0) {
    vscode.window.showInformationMessage(
      `${targets.length} sessions killed. Deleted ${deleted} item(s), freed ${formatBytes(freed)}.`,
    );
  }
}

/** Bulk Restart: one aggregate confirmation, then each selected session is
 *  relaunched with its own preserved flags and resumed conversation, exactly
 *  like a single Restart (whose per-session modal is what the aggregate
 *  confirmation replaces). */
async function cmdRestartMany(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  rows: SessionTreeItem[],
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const confirm = await vscode.window.showWarningMessage(
    `Restart ${rows.length} sessions?\n\nKills each tmux session (any running program in it, including Claude Code) and recreates it with the same name, workspace, icon, and color; detected agent conversations auto-resume.`,
    { modal: true }, 'Restart All',
  );
  if (confirm !== 'Restart All') return;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const target = await resolveRelaunchTarget(tmuxPath, index, registry, claudeTracker, r, '');
    if (!target) continue;
    // eslint-disable-next-line no-await-in-loop
    await relaunchSession(
      tmuxPath, target, index, claudeTracker,
      () => index.getResumeFlags(target.hash, target.name, target.provider.id),
      'Restart',
    );
  }
}

/** Mirror the special-folder settings into context keys so the view's ⋯
 *  menu shows exactly one of Enable/Disable per folder. Called at activation
 *  and whenever the settings change (incl. edits in the Settings UI). */
export async function syncSpecialFolderContexts(): Promise<void> {
  const cfg = getConfig();
  await vscode.commands.executeCommand('setContext', 'terminalSessions.favoritesFolderEnabled', cfg.showFavoritesFolder);
  await vscode.commands.executeCommand('setContext', 'terminalSessions.openFolderEnabled', cfg.showOpenFolder);
  await vscode.commands.executeCommand('setContext', 'terminalSessions.backgroundFolderEnabled', cfg.showBackgroundFolder);
  await vscode.commands.executeCommand('setContext', 'terminalSessions.activityFolderEnabled', cfg.showActivityFolder);
  await vscode.commands.executeCommand('setContext', 'terminalSessions.killedFolderEnabled', cfg.showKilledFolder);
}

async function cmdSetSpecialFolder(key: 'showFavoritesFolder' | 'showOpenFolder' | 'showBackgroundFolder' | 'showActivityFolder' | 'showKilledFolder', value: boolean): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  // Write to the scope that currently defines the value: a workspace override
  // would shadow a Global write and make the toggle appear dead.
  const insp = c.inspect<boolean>(key);
  const target = insp?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : insp?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
  await syncSpecialFolderContexts();
  refreshSidebar();
}

/** Bring a killed session back from the graveyard: reinstate its index entry
 *  under a fresh tab id (the old one may be reused by now), then run the normal
 *  Start path, which recreates tmux and resumes its recorded conversation. */
async function cmdRestoreKilled(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  item?: KilledSessionItem,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let hash = item?.workspaceHash;
  let entry = item?.entry;
  if (!hash || !entry) {
    // Command Palette path. This is also the ONLY way back when a workspace's
    // last session was killed: with zero sessions the workspace row (and its
    // Killed Sessions folder) doesn't render, so the graveyard must stay
    // reachable without the sidebar.
    interface Pick extends vscode.QuickPickItem { hash: string; entry: import('./types').KilledEntry }
    const picks: Pick[] = [];
    for (const [h, ws] of Object.entries(index.getAllWorkspaces())) {
      for (const e of ws.killed ?? []) {
        picks.push({
          label: e.meta.label || e.name,
          description: `${ws.label} · killed ${humanAge(new Date(e.killedAt))}`,
          hash: h,
          entry: e,
        });
      }
    }
    if (picks.length === 0) {
      vscode.window.showInformationMessage('No killed sessions to restore.');
      return;
    }
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Restore which killed session?' });
    if (!pick) return;
    hash = pick.hash;
    entry = pick.entry;
  }
  const tabId = await nextSafeTabId(index, tmuxPath, cfg.sessionPrefix, hash);
  const newName = buildSessionName(cfg.sessionPrefix, hash, tabId);
  // restoreKilled re-checks the slot after reloading the index and may bump the
  // tab id (two windows restoring at once can preallocate the same one) — start
  // the name it actually used, not the one we proposed.
  const restored = index.restoreKilled(hash, entry.name, entry.killedAt, newName);
  if (!restored) {
    // Raced with another window that already restored it — just repaint.
    refreshSidebar();
    return;
  }
  refreshSidebar();
  await cmdStart(index, registry, claudeTracker, undefined, restored.name);
}

async function cmdKillWorkspace(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const ws = currentWorkspace();
  if (!ws) return;
  const cfg = getConfig();
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  // Locked sessions are protected from bulk Kill — skip them and report how many.
  const mine = all.filter(s => s.workspaceHash === ws.hash && !s.locked);
  const lockedCount = all.filter(s => s.workspaceHash === ws.hash && s.locked).length;
  if (mine.length === 0) {
    vscode.window.showInformationMessage(
      lockedCount > 0
        ? `No sessions to kill — ${lockedCount} locked 🔒 session(s) skipped.`
        : 'No sessions to kill in this workspace.',
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Kill all ${mine.length} sessions for "${ws.label}"?` +
      (lockedCount > 0 ? `\n\n${lockedCount} locked 🔒 session(s) will be skipped.` : ''),
    { modal: true }, 'Kill All',
  );
  if (confirm !== 'Kill All') return;
  for (const s of mine) {
    await tmux.killSession(tmuxPath, s.name);
    index.removeSession(s.workspaceHash, s.name, cfg.killedLimit);
  }
  refreshSidebar();
}

async function cmdKillStale(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  if (cfg.pruneAfterDays <= 0) {
    vscode.window.showInformationMessage('Stale pruning is disabled (pruneAfterDays = 0).');
    return;
  }
  const cutoff = Date.now() - cfg.pruneAfterDays * 86400_000;
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  // Locked sessions are protected — never auto-prune one, however stale.
  const stale = all.filter(s => !s.attached && !s.locked && s.lastAttached.getTime() < cutoff);
  if (stale.length === 0) {
    vscode.window.showInformationMessage('No stale sessions.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Prune ${stale.length} session(s) older than ${cfg.pruneAfterDays} days?`,
    { modal: true }, 'Prune',
  );
  if (confirm !== 'Prune') return;
  for (const s of stale) {
    await tmux.killSession(tmuxPath, s.name);
    index.removeSession(s.workspaceHash, s.name, cfg.killedLimit);
  }
  refreshSidebar();
}


async function cmdRename(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  if (!item) return;
  const current = item.session.label ? `"${item.session.label}"` : `#${item.session.tabId}`;
  const newLabel = await vscode.window.showInputBox({
    prompt: `Rename session ${current}`,
    value: item.session.label || '',
    placeHolder: 'e.g. claude-main, dev-server',
    validateInput: (v) => v.length > 60 ? 'Label too long (max 60 chars)' : null,
  });
  if (newLabel === undefined) return;
  index.setSessionLabel(item.session.workspaceHash, item.session.name, newLabel.trim());
  refreshSidebar();
}

async function cmdResumeAll(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const ws = currentWorkspace();
  if (!ws) return;
  const cfg = getConfig();
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  const mine = all.filter(s => s.workspaceHash === ws.hash && !s.attached);
  if (mine.length === 0) {
    vscode.window.showInformationMessage('No detached sessions to resume.');
    return;
  }
  for (const s of mine) {
    await openTerminalForSession(s.name, ws.path, index);
    await sleep(150);
  }
  refreshSidebar();
}

async function cmdSetDefaultProfile(): Promise<void> {
  const platformKey = process.platform === 'darwin' ? 'osx'
    : process.platform === 'linux' ? 'linux' : 'windows';
  const settingKey = `terminal.integrated.defaultProfile.${platformKey}`;
  await vscode.workspace.getConfiguration().update(
    settingKey, 'Persistent Session', vscode.ConfigurationTarget.Global,
  );
  vscode.window.showInformationMessage(
    `Set "${settingKey}" = "Persistent Session". New terminals will auto-wrap in tmux.`,
  );
}

// ── Icon / color commands ────────────────────────────────────────────────

const ICON_CHOICES: { label: string; id: string; desc: string }[] = [
  { label: '$(terminal-bash) terminal', id: 'terminal-bash', desc: 'Default' },
  { label: '$(robot) robot',            id: 'robot',         desc: 'AI agent / Claude Code' },
  { label: '$(rocket) rocket',          id: 'rocket',        desc: 'Deploy / production' },
  { label: '$(flame) flame',            id: 'flame',         desc: 'Dev server / hot reload' },
  { label: '$(bug) bug',                id: 'bug',           desc: 'Debug' },
  { label: '$(beaker) beaker',          id: 'beaker',        desc: 'Experiment / test' },
  { label: '$(database) database',      id: 'database',      desc: 'Database / SQL' },
  { label: '$(globe) globe',            id: 'globe',         desc: 'Web / HTTP' },
  { label: '$(server) server',          id: 'server',        desc: 'Server / backend' },
  { label: '$(tools) tools',            id: 'tools',         desc: 'Build / compile' },
  { label: '$(package) package',        id: 'package',       desc: 'Package manager' },
  { label: '$(eye) eye',                id: 'eye',           desc: 'Watch / monitor' },
  { label: '$(symbol-event) event',     id: 'symbol-event',  desc: 'Event / listener' },
  { label: '$(repo) repo',              id: 'repo',          desc: 'Git / version control' },
  { label: '$(tag) tag',                id: 'tag',           desc: 'Release / tag' },
  { label: '$(dashboard) dashboard',    id: 'dashboard',     desc: 'Metrics / status' },
  { label: '$(lightbulb) lightbulb',    id: 'lightbulb',     desc: 'Prototype' },
  { label: '$(zap) zap',                id: 'zap',           desc: 'Quick / ad-hoc' },
  { label: '$(close) Reset to default', id: '',              desc: 'Remove custom icon' },
];

const COLOR_CHOICES: { label: string; id: string }[] = [
  { label: '$(close) Default (no color)',     id: '' },
  { label: '$(circle-filled) Red',            id: 'terminal.ansiRed' },
  { label: '$(circle-filled) Green',          id: 'terminal.ansiGreen' },
  { label: '$(circle-filled) Yellow',         id: 'terminal.ansiYellow' },
  { label: '$(circle-filled) Blue',           id: 'terminal.ansiBlue' },
  { label: '$(circle-filled) Magenta',        id: 'terminal.ansiMagenta' },
  { label: '$(circle-filled) Cyan',           id: 'terminal.ansiCyan' },
  { label: '$(circle-filled) Bright Red',     id: 'terminal.ansiBrightRed' },
  { label: '$(circle-filled) Bright Green',   id: 'terminal.ansiBrightGreen' },
  { label: '$(circle-filled) Bright Yellow',  id: 'terminal.ansiBrightYellow' },
  { label: '$(circle-filled) Bright Blue',    id: 'terminal.ansiBrightBlue' },
  { label: '$(circle-filled) Bright Magenta', id: 'terminal.ansiBrightMagenta' },
  { label: '$(circle-filled) Bright Cyan',    id: 'terminal.ansiBrightCyan' },
];

async function cmdSetIcon(index: SessionIndex, item?: SessionTreeItem, selection?: vscode.TreeItem[]): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar to set its icon.');
    return;
  }
  const many = selectionTargets(selection);
  interface IconPick extends vscode.QuickPickItem { iconId: string }
  const picks: IconPick[] = ICON_CHOICES.map(c => ({ label: c.label, description: c.desc, iconId: c.id }));
  const pick = await vscode.window.showQuickPick<IconPick>(picks, {
    placeHolder: many ? `Pick an icon for ${many.length} sessions` : 'Pick an icon for this session',
  });
  if (!pick) return;
  if (many) {
    bulkApply(
      many,
      (hash, name) => index.setSessionIcon(hash, name, pick.iconId || undefined),
      n => `Icon ${pick.iconId ? `set to "${pick.iconId}"` : 'cleared'} on ${n} sessions. Will apply on next attach/create.`,
    );
    return;
  }
  index.setSessionIcon(item.session.workspaceHash, item.session.name, pick.iconId || undefined);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Icon ${pick.iconId ? `set to "${pick.iconId}"` : 'cleared'}. Will apply on next attach/create.`,
  );
}

async function cmdSetColor(index: SessionIndex, item?: SessionTreeItem, selection?: vscode.TreeItem[]): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar to set its color.');
    return;
  }
  const many = selectionTargets(selection);
  interface ColorPick extends vscode.QuickPickItem { colorId: string }
  const picks: ColorPick[] = COLOR_CHOICES.map(c => ({ label: c.label, colorId: c.id }));
  const pick = await vscode.window.showQuickPick<ColorPick>(picks, {
    placeHolder: many ? `Pick a color for ${many.length} sessions` : 'Pick a color for this session',
  });
  if (!pick) return;
  if (many) {
    bulkApply(
      many,
      (hash, name) => index.setSessionColor(hash, name, pick.colorId || undefined),
      n => `Color ${pick.colorId ? `set to "${pick.colorId}"` : 'cleared'} on ${n} sessions. Will apply on next attach/create.`,
    );
    return;
  }
  index.setSessionColor(item.session.workspaceHash, item.session.name, pick.colorId || undefined);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Color ${pick.colorId ? `set to "${pick.colorId}"` : 'cleared'}. Will apply on next attach/create.`,
  );
}

