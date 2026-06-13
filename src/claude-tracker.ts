import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseSessionName } from './workspace-id';
import type { SessionIndex } from './session-manager';
import type { AgentId, AgentProvider } from './agents/types';
import type { AgentRegistry } from './agents/registry';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
import { notify, macosAlert, armToastAction } from './notifications';
import { getConfig } from './config';
import {
  TranscriptTailer,
  TranscriptSnapshot,
  transcriptPathFor,
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
// Sessions with no activity for this long are treated as 'idle' regardless of
// their last observed tool-use state (handles crashes / missed Stop events).
const STALE_TOOL_MS = 30 * 60 * 1000;
// Working-state stale timeout. Shorter than tool because 'working' means
// Claude is actively generating; if no tool call and no new assistant chunk
// in this window, Claude is either done or the Stop hook was missed.
// Common trigger: user hits Esc to cancel, and Claude exits without writing
// an interrupt marker the tailer can pick up.
const STALE_WORKING_MS = 2 * 60 * 1000;

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export class ClaudeTracker {
  private map = new Map<string, ClaudeMapping>();        // tmuxSession → mapping
  private snapshots = new Map<string, ClaudeSnapshot>(); // tmuxSession → snapshot
  private lastNotifyPerWs = new Map<string, number>();
  private lastWaitingNotifyPerSession = new Map<string, number>();
  private logOffsets = new Map<string, number>();   // logPath → byte offset
  private watchers: fs.FSWatcher[] = [];
  private transcript = new TranscriptTailer();
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
  }

  dispose(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* noop */ } }
    this.watchers = [];
    this.transcript.dispose();
    this._onChange.dispose();
  }

  /** Look up the session-id most recently seen in a tmux session. */
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
    this.map.delete(tmuxSession);
    this.snapshots.delete(tmuxSession);
    this.lastWaitingNotifyPerSession.delete(tmuxSession);
    this.saveMap();
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
        return snap;
      }
    }

    // Age-out stale 'tool' state with a long timeout — legitimate tools
    // (builds, long tests) can run for many minutes.
    if (snap.state === 'tool' && snap.lastPromptAt) {
      if (Date.now() - snap.lastPromptAt.getTime() > STALE_TOOL_MS) {
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
    if (snap.state === 'working' && sinceWriteMs > 90_000) {
      snap.state = 'idle';
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
        snap.contextTokens = t.currentContextTokens;
        snap.contextLimit = t.currentContextLimit;
        snap.contextPct = t.currentContextLimit > 0
          ? t.currentContextTokens / t.currentContextLimit : 0;

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
    try {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
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
    } catch (err) {
      console.error('[terminal-sessions] backfillIndexFromLog:', err);
      return;
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
    try {
      fs.writeFileSync(MAP_PATH, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker saveMap:', e);
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

    switch (e.event) {
      case 'SessionStart':
        snap.state = 'idle';
        break;
      case 'UserPromptSubmit':
        snap.state = 'working';
        snap.lastPromptAt = new Date(tsMs);
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
      case 'Stop':
        snap.state = 'idle';
        snap.lastStopAt = new Date(tsMs);
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        snap.waitingSince = undefined;
        this.triggerStopNotify(e, tsMs, provider);
        break;
      case 'SessionEnd':
        snap.state = 'none';
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        break;
    }

    this.snapshots.set(e.tmuxSession, snap);
    return true;
  }

  private triggerStopNotify(e: ClaudeEvent, tsMs: number, provider: AgentProvider): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeStop) return;
    if (this.isSessionMuted(e.tmuxSession)) return;

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
    void notify({
      title: `🤖 ${provider.displayName} done`,
      subtitle: label,
      body: 'Ready for your next prompt',
    });
  }

  private triggerWaitingNotify(e: ClaudeEvent, _tsMs: number, provider: AgentProvider): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeWaiting) return;
    if (this.isSessionMuted(e.tmuxSession)) return;

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
              if (argList.includes(tmuxSession)) { t.show(); break; }
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
          if (argList.includes(tmuxSession)) { t.show(); break; }
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

/**
 * Install our hooks into ~/.claude/settings.json. Idempotent: replaces any
 * existing terminal-sessions hook entries with fresh ones covering every
 * event listed in HOOK_EVENTS.
 */
export async function installClaudeHook(scriptPath: string): Promise<boolean> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); } catch { /* noop */ }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch {
      vscode.window.showErrorMessage(
        `Could not parse ~/.claude/settings.json. Fix it manually then try again.`,
      );
      return false;
    }
  }

  const hooks = (settings.hooks as Record<string, unknown> | undefined) || {};
  settings.hooks = hooks;

  const isOursEntry = (entry: unknown): boolean => {
    const anyE = entry as { hooks?: Array<{ command?: string }> };
    return !!anyE.hooks?.some(h => typeof h.command === 'string' && h.command.includes('claude-hook.sh'));
  };

  const buildEntry = (event: string) => ({
    hooks: [{ type: 'command' as const, command: `"${scriptPath}" ${event}` }],
  });

  for (const event of HOOK_EVENTS) {
    const existing = (hooks[event] as unknown[]) || [];
    const pruned = existing.filter(e => !isOursEntry(e));
    pruned.push(buildEntry(event));
    hooks[event] = pruned;
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not write ~/.claude/settings.json: ${String(e).slice(0, 100)}`);
    return false;
  }
}

export async function uninstallClaudeHook(): Promise<boolean> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return true;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return false; }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return true;

  for (const event of Object.keys(hooks)) {
    const arr = (hooks[event] as unknown[]).filter(entry => {
      const anyE = entry as { hooks?: Array<{ command?: string }> };
      return !anyE.hooks?.some(h => typeof h.command === 'string' && h.command.includes('claude-hook.sh'));
    });
    if (arr.length === 0) delete hooks[event];
    else hooks[event] = arr;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function isClaudeHookInstalled(): boolean {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const txt = fs.readFileSync(settingsPath, 'utf8');
    return txt.includes('claude-hook.sh');
  } catch { return false; }
}

/** True if settings.json has our hook, but only for the old minimal event set. */
export function needsHookUpgrade(): boolean {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (!raw.includes('claude-hook.sh')) return false;
    for (const event of HOOK_EVENTS) {
      if (!raw.includes(`${event}`)) return true;
    }
    return false;
  } catch { return false; }
}
