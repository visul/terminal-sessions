import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseSessionName } from './workspace-id';
import { detectTmuxPath, panePids, listSessions } from './tmux';
import { readAgentArgv, processTree, collectDescendantPids } from './agents/launch-flags';
import { readGrokActiveSessions } from './agents/grok/provider';
import type { SessionIndex } from './session-manager';
import type { AgentId, AgentProvider } from './agents/types';
import type { AgentRegistry } from './agents/registry';

import { notify, macosAlert, armToastAction } from './notifications';
import { classifyOutcome, outcomeIsBad, outcomeLabel, type TurnOutcome } from './outcome';
import { getConfig } from './config';
import {
  TranscriptTailer,
  TranscriptSnapshot,
  SubagentSnapshot,
} from './claude-transcript';

export type ClaudeState = 'none' | 'working' | 'tool' | 'waiting' | 'idle';

export interface ClaudeMapping {
  sessionId: string;
  /** Which AI CLI this session belongs to (claude/codex/agy). */
  agent: AgentId;
  cwd: string;
  transcriptPath?: string;
  timestamp: number;
}

export interface ClaudeSnapshot {
  state: ClaudeState;
  /** Which AI CLI produced this snapshot (drives the sidebar agent badge). */
  agent?: AgentId;
  sessionId?: string;
  lastPromptAt?: Date;
  lastStopAt?: Date;
  /** When the current run of the agent was launched (SessionStart). A stop that
   *  predates it belongs to a previous run. */
  lastStartAt?: Date;
  toolName?: string;
  toolInput?: string;
  toolSince?: Date;
  // Enriched from transcript
  model?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  lastAssistantMessageAt?: Date;
  messageCount?: number;
  tokens?: TranscriptSnapshot['tokens'];
  cost?: number;
  costByModel?: Record<string, number>;
  contextTokens?: number;
  contextLimit?: number;
  contextPct?: number;
  /** Path to the transcript jsonl (used by `Open Subagent Transcript`). */
  transcriptPath?: string;
  /** Flat list of subagents (tree is built at render time from parentId). */
  subagents?: SubagentSnapshot[];
  /** Timestamp at which `state` was set to 'waiting' by a permission-blocking
   *  Notification. Used by the transcript tailer to detect when Claude has
   *  resumed after the wait (new assistant/user activity newer than this) and
   *  clear the stuck waiting state. Cleared on Stop/UserPromptSubmit. */
  waitingSince?: Date;
  /** How the last turn ended (only meaningful while `state` is 'idle'). */
  outcome?: TurnOutcome;
  /** Set while the session finished since the user last focused its terminal.
   *  Drives the green/red/amber "unread" row look; cleared by markSeen. */
  unread?: 'done' | 'error' | 'asked';
  /** True when a 'waiting' state is being shown as idle because the user
   *  dismissed it; any newer agent activity un-dismisses automatically. */
  dismissed?: boolean;
}

interface ClaudeEvent {
  event: string;
  /** Source agent id, written by the unified forwarder. Absent on legacy
   *  claude-events.log lines → treated as 'claude'. */
  agent?: string;
  ts: number;
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  transcriptPath?: string;
  toolName?: string;
  toolInput?: string;
  /** Claude Code attaches a `message` field to Notification events. Two known
   *  shapes: "Claude needs your permission to use {ToolName}" (real block) and
   *  "Claude is waiting for your input" (idle nudge fired ~60s after every
   *  Stop while sitting at the prompt). Captured by hook-script v3+; older
   *  installs leave this empty and are treated as permission for safety. */
  message?: string;
  /** Present only when the hook fired for an agent-team teammate or a Task-tool
   *  subagent. Claude Code attaches `agent_id`/`agent_type` to those payloads
   *  but NEVER to the main (lead) session's events, so the presence of
   *  `agentId` is the reliable discriminator. Teammates share the lead's tmux
   *  session, so we drop their events (see handleLine) to stop teammate Stops
   *  both spamming "done" notifications and overwriting the lead's tracked id. */
  agentId?: string;
  agentType?: string;
  /** Antigravity statusLine extras (forwarded by media/agent-hook.sh). agy's live
   *  context usage + model never appear in its transcript, only here. */
  agentState?: string;
  contextWindow?: Record<string, unknown>;
  model?: string;
}

/** Returns true when a Notification event is the harmless "Claude is waiting
 *  for your input" idle nudge that Claude Code fires ~60s after each Stop
 *  while the user is just sitting at the prompt. False for real permission
 *  blocks (Claude needs approval before continuing) and for any unknown shape
 *  (treated as permission so we don't accidentally hide a real block). */
function isIdleNudgeNotification(message: string | undefined): boolean {
  if (!message) return false; // legacy hook or empty payload — assume permission
  return /waiting for your input/i.test(message);
}

const ROOT = path.join(os.homedir(), '.terminal-sessions');
const LOG_PATH = path.join(ROOT, 'claude-events.log');
const MAP_PATH = path.join(ROOT, 'claude-map.json');
const OFFSET_PATH = path.join(ROOT, '.log-offset');
const HOOK_DEST = path.join(ROOT, 'claude-hook.sh');
// New unified, agent-tagged log written by media/agent-hook.sh (serves
// codex/agy and any migrated claude installs). The legacy claude-events.log is
// still read so already-running Claude sessions (which read settings.json at
// startup and keep using the old hook until restarted) aren't dropped.
const AGENT_LOG_PATH = path.join(ROOT, 'agent-events.log');
const AGENT_OFFSET_PATH = path.join(ROOT, '.agent-log-offset');
const AGENT_HOOK_DEST = path.join(ROOT, 'agent-hook.sh');
// Order: unified log first, legacy second. Both are tailed independently.
const LOG_PATHS = [AGENT_LOG_PATH, LOG_PATH];

const NOTIFY_COOLDOWN_MS = 5_000;
// Hook events older than this when we see them are historical — replayed from the
// log at activation (the user quit with an agent running and we're catching up).
// Their state transitions still apply, but firing a "done"/"needs approval" alert
// for something resolved hours ago is just noise (and a focus-stealing modal).
const NOTIFY_STALE_MS = 60_000;
// Rotate an event log once it grows past this so activation's tail read (and the
// append-only file itself) stay bounded. One prior generation is kept as <log>.1.
const LOG_ROTATE_CAP = 16 * 1024 * 1024;
// How much of each log's tail backfill scans to recover recent session ids/cwds.
const BACKFILL_TAIL_BYTES = 8 * 1024 * 1024;
// Sessions with no activity for this long are treated as 'idle' regardless of
// their last observed tool-use state (handles crashes / missed Stop events).
const STALE_TOOL_MS = 30 * 60 * 1000;
// Working-state stale timeout. Shorter than tool because 'working' means
// Claude is actively generating; if no tool call and no new assistant chunk
// in this window, Claude is either done or the Stop hook was missed.
// Common trigger: user hits Esc to cancel, and Claude exits without writing
// an interrupt marker the tailer can pick up.
const STALE_WORKING_MS = 2 * 60 * 1000;

// Grok has no global hook, so we discover its live sessions by polling
// ~/.grok/active_sessions.json and matching each session's pid to a tmux pane.
const GROK_POLL_MS = 5_000;

export class ClaudeTracker {
  private map = new Map<string, ClaudeMapping>();        // tmuxSession → mapping
  private snapshots = new Map<string, ClaudeSnapshot>(); // tmuxSession → snapshot
  private lastNotifyPerWs = new Map<string, number>();
  private lastWaitingNotifyPerSession = new Map<string, number>();
  private logOffsets = new Map<string, number>();   // logPath → byte offset
  private flagCapTried = new Set<string>();          // tmuxSession we've read launch flags for
  private grokTimer?: ReturnType<typeof setInterval>;
  private grokPolling = false;   // re-entrancy guard: a slow poll must not stack
  private watchers: fs.FSWatcher[] = [];
  private transcript = new TranscriptTailer();
  /** Last DERIVED state per tmux session, so getSnapshot can spot the
   *  working→idle edge even when no Stop hook fired (transcript-only idle). */
  private lastDerived = new Map<string, ClaudeState>();
  /** tmux → Date.now() when the user dismissed a waiting/unread row. A waiting
   *  state whose activity is older than this renders as idle. */
  private dismissedAt = new Map<string, number>();
  /** tmux session behind the currently active terminal tab (fed by extension.ts). */
  private activeTmux?: string;
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(
    private ctx: vscode.ExtensionContext,
    private registry: AgentRegistry,
    private index?: SessionIndex,
  ) {
    this.transcript.onChange(() => this._onChange.fire());
  }

  /** Attach the session index post-construction (used when the index is built
   *  after the tracker in the activation sequence). */
  setIndex(index: SessionIndex): void { this.index = index; }

  private isSessionMuted(tmuxSession: string): boolean {
    if (!this.index) return false;
    const cfg = getConfig();
    const parsed = parseSessionName(tmuxSession, cfg.sessionPrefix);
    if (!parsed) return false;
    return this.index.isSessionMuted(parsed.hash, tmuxSession);
  }

  start(): void {
    this.ensureFiles();
    this.loadMap();
    this.loadOffsets();
    this.backfillIndexFromLog();
    this.processNewEvents();
    this.rotateLogsIfHuge();
    this.watch();
    // Best-effort: seed transcript tailers for sessions we already know about
    for (const [tmux, map] of this.map) {
      if (map.sessionId && map.transcriptPath) {
        this.transcript.start(map.sessionId, map.transcriptPath, this.registry.providerForAgent(map.agent));
      }
      if (!this.snapshots.has(tmux)) {
        this.snapshots.set(tmux, { state: 'none', sessionId: map.sessionId, agent: map.agent });
      }
    }
    this.startGrokDiscovery();
  }

  dispose(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* noop */ } }
    this.watchers = [];
    if (this.grokTimer) { clearInterval(this.grokTimer); this.grokTimer = undefined; }
    this.transcript.dispose();
    this._onChange.dispose();
  }

  /** Look up the session-id most recently seen in a tmux session. */
  /**
   * Conversations a resume command has just been dispatched for, before the
   * relaunched agent's first hook event lands. tmuxSession → when.
   *
   * Without this, two resume actions a few seconds apart both read an index that
   * has not caught up yet and point two panes at one conversation: Restart tab A
   * (sends `--resume C`), then Restart tab B before A's agent has booted and
   * fired SessionStart, and B resolves C too. The live `map` only learns the
   * truth once hooks arrive, which is seconds later.
   */
  private pendingResumes = new Map<string, { tmuxSession: string; at: number }>();

  /** How long a dispatched-but-unconfirmed resume blocks other panes. Long enough
   *  to cover shell init + agent boot, short enough that a resume that never
   *  started (user closed the tab, command failed) frees the conversation again. */
  private static readonly RESUME_RESERVATION_MS = 90_000;

  /** Record that `tmuxSession` is about to resume `sessionId`. */
  reserveResume(sessionId: string, tmuxSession: string): void {
    this.pendingResumes.set(sessionId, { tmuxSession, at: Date.now() });
  }

  /**
   * The tmux session currently holding `sessionId`, or undefined when it is free.
   * Confirmed live ownership (hook events) wins; otherwise a still-fresh
   * reservation counts, so rapid successive user actions can't double-book one
   * conversation.
   */
  conversationHolder(sessionId: string): string | undefined {
    for (const [tmuxSession, m] of this.map.entries()) {
      if (m.sessionId === sessionId) return tmuxSession;
    }
    const pending = this.pendingResumes.get(sessionId);
    if (!pending) return undefined;
    if (Date.now() - pending.at > ClaudeTracker.RESUME_RESERVATION_MS) {
      this.pendingResumes.delete(sessionId);
      return undefined;
    }
    return pending.tmuxSession;
  }

  /** True when another pane already holds this conversation. */
  isConversationTaken(sessionId: string, byTmuxSession: string): boolean {
    const holder = this.conversationHolder(sessionId);
    return !!holder && holder !== byTmuxSession;
  }

  getSessionId(tmuxSession: string): string | undefined {
    return this.map.get(tmuxSession)?.sessionId;
  }

  /** Which AI CLI is live in a tmux session right now (undefined if none). */
  getAgent(tmuxSession: string): AgentId | undefined {
    return this.map.get(tmuxSession)?.agent;
  }

  /**
   * Forget all live tracker state for a tmux session: drops the map entry,
   * the snapshot, and any pending waiting-notify cooldown. Called from cmdStop
   * after we kill the tmux session — without this, the snap.sessionId keeps
   * pointing at a transcript that another tab may still be writing to, and
   * the row in the sidebar mirrors that foreign activity as if this session
   * were "working".
   */
  forgetSession(tmuxSession: string): void {
    const mapped = this.map.get(tmuxSession);
    this.map.delete(tmuxSession);
    this.snapshots.delete(tmuxSession);
    this.lastWaitingNotifyPerSession.delete(tmuxSession);
    this.flagCapTried.delete(tmuxSession);
    this.lastDerived.delete(tmuxSession);
    this.dismissedAt.delete(tmuxSession);
    // Stop tailing the transcript so a killed session stops doing 3s stat/parse
    // work (and holding an fs.watch) forever — but only when no OTHER tmux still
    // owns the same sessionId (ownership can transfer via resume in another tab).
    if (mapped?.sessionId) {
      const stillOwned = [...this.map.values()].some(m => m.sessionId === mapped.sessionId);
      if (!stillOwned) this.transcript.stopOne(mapped.sessionId);
    }
    this.saveMap();
    this._onChange.fire();
  }

  /** Waiting/working/unread counts for the activity-bar badge, computed only
   *  over the tracker's live snapshot map (the only sessions that can be
   *  waiting/working) instead of statSync-ing every session ever recorded. */
  attentionCounts(): { waiting: number; working: number; unread: number } {
    let waiting = 0;
    let working = 0;
    let unread = 0;
    for (const name of this.snapshots.keys()) {
      const snap = this.getSnapshot(name);
      if (!snap) continue;
      if (snap.state === 'waiting') waiting++;
      else if (snap.state === 'working' || snap.state === 'tool') working++;
      if (snap.unread) unread++;
    }
    return { waiting, working, unread };
  }

  // ───────────────────────── unread / dismiss ─────────────────────────

  private parsedOf(tmuxSession: string): { hash: string } | undefined {
    return parseSessionName(tmuxSession, getConfig().sessionPrefix) ?? undefined;
  }

  /** Called by extension.ts whenever the active terminal changes. Focusing a
   *  session's terminal is what "reads" it. */
  setActiveTmuxSession(name: string | undefined): void {
    this.activeTmux = name;
    if (name && vscode.window.state.focused) this.markSeen(name);
  }

  /** Re-apply "seen" for the active tab when the window regains focus. */
  onWindowFocused(): void {
    if (this.activeTmux) this.markSeen(this.activeTmux);
  }

  private isLookingAt(tmuxSession: string): boolean {
    return vscode.window.state.focused && this.activeTmux === tmuxSession;
  }

  markSeen(tmuxSession: string): void {
    const parsed = this.parsedOf(tmuxSession);
    if (!parsed || !this.index) return;
    if (!this.index.getSessionUnread(parsed.hash, tmuxSession)) return;
    this.index.setSessionUnread(parsed.hash, tmuxSession, undefined);
    this._onChange.fire();
  }

  /** Clear every unread marker in the index (palette command). */
  markAllSeen(): number {
    if (!this.index) return 0;
    let n = 0;
    for (const name of this.snapshots.keys()) {
      const parsed = this.parsedOf(name);
      if (parsed && this.index.getSessionUnread(parsed.hash, name)) {
        this.index.setSessionUnread(parsed.hash, name, undefined);
        n++;
      }
    }
    if (n) this._onChange.fire();
    return n;
  }

  /** Silence a waiting/unread row: the unread marker is cleared and a current
   *  'waiting' state renders as idle until the agent does something new. */
  dismiss(tmuxSession: string): void {
    if (this.snapshots.get(tmuxSession)?.state === 'waiting') {
      this.dismissedAt.set(tmuxSession, Date.now());
    }
    this.markSeen(tmuxSession);
    this._onChange.fire();
  }

  private unreadOf(tmuxSession: string): { kind: 'done' | 'error' | 'asked'; hint?: string } | undefined {
    if (!getConfig().unreadBadges) return undefined; // toggle off hides existing markers too
    const parsed = this.parsedOf(tmuxSession);
    if (!parsed || !this.index) return undefined;
    const u = this.index.getSessionUnread(parsed.hash, tmuxSession);
    return u ? { kind: u.kind, hint: u.hint } : undefined;
  }

  /** A turn just ended for `tmuxSession`. Flag it unread unless the user is
   *  looking at that very terminal right now. */
  private noteFinished(tmuxSession: string, outcome: TurnOutcome | undefined): void {
    if (!getConfig().unreadBadges) return;
    if (this.isLookingAt(tmuxSession)) return;
    const parsed = this.parsedOf(tmuxSession);
    if (!parsed || !this.index) return;
    const kind = outcomeIsBad(outcome) ? 'error' : outcome?.kind === 'asked-user' ? 'asked' : 'done';
    const hint = outcome?.kind === 'ok' ? undefined : outcome?.hint;
    this.index.setSessionUnread(parsed.hash, tmuxSession, { kind, at: new Date().toISOString(), hint });
    this.dismissedAt.delete(tmuxSession);
    this._onChange.fire();
  }

  /**
   * Merge hook-derived state with transcript-derived state into a single
   * snapshot the sidebar can render. Returns undefined if we've never seen
   * this tmux session have Claude.
   */
  getSnapshot(tmuxSession: string): ClaudeSnapshot | undefined {
    const raw = this.snapshots.get(tmuxSession);
    if (!raw) return undefined;
    const snap: ClaudeSnapshot = { ...raw };

    // Ownership check: if our snap.sessionId no longer matches the active
    // claude-map entry for this tmux, the sessionId was transferred to another
    // tmux (via `claude --resume <id>` in a different tab) or never registered
    // at all. The transcript file is alive and being written to by the new
    // owner, so the per-mtime "working" stale-out below won't fire and we'd
    // keep spinning on someone else's writes. Clear sessionId + state so this
    // row stops mirroring foreign activity.
    if (snap.sessionId) {
      const owner = this.map.get(tmuxSession);
      if (!owner || owner.sessionId !== snap.sessionId) {
        snap.sessionId = undefined;
        snap.state = 'none';
        // Keep the edge detector honest: a later re-acquired idle must not
        // pair with a pre-transfer 'working' and flag a phantom result.
        this.lastDerived.set(tmuxSession, 'none');
        return snap;
      }
    }

    // Age-out stale 'tool' state with a long timeout — legitimate tools
    // (builds, long tests) can run for many minutes. Key off when the TOOL
    // started (toolSince), not the prompt: a long agentic turn can run many
    // tools well past STALE_TOOL_MS after its single prompt, and a tool state
    // rebuilt after a window reload may have no lastPromptAt at all. A missing
    // timestamp is treated as stale rather than immortal.
    if (snap.state === 'tool') {
      const since = snap.toolSince ?? snap.lastPromptAt;
      if (!since || Date.now() - since.getTime() > STALE_TOOL_MS) {
        snap.state = 'idle';
      }
    }
    // Transcript file freshness — Claude streams chunks into the JSONL on
    // every reasoning/content step, so a live turn keeps bumping the mtime
    // even when the parsed assistant timestamp (`ta`) is locked at the
    // message-start time and doesn't advance during a long compose. We
    // compute it once and reuse below for both stale-out and the live-or-
    // idle classification in the transcript-tailer block.
    const mapping = this.map.get(tmuxSession);
    let transcriptMtimeMs = 0;
    if (mapping?.transcriptPath) {
      try { transcriptMtimeMs = fs.statSync(mapping.transcriptPath).mtimeMs; }
      catch { /* transcript gone */ }
    }
    const sinceWriteMs = transcriptMtimeMs > 0 ? Date.now() - transcriptMtimeMs : Infinity;
    const transcriptIsFresh = sinceWriteMs < 30_000;

    // 'working' stale-out: if Claude is supposedly working but the transcript
    // hasn't been touched in 90 seconds, the Stop hook was probably missed
    // (Esc cancellation, network drop, etc.) and we shouldn't keep claiming
    // it's working. Long-thinking turns producing output keep mtime fresh.
    // Only apply the mtime rule once the transcript actually EXISTS — a
    // brand-new session sits at working after UserPromptSubmit before Claude
    // writes its first line (mtime 0 → sinceWriteMs Infinity), and we must not
    // flash it to idle in that gap. Before the file exists, fall back to prompt
    // age (STALE_WORKING_MS) so a truly abandoned prompt still clears.
    if (snap.state === 'working') {
      if (transcriptMtimeMs > 0) {
        if (sinceWriteMs > 90_000) snap.state = 'idle';
      } else if (snap.lastPromptAt && Date.now() - snap.lastPromptAt.getTime() > STALE_WORKING_MS) {
        snap.state = 'idle';
      }
    }

    if (snap.sessionId) {
      const t = this.transcript.getSnapshot(snap.sessionId);
      if (t) {
        snap.transcriptPath = t.path;
        snap.subagents = t.subagents;
        snap.model = t.model;
        snap.lastUserMessage = t.lastUserMessage;
        snap.lastAssistantMessage = t.lastAssistantMessage;
        snap.lastAssistantMessageAt = t.lastAssistantMessageAt;
        snap.messageCount = t.messageCount;
        snap.tokens = t.tokens;
        snap.cost = t.cost;
        snap.costByModel = t.costByModel;
        // Prefer transcript-derived context, but only when it actually reports a
        // number. agy carries no context in its transcript (it arrives via the
        // statusLine event and is stored on the snapshot in handleLine), so an
        // unconditional assignment here would clobber that with the transcript's 0.
        if (t.currentContextLimit > 0 && t.currentContextTokens > 0) {
          snap.contextTokens = t.currentContextTokens;
          snap.contextLimit = t.currentContextLimit;
          snap.contextPct = t.currentContextTokens / t.currentContextLimit;
        }

        // Transcript is authoritative for working/idle — hooks may not fire
        // for sessions that started before our hook was installed (Claude Code
        // reads settings.json at startup, not mid-session). We preserve hook-
        // derived 'tool' state unconditionally because the transcript can't
        // tell us whether a tool_use block is still running or finished.
        // 'waiting' is preserved ONLY while there is no transcript activity
        // newer than the wait was set — Claude resuming (assistant chunk) or
        // the user re-prompting (newer user message) means the wait is over
        // and the state should fall back to idle/working.
        const tu = t.lastUserMessageAt?.getTime() || 0;
        const ta = t.lastAssistantMessageAt?.getTime() || 0;
        // Claude Code writes `[Request interrupted by user]` to the transcript
        // on Esc. Depending on timing, it can land as the last user message
        // (Esc while Claude was still thinking) or buried in the partial
        // assistant reply (Esc mid-stream). Check both.
        const interruptMarker =
          t.lastUserMessage?.includes('[Request interrupted by user]') ||
          t.lastAssistantMessage?.includes('[Request interrupted by user]');

        // Allow stuck 'waiting' to clear when the transcript shows newer
        // activity than the Notification timestamp, or when the snapshot was
        // built from a legacy hook (pre-v3) that didn't record waitingSince —
        // those entries would otherwise be stuck forever.
        const waitingSinceMs = snap.waitingSince?.getTime() ?? 0;
        const waitingIsStale = snap.state === 'waiting'
          && (waitingSinceMs === 0 || ta > waitingSinceMs || tu > waitingSinceMs);
        if (waitingIsStale) snap.waitingSince = undefined;

        // Esc during a tool call writes the interrupt marker but fires no
        // PostToolUse/Stop hook, so 'tool' would otherwise stick until the
        // 30-min age-out. Clear it when the interrupt (as the latest user line)
        // is newer than the tool started.
        if (snap.state === 'tool' && interruptMarker && tu > (snap.toolSince?.getTime() ?? 0)) {
          snap.state = 'idle';
          snap.toolName = undefined;
          snap.toolInput = undefined;
          snap.toolSince = undefined;
        }

        if (snap.state !== 'tool' && (snap.state !== 'waiting' || waitingIsStale)) {
          if (interruptMarker) {
            snap.state = 'idle';
            if (!snap.lastStopAt || (t.lastUserMessageAt && t.lastUserMessageAt > snap.lastStopAt)) {
              snap.lastStopAt = t.lastUserMessageAt;
            }
          } else if (tu > 0 && tu > ta) {
            // User message is the most recent activity. Two distinct shapes:
            //  - Live prompt: user just typed, Claude is about to start →
            //    keep `working` until Claude writes an assistant chunk
            //    (transcript mtime stays fresh) or a Stop hook clears it.
            //  - Slash command without an assistant reply: `/compact`,
            //    `/clear`, custom skill macros that land as the final user
            //    line in the JSONL with no new assistant block — `tu > ta`
            //    holds forever and would otherwise stick the row on working.
            // Disambiguate by the same mtime freshness used in the assistant
            // branch — if the transcript hasn't been touched in 30s, the
            // prompt is old and Claude is done (or never produced a reply).
            if (transcriptIsFresh) {
              snap.state = 'working';
              if (!snap.lastPromptAt || snap.lastPromptAt.getTime() < tu) {
                snap.lastPromptAt = t.lastUserMessageAt;
              }
            } else {
              snap.state = 'idle';
              if (!snap.lastStopAt || snap.lastStopAt.getTime() < tu) {
                snap.lastStopAt = t.lastUserMessageAt;
              }
            }
          } else if (ta > 0 && ta >= tu) {
            // Assistant activity newer than the user message. We can't tell
            // from the parsed timestamps alone whether Claude is mid-compose
            // or already finished — `ta` is the START of the latest assistant
            // message and doesn't advance with subsequent streaming chunks.
            //
            // Three signals disambiguate:
            //   1. A Stop hook at-or-after `ta` → Claude genuinely finished.
            //   2. Transcript file mtime fresh (< 30s) → Claude is still
            //      writing chunks (thinking, tool calls, text deltas) → live.
            //   3. Neither → Stop hook missed; treat as idle to avoid a
            //      session that looks "working" forever.
            const stoppedAfterLastAssistant = snap.lastStopAt
              && snap.lastStopAt.getTime() >= ta;
            if (!stoppedAfterLastAssistant && transcriptIsFresh) {
              snap.state = 'working';
              if (!snap.lastPromptAt && t.lastUserMessageAt) {
                snap.lastPromptAt = t.lastUserMessageAt;
              }
            } else {
              snap.state = 'idle';
              if (!snap.lastStopAt || snap.lastStopAt.getTime() < ta) {
                snap.lastStopAt = t.lastAssistantMessageAt;
              }
            }
          }
        }

        if (!snap.toolName && t.currentToolName && snap.state === 'tool') {
          snap.toolName = t.currentToolName;
          snap.toolInput = t.currentToolInput;
        }
      }
    }

    // When the parent session has been idle for a while, any subagent still
    // flagged as working almost certainly missed its tool_result (Claude
    // crashed mid-Task, user interrupted, etc.). Don't keep the sidebar
    // spinning on those forever — but wait 2 minutes before overriding so
    // short idle windows don't clobber a legitimately running subagent.
    if (snap.state === 'idle' && snap.lastStopAt
        && Date.now() - snap.lastStopAt.getTime() > 120_000
        && snap.subagents?.some((s) => s.state !== 'done')) {
      snap.subagents = snap.subagents.map((s) =>
        s.state === 'done' ? s : { ...s, state: 'done' as const, completedAt: s.completedAt || new Date() },
      );
    }

    // Outcome of the last turn — only meaningful once the agent has stopped.
    if (snap.state === 'idle' && snap.sessionId) {
      const t = this.transcript.getSnapshot(snap.sessionId);
      if (t) snap.outcome = classifyOutcome(t);
    }

    // Dismissed waiting: render as idle while nothing newer than the dismissal
    // happened. Any fresh activity (new Notification, assistant chunk, prompt)
    // un-dismisses so a real follow-up block is never hidden.
    const dismissed = this.dismissedAt.get(tmuxSession);
    if (dismissed !== undefined) {
      const lastActivity = Math.max(
        snap.waitingSince?.getTime() ?? 0,
        snap.lastAssistantMessageAt?.getTime() ?? 0,
        snap.lastPromptAt?.getTime() ?? 0,
        snap.toolSince?.getTime() ?? 0,
      );
      if (lastActivity > dismissed) {
        this.dismissedAt.delete(tmuxSession);
      } else if (snap.state === 'waiting') {
        snap.state = 'idle';
        snap.dismissed = true;
      }
    }

    // working/tool → idle edge without a Stop hook (Esc, missed hook, transcript-
    // only tracking): flag it unread here. Stop-hook edges are flagged in
    // handleLine so they're caught even while the sidebar isn't rendering.
    // Only a completion the transcript can vouch for (a recent lastStopAt from
    // the assistant/user branch above) counts — a pure time-based stale-out
    // (agent crashed, machine slept) must not paint a green "done".
    const prev = this.lastDerived.get(tmuxSession);
    this.lastDerived.set(tmuxSession, snap.state);
    const vouched = !!snap.lastStopAt && Date.now() - snap.lastStopAt.getTime() < 120_000;
    if ((prev === 'working' || prev === 'tool') && snap.state === 'idle' && vouched) {
      this.noteFinished(tmuxSession, snap.outcome);
    }

    // Only an idle row can carry a result; a relaunched/working session must
    // not wear the previous run's verdict.
    if (snap.state === 'idle') {
      const unread = this.unreadOf(tmuxSession);
      if (unread) snap.unread = unread.kind;
    }
    return snap;
  }

  get hookScriptPath(): string { return HOOK_DEST; }
  get agentHookScriptPath(): string { return AGENT_HOOK_DEST; }

  /** Install our unified forwarder as hooks for every enabled provider. Returns
   *  the display names of the providers that succeeded. Used by the explicit
   *  install command + prompt (adding new agents is intentional there). */
  async installHooksForEnabledAgents(): Promise<string[]> {
    const ok: string[] = [];
    for (const p of this.registry.enabled()) {
      try {
        if (await p.installHook(AGENT_HOOK_DEST)) ok.push(p.displayName);
      } catch (err) {
        console.error('[terminal-sessions] installHook failed for', p.id, err);
      }
    }
    return ok;
  }

  /** Silently re-install hooks ONLY for agents that already have our hook —
   *  migrates Claude from the legacy claude-hook.sh to the shared forwarder and
   *  refreshes stale event sets, without writing into the config of an agent the
   *  user never opted into. Used by the activation one-shot upgrade. */
  async upgradeInstalledAgentHooks(): Promise<string[]> {
    const ok: string[] = [];
    for (const p of this.registry.enabled()) {
      if (!p.isHookInstalled()) continue;
      try {
        if (await p.installHook(AGENT_HOOK_DEST)) ok.push(p.displayName);
      } catch (err) {
        console.error('[terminal-sessions] hook upgrade failed for', p.id, err);
      }
    }
    return ok;
  }

  private ensureFiles(): void {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
      if (!fs.existsSync(AGENT_LOG_PATH)) fs.writeFileSync(AGENT_LOG_PATH, '');
      // Legacy single-agent forwarder (kept for already-installed Claude hooks).
      const legacySrc = path.join(this.ctx.extensionPath, 'media', 'claude-hook.sh');
      if (fs.existsSync(legacySrc)) {
        fs.copyFileSync(legacySrc, HOOK_DEST);
        fs.chmodSync(HOOK_DEST, 0o755);
      }
      // Unified forwarder used by every agent's hook install going forward.
      const agentSrc = path.join(this.ctx.extensionPath, 'media', 'agent-hook.sh');
      if (fs.existsSync(agentSrc)) {
        fs.copyFileSync(agentSrc, AGENT_HOOK_DEST);
        fs.chmodSync(AGENT_HOOK_DEST, 0o755);
      }
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker ensureFiles:', e);
    }
  }

  private loadMap(): void {
    try {
      const raw = fs.readFileSync(MAP_PATH, 'utf8');
      const data = JSON.parse(raw) as Record<string, ClaudeMapping>;
      for (const [k, v] of Object.entries(data)) {
        if (!v.agent) v.agent = 'claude'; // legacy map entries predate the agent field
        this.map.set(k, v);
      }
    } catch { /* no map yet */ }
  }

  /**
   * Walk the event log once at activation and populate `claudeSessionHistory`
   * and `folderPath` on any session-index entries that are missing them.
   * Recovers historical Claude session ids that were wiped from the live
   * `claude-map.json` by the cleanup at line ~445 (when a sessionId moved to
   * another tmux). Also backfills the per-session `folderPath` from the most
   * recent cwd recorded in the hook log — without it, post-reboot restore
   * and Stop->Start build a transcript path against the workspace root for
   * sessions that were actually launched in a subfolder, and the existence
   * check fails -> auto-resume silently skipped. Only touches index entries
   * missing the respective field, so user-set values are never overwritten.
   */
  private backfillIndexFromLog(): void {
    if (!this.index) return;
    const cfgPrefix = getConfig().sessionPrefix;
    // Build "missing entries" sets up front so we can short-circuit reading
    // most of the log (90k+ lines) when nothing needs backfill.
    const missingHistory = new Set<string>();
    const missingFolderPath = new Set<string>();
    for (const ws of Object.values(this.index.getAllWorkspaces())) {
      for (const [name, label] of Object.entries(ws.sessions)) {
        if (!label.claudeSessionHistory || label.claudeSessionHistory.length === 0) {
          missingHistory.add(name);
        }
        if (!label.folderPath) missingFolderPath.add(name);
      }
    }
    const touched = new Set<string>([...missingHistory, ...missingFolderPath]);
    if (touched.size === 0) return;
    // Scan the log once. For each touched tmux name, collect every (sessionId,
    // cwd, ts) pair so we can build the ordered history and resolve the most
    // recent cwd afterwards.
    type Sighting = { ts: number; sessionId: string; cwd: string };
    const sightings = new Map<string, Sighting[]>();
    // Scan BOTH logs (unified agent-events.log + legacy claude-events.log) —
    // reading only the legacy one silently no-ops recovery on migrated/new
    // installs where every hook event lives in agent-events.log. Read only a
    // bounded tail of each so a multi-month, tens-of-MB log doesn't block the
    // extension host on every activation (recent ids/cwds are near the end).
    for (const lp of LOG_PATHS) {
      const raw = this.readTail(lp, BACKFILL_TAIL_BYTES);
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        // Cheap pre-filter — skip lines that don't mention any touched tmux.
        let relevant = false;
        for (const m of touched) {
          if (line.includes(`"${m}"`)) { relevant = true; break; }
        }
        if (!relevant) continue;
        let e: ClaudeEvent;
        try { e = JSON.parse(line); }
        catch { continue; }
        if (!e.tmuxSession || !touched.has(e.tmuxSession)) continue;
        const list = sightings.get(e.tmuxSession) ?? [];
        list.push({ ts: e.ts, sessionId: e.sessionId || '', cwd: e.cwd || '' });
        sightings.set(e.tmuxSession, list);
      }
    }
    let filledHistory = 0;
    let filledFolder = 0;
    for (const [tmux, list] of sightings) {
      const parsed = parseSessionName(tmux, cfgPrefix);
      if (!parsed) continue;
      list.sort((a, b) => b.ts - a.ts);

      // History: most recent unique sessionId first, capped at 10.
      if (missingHistory.has(tmux)) {
        const seen = new Set<string>();
        const history: string[] = [];
        for (const s of list) {
          if (!s.sessionId || seen.has(s.sessionId)) continue;
          seen.add(s.sessionId);
          history.push(s.sessionId);
          if (history.length >= 10) break;
        }
        // Replay oldest -> newest so recordClaudeSession ends up with the
        // newest at the front (it prepends each call).
        for (let i = history.length - 1; i >= 0; i--) {
          this.index.recordClaudeSession(parsed.hash, tmux, history[i]);
        }
        if (history.length > 0) filledHistory++;
      }

      // folderPath: the most recent non-empty cwd observed for this tmux.
      // Captures the subfolder a session was created in even when the
      // session predates the per-session folderPath field.
      if (missingFolderPath.has(tmux)) {
        const cwd = list.find(s => s.cwd)?.cwd;
        if (cwd) {
          this.index.setSessionFolderPath(parsed.hash, tmux, cwd);
          filledFolder++;
        }
      }
    }
    if (filledHistory > 0 || filledFolder > 0) {
      console.log(`[terminal-sessions] backfill: history=${filledHistory} folderPath=${filledFolder}`);
    }
  }

  private saveMap(): void {
    const tmp = `${MAP_PATH}.${process.pid}.tmp`;
    try {
      // Atomic replace so a crash mid-write can't leave a truncated map that
      // loadMap() would silently drop (losing every session→conversation link).
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2));
      fs.renameSync(tmp, MAP_PATH);
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker saveMap:', e);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  }

  /** Read at most `maxBytes` from the end of a log, dropping the partial first
   *  line so the caller always gets whole JSON lines. Keeps activation off the
   *  path of reading an unbounded append-only log in full. */
  private readTail(logPath: string, maxBytes: number): string {
    try {
      const st = fs.statSync(logPath);
      const start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      if (len <= 0) return '';
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return text;
    } catch { return ''; }
  }

  /** Cap the append-only event logs: once one passes LOG_ROTATE_CAP, move it to
   *  <log>.1 (one generation kept for manual inspection) and start fresh, resetting
   *  its byte offset. Runs after backfill + processNewEvents, so nothing pending is
   *  lost, and before watch() so the fresh files are the ones watched. */
  private rotateLogsIfHuge(): void {
    for (const lp of LOG_PATHS) {
      try {
        if (fs.statSync(lp).size < LOG_ROTATE_CAP) continue;
        try { fs.renameSync(lp, `${lp}.1`); } catch { continue; }
        fs.writeFileSync(lp, '');
        this.logOffsets.set(lp, 0);
        this.saveOffset(lp);
      } catch { /* ENOENT or busy — skip */ }
    }
  }

  private offsetFileFor(logPath: string): string {
    return logPath === AGENT_LOG_PATH ? AGENT_OFFSET_PATH : OFFSET_PATH;
  }

  private loadOffsets(): void {
    for (const lp of LOG_PATHS) {
      let off = 0;
      try { off = parseInt(fs.readFileSync(this.offsetFileFor(lp), 'utf8'), 10) || 0; }
      catch { off = 0; }
      this.logOffsets.set(lp, off);
    }
  }

  private saveOffset(logPath: string): void {
    try { fs.writeFileSync(this.offsetFileFor(logPath), String(this.logOffsets.get(logPath) ?? 0)); }
    catch { /* noop */ }
  }

  private watch(): void {
    for (const lp of LOG_PATHS) {
      try {
        this.watchers.push(fs.watch(lp, { persistent: false }, () => this.processLog(lp)));
      } catch (e) {
        // File may not exist yet — ensureFiles creates both, so this is rare.
        console.error('[terminal-sessions] claude-tracker watch:', lp, e);
      }
    }
  }

  private processNewEvents(): void {
    for (const lp of LOG_PATHS) this.processLog(lp);
  }

  private processLog(logPath: string): void {
    try {
      const stat = fs.statSync(logPath);
      let offset = this.logOffsets.get(logPath) ?? 0;
      if (stat.size === offset) return;
      if (stat.size < offset) offset = 0;
      const bytes = stat.size - offset;
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, offset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      let changed = false;
      for (const line of lines) {
        if (this.handleLine(line)) changed = true;
      }
      this.logOffsets.set(logPath, stat.size);
      this.saveOffset(logPath);
      if (changed) this._onChange.fire();
    } catch (e) {
      // statSync throws ENOENT if the log doesn't exist yet — benign.
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('[terminal-sessions] processLog:', logPath, e);
      }
    }
  }

  private handleLine(line: string): boolean {
    let e: ClaudeEvent;
    try { e = JSON.parse(line); }
    catch { return false; }
    if (!e.event) return false;
    if (!e.tmuxSession) return false;
    // Agent-team teammates and Task-tool subagents fire the same lifecycle
    // hooks as the lead, tagged with `agentId`/`agentType` (the main session
    // never carries `agentId`). In split-pane mode they share the lead's tmux
    // session, so without this guard a teammate's Stop would fire a "done"
    // notification AND overwrite the lead's tracked sessionId/state below. Drop
    // them outright: the sidebar tracks the lead per tmux tab; teammate activity
    // is Claude-internal and must not hijack the tab.
    if (e.agentId) return false;

    const tsMs = (e.ts || Math.floor(Date.now() / 1000)) * 1000;
    const snap = this.snapshots.get(e.tmuxSession) ?? ({ state: 'none' } as ClaudeSnapshot);
    // Resolve which AI CLI this event came from. Legacy claude-events.log lines
    // have no `agent` field → providerForAgent defaults to Claude.
    const provider = this.registry.providerForAgent(e.agent);
    const agent = provider.id;
    snap.agent = agent;

    // Validate untrusted hook-sourced fields before feeding them to path joins
    // or the snapshot. The provider decides what a valid id looks like so a
    // malformed log line can't smuggle `../../foo` into transcript paths.
    if (e.sessionId && !provider.isValidSessionId(e.sessionId)) return false;
    if (e.cwd) e.cwd = path.resolve(e.cwd); // collapses any `..` segments

    // SessionEnd carries UNRELIABLE tmux attribution: while a pane is dying
    // (tmux server shutdown, session kill), the hook's un-pinned tmux lookup
    // used to resolve to a DIFFERENT still-alive session — observed poisoning
    // session history shift-by-one across tabs (a fork's conversation became
    // its origin's resume head, so Stop→Start reopened the wrong conversation).
    // The hook now pins its lookup, but as defense in depth an end event must
    // NEVER claim ownership, transfer the live map, or write resume history —
    // a conversation ENDING somewhere is not evidence it ever BELONGED there.
    // Trust it only for the state reset, and only when it matches (or there is
    // no record of) the conversation this tmux already tracks.
    if (e.event === 'SessionEnd') {
      const owner = this.map.get(e.tmuxSession);
      if (e.sessionId && owner && owner.sessionId !== e.sessionId) return false;
      snap.state = 'none';
      snap.toolName = undefined;
      snap.toolInput = undefined;
      snap.toolSince = undefined;
      this.snapshots.set(e.tmuxSession, snap);
      return true;
    }

    // Always update sessionId + transcript if we have one
    if (e.sessionId) {
      snap.sessionId = e.sessionId;
      if (e.transcriptPath || e.cwd) {
        const tp = provider.resolveTranscriptPath(e.sessionId, e.cwd, e.transcriptPath)
          || e.transcriptPath || '';
        // A sessionId can only be "live" in one tmux session at a time. If the
        // user resumed it in a different tmux tab later, transfer ownership:
        // clear any OTHER tmux sessions that had this id so the sidebar doesn't
        // show N tabs all mirroring the same state.
        for (const [otherTmux, entry] of this.map.entries()) {
          if (otherTmux !== e.tmuxSession && entry.sessionId === e.sessionId) {
            this.map.delete(otherTmux);
            const otherSnap = this.snapshots.get(otherTmux);
            if (otherSnap && otherSnap.sessionId === e.sessionId) {
              otherSnap.sessionId = undefined;
              otherSnap.state = 'none';
            }
          }
        }
        this.map.set(e.tmuxSession, {
          sessionId: e.sessionId,
          agent,
          cwd: e.cwd,
          transcriptPath: tp || undefined,
          timestamp: tsMs,
        });
        this.saveMap();
        if (tp) this.transcript.start(e.sessionId, tp, provider);
        // Persist the historical mapping in the session index too — the live
        // `map` above gets wiped when this sessionId moves to another tmux
        // (resume in a different tab), but Stop -> Start needs to find the
        // original conversation here. recordAgentSession keeps an ordered,
        // agent-tagged history so older conversations remain resumable too.
        if (this.index) {
          const cfgPrefix = getConfig().sessionPrefix;
          const parsed = parseSessionName(e.tmuxSession, cfgPrefix);
          if (parsed) {
            this.index.recordAgentSession(parsed.hash, e.tmuxSession, agent, e.sessionId);
            // Backfill folderPath the first time we see a cwd for this tmux —
            // sticky once set, so a later `cd` inside the session doesn't
            // overwrite the original creation directory.
            if (e.cwd) {
              const meta = this.index.getSessionMeta(parsed.hash, e.tmuxSession);
              if (!meta?.folderPath) {
                this.index.setSessionFolderPath(parsed.hash, e.tmuxSession, e.cwd);
              }
            }
          }
        }
      }
    }

    // Antigravity statusLine event: not a lifecycle transition, it carries the
    // live context usage + model that never land in agy's transcript. Map them
    // onto the snapshot so agy rows show a real context % / model instead of 0% /
    // blank, then stop (no state change, no flag capture for a status ping).
    // Field names are read defensively — an unexpected shape simply leaves the
    // context untouched (no regression) rather than showing wrong numbers.
    if (e.event === 'statusline') {
      const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : NaN);
      if (e.model && !snap.model) snap.model = e.model;
      const cw = e.contextWindow;
      if (cw && typeof cw === 'object') {
        const used = num(cw.used ?? cw.used_tokens ?? cw.tokens ?? cw.current);
        const size = num(cw.size ?? cw.max ?? cw.limit ?? cw.total ?? cw.max_tokens);
        if (size > 0 && used >= 0) {
          snap.contextTokens = used;
          snap.contextLimit = size;
          snap.contextPct = used / size;
        }
      }
      this.snapshots.set(e.tmuxSession, snap);
      return true;
    }

    switch (e.event) {
      case 'SessionStart':
        snap.state = 'idle';
        snap.lastStartAt = new Date(tsMs);
        // A (re)launch starts a fresh run: whatever the previous run left unread
        // is history now, not something the new run finished.
        if (Date.now() - tsMs < NOTIFY_STALE_MS) this.markSeen(e.tmuxSession);
        // Fresh launch/resume → re-read this pane's process flags (a Restart may
        // have relaunched with different character flags).
        this.flagCapTried.delete(e.tmuxSession);
        break;
      case 'UserPromptSubmit':
        snap.state = 'working';
        snap.lastPromptAt = new Date(tsMs);
        // Typing a prompt means the user saw the previous result. Live events
        // only — a replayed old prompt must not clear a marker set after it.
        if (Date.now() - tsMs < NOTIFY_STALE_MS) {
          this.markSeen(e.tmuxSession);
          this.dismissedAt.delete(e.tmuxSession);
        }
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        snap.waitingSince = undefined;
        break;
      case 'PreToolUse':
        snap.state = 'tool';
        snap.toolName = e.toolName || snap.toolName;
        snap.toolInput = e.toolInput || snap.toolInput;
        snap.toolSince = new Date(tsMs);
        snap.waitingSince = undefined;
        break;
      case 'PostToolUse':
        snap.state = 'working';
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        snap.waitingSince = undefined;
        break;
      case 'Notification':
        // Claude Code fires Notification for TWO unrelated reasons:
        //   1. Permission needed — "Claude needs your permission to use {Tool}"
        //   2. Idle nudge — "Claude is waiting for your input" (~60s after each
        //      Stop while sitting at the prompt). NOT urgent, must not flip
        //      the sidebar to ⚠ waiting or fire the permission alert.
        if (isIdleNudgeNotification(e.message)) {
          // Idle nudge: no state change, no alert. Claude already entered
          // 'idle' via the preceding Stop event.
          break;
        }
        snap.state = 'waiting';
        snap.waitingSince = new Date(tsMs);
        this.triggerWaitingNotify(e, tsMs, provider);
        break;
      case 'Stop': {
        snap.state = 'idle';
        snap.lastStopAt = new Date(tsMs);
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        snap.waitingSince = undefined;
        // The hook beats fs.watch to the final bytes; read them now so the
        // verdict isn't computed on a turn missing its last tool result.
        if (snap.sessionId) this.transcript.pollOne(snap.sessionId);
        const t = snap.sessionId ? this.transcript.getSnapshot(snap.sessionId) : undefined;
        const outcome = t ? classifyOutcome(t) : undefined;
        // Live event only — a Stop replayed from the log at activation must not
        // re-flag sessions the user already looked at.
        if (Date.now() - tsMs < NOTIFY_STALE_MS) {
          this.lastDerived.set(e.tmuxSession, 'idle');
          this.noteFinished(e.tmuxSession, outcome);
        }
        this.triggerStopNotify(e, tsMs, provider, outcome);
        break;
      }
      // SessionEnd is fully handled (and gated) before the ownership-transfer
      // block above — it must never reach the generic recording path.
    }

    // Opportunistically capture the launch flags of the live agent process (the
    // hook just fired from inside it, so it's running now). Self-dedupes per tmux
    // session via flagCapTried; fire-and-forget so we never block event handling.
    if (e.sessionId) void this.captureLaunchFlags(e.tmuxSession, agent);

    this.snapshots.set(e.tmuxSession, snap);
    return true;
  }

  /**
   * Read the live agent process's "character" launch flags (yolo, --model, …)
   * and persist them on the session so Restart / post-reboot restore can relaunch
   * the conversation the way it was started. Best-effort: if no agent process is
   * up yet (e.g. claude-pick's picker is still open) we clear the tried-marker so
   * a later event retries.
   */
  private async captureLaunchFlags(tmuxSession: string, agent: AgentId): Promise<void> {
    if (!this.index) return;
    if (this.flagCapTried.has(tmuxSession)) return;
    this.flagCapTried.add(tmuxSession);
    try {
      const provider = this.registry.providerForAgent(agent);
      const tmuxPath = await detectTmuxPath(getConfig().tmuxPath);
      if (!tmuxPath) { this.flagCapTried.delete(tmuxSession); return; }
      const pids = await panePids(tmuxPath, tmuxSession);
      const argv = readAgentArgv(pids, provider.processNames);
      if (!argv) { this.flagCapTried.delete(tmuxSession); return; } // not up yet → retry next event
      const flags = provider.captureResumeFlags(argv);
      const parsed = parseSessionName(tmuxSession, getConfig().sessionPrefix);
      if (parsed) this.index.recordResumeFlags(parsed.hash, tmuxSession, agent, flags);
    } catch {
      this.flagCapTried.delete(tmuxSession);
    }
  }

  /** Grok is the one tracked agent with no global lifecycle hook, so nothing
   *  writes to the events log for it. Instead we poll: read its live sessions
   *  from ~/.grok/active_sessions.json and match each session's pid to a tmux
   *  pane's process subtree. Only runs when Grok is enabled. */
  private startGrokDiscovery(): void {
    if (!this.registry.enabled().some(p => p.id === 'grok')) return;
    const tick = (): void => { void this.pollGrokSessions(); };
    this.grokTimer = setInterval(tick, GROK_POLL_MS);
    tick();
  }

  private async pollGrokSessions(): Promise<void> {
    if (!this.index) return;
    // Re-entrancy guard: on a loaded box a poll can take longer than GROK_POLL_MS
    // (many panes → many tmux + a full `ps`), and without this every tick would
    // start another overlapping poll, stacking subprocess churn indefinitely.
    if (this.grokPolling) return;
    this.grokPolling = true;
    try {
      await this.pollGrokSessionsInner();
    } finally {
      this.grokPolling = false;
    }
  }

  private async pollGrokSessionsInner(): Promise<void> {
    if (!this.index) return;
    const grok = this.registry.getProvider('grok');
    if (!grok) return;
    const active = readGrokActiveSessions();
    if (!active.length) return;

    // Steady-state fast path: once every live grok session is already mapped to a
    // pane, skip the tmux/process enumeration entirely (just the file read above).
    const trackedGrokIds = new Set(
      [...this.map.values()].filter(m => m.agent === 'grok').map(m => m.sessionId),
    );
    // Also drop entries whose pid is dead (a crashed grok leaves a stale record in
    // active_sessions.json). Without this, an unmatchable stale entry keeps the
    // full tmux + `ps` enumeration running every 5s forever with no benefit.
    const pending = active.filter(a => !trackedGrokIds.has(a.session_id)).filter(a => {
      try { process.kill(a.pid, 0); return true; }
      catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
    });
    if (!pending.length) return;

    const cfg = getConfig();
    const tmuxPath = await detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) return;
    let rows: { name: string }[];
    try { rows = await listSessions(tmuxPath, cfg.sessionPrefix); }
    catch { return; }
    if (!rows.length) return;

    const tree = processTree();
    let changed = false;
    for (const row of rows) {
      const pids = await panePids(tmuxPath, row.name);
      if (!pids.length) continue;
      const descendants = collectDescendantPids(pids, tree);
      const hit = pending.find(a => descendants.has(a.pid));
      if (!hit) continue;

      const tp = grok.resolveTranscriptPath(hit.session_id, hit.cwd);
      this.map.set(row.name, {
        sessionId: hit.session_id,
        agent: 'grok',
        cwd: hit.cwd,
        transcriptPath: tp || undefined,
        timestamp: Date.now(),
      });
      if (tp) this.transcript.start(hit.session_id, tp, grok);
      const prev = this.snapshots.get(row.name);
      if (prev) { prev.sessionId = hit.session_id; prev.agent = 'grok'; }
      else this.snapshots.set(row.name, { state: 'idle', sessionId: hit.session_id, agent: 'grok' });

      const parsed = parseSessionName(row.name, cfg.sessionPrefix);
      if (parsed) {
        this.index.recordAgentSession(parsed.hash, row.name, 'grok', hit.session_id);
        const argv = readAgentArgv(pids, grok.processNames, tree);
        if (argv) this.index.recordResumeFlags(parsed.hash, row.name, 'grok', grok.captureResumeFlags(argv));
        if (hit.cwd) {
          const meta = this.index.getSessionMeta(parsed.hash, row.name);
          if (!meta?.folderPath) this.index.setSessionFolderPath(parsed.hash, row.name, hit.cwd);
        }
      }
      this.saveMap();
      changed = true;
    }
    if (changed) this._onChange.fire();
  }

  private triggerStopNotify(e: ClaudeEvent, tsMs: number, provider: AgentProvider, outcome?: TurnOutcome): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeStop) return;
    if (this.isSessionMuted(e.tmuxSession)) return;
    // Historical event replayed from the log at activation — apply state, skip
    // the stale "done" popup.
    if (Date.now() - tsMs > NOTIFY_STALE_MS) return;

    // Skip sub-second Stops (Claude often fires on very quick turns)
    const prev = this.snapshots.get(e.tmuxSession);
    const promptMs = prev?.lastPromptAt?.getTime() || 0;
    const durationSec = promptMs > 0 ? (tsMs - promptMs) / 1000 : Infinity;
    if (durationSec < cfg.claudeStopMinDurationSeconds) return;

    const wsKey = e.cwd || 'unknown';
    const lastNotify = this.lastNotifyPerWs.get(wsKey) || 0;
    if (Date.now() - lastNotify < NOTIFY_COOLDOWN_MS) return;
    this.lastNotifyPerWs.set(wsKey, Date.now());

    const label = path.basename(e.cwd || '') || provider.displayName;
    // Say HOW it ended when we know: "✗ tests failed · 3 failed" beats a
    // generic "done" when the run actually went red.
    const bad = outcomeIsBad(outcome);
    const body = outcome && outcome.kind !== 'ok'
      ? `${outcomeLabel(outcome)}${outcome.hint ? ' · ' + outcome.hint : ''}`
      : 'Ready for your next prompt';
    void notify({
      title: `${bad ? '✗' : '🤖'} ${provider.displayName} ${bad ? 'stopped with errors' : 'done'}`,
      subtitle: label,
      body,
      level: bad ? 'warning' : 'info',
    });
  }

  private triggerWaitingNotify(e: ClaudeEvent, tsMs: number, provider: AgentProvider): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeWaiting) return;
    if (this.isSessionMuted(e.tmuxSession)) return;
    // Historical event replayed from the log at activation — apply state, skip
    // the stale (and focus-stealing) "needs approval" alert.
    if (Date.now() - tsMs > NOTIFY_STALE_MS) return;

    // Cooldown per-session so a rapid toggle doesn't spam multiple alerts.
    const last = this.lastWaitingNotifyPerSession.get(e.tmuxSession) || 0;
    if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
    this.lastWaitingNotifyPerSession.set(e.tmuxSession, Date.now());

    const label = path.basename(e.cwd || '') || provider.displayName;
    const tmuxSession = e.tmuxSession;

    if (cfg.waitingAlertStyle === 'alert' && process.platform === 'darwin') {
      // Modal dialog (persistent until user clicks a button).
      void (async () => {
        const clicked = await macosAlert({
          title: `${provider.displayName} needs approval`,
          message: `Session: ${label}\n\nClick "Show terminal" to jump to it.`,
          primaryButton: 'Show terminal',
          secondaryButton: 'Dismiss',
        });
        if (clicked === 'Show terminal') {
          // Focus the IDE window first — osascript's alert is parented to
          // Script Editor, so after the button click macOS keeps focus there
          // unless we explicitly activate our app. `open -a <appName>` raises
          // Cursor/VS Code regardless of the previous frontmost app.
          try {
            await promisify(execFile)('/usr/bin/open', ['-a', vscode.env.appName]);
          } catch { /* best effort */ }
          // Then focus the matching terminal tab inside the IDE.
          try {
            for (const t of vscode.window.terminals) {
              const opts = t.creationOptions;
              const args = (opts as vscode.TerminalOptions)?.shellArgs;
              const argList = Array.isArray(args) ? args : args ? [args] : [];
              // Attach args carry the exact-match form `-t =name` — accept both.
              if (argList.includes(tmuxSession) || argList.includes('=' + tmuxSession)) { t.show(); break; }
            }
          } catch { /* best effort */ }
        }
      })();
    } else {
      // Banner notification with the distinct sound.
      // On remote extension hosts the banner is delivered as a VS Code
      // warning toast (since osascript/notify-send on remote can't reach
      // the user). Arm a one-shot "Show terminal" action so the click
      // focuses the session — parity with the local modal-alert path.
      armToastAction('Show terminal', () => {
        for (const t of vscode.window.terminals) {
          const opts2 = t.creationOptions;
          const args = (opts2 as vscode.TerminalOptions)?.shellArgs;
          const argList = Array.isArray(args) ? args : args ? [args] : [];
          // Attach args carry the exact-match form `-t =name` — accept both.
          if (argList.includes(tmuxSession) || argList.includes('=' + tmuxSession)) { t.show(); break; }
        }
      });
      void notify({
        title: `⚠ ${provider.displayName} needs approval`,
        subtitle: label,
        body: 'Waiting for your input',
        sound: cfg.notificationSoundWaiting,
        level: 'warning',
      });
    }
  }
}
