import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseSessionName } from './workspace-id';
import type { SessionIndex } from './session-manager';

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
  cwd: string;
  transcriptPath?: string;
  timestamp: number;
}

export interface ClaudeSnapshot {
  state: ClaudeState;
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
  private lastOffset = 0;
  private watcher: fs.FSWatcher | undefined;
  private transcript = new TranscriptTailer();
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(private ctx: vscode.ExtensionContext, private index?: SessionIndex) {
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
    this.loadOffset();
    this.processNewEvents();
    this.watch();
    // Best-effort: seed transcript tailers for sessions we already know about
    for (const [tmux, map] of this.map) {
      if (map.sessionId && map.transcriptPath) {
        this.transcript.start(map.sessionId, map.transcriptPath);
      }
      if (!this.snapshots.has(tmux)) {
        this.snapshots.set(tmux, { state: 'none', sessionId: map.sessionId });
      }
    }
  }

  dispose(): void {
    try { this.watcher?.close(); } catch { /* noop */ }
    this.transcript.dispose();
    this._onChange.dispose();
  }

  /** Look up the Claude session-id most recently seen in a tmux session. */
  getSessionId(tmuxSession: string): string | undefined {
    return this.map.get(tmuxSession)?.sessionId;
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

  private ensureFiles(): void {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
      const src = path.join(this.ctx.extensionPath, 'media', 'claude-hook.sh');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, HOOK_DEST);
        fs.chmodSync(HOOK_DEST, 0o755);
      }
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker ensureFiles:', e);
    }
  }

  private loadMap(): void {
    try {
      const raw = fs.readFileSync(MAP_PATH, 'utf8');
      const data = JSON.parse(raw) as Record<string, ClaudeMapping>;
      for (const [k, v] of Object.entries(data)) this.map.set(k, v);
    } catch { /* no map yet */ }
  }

  private saveMap(): void {
    try {
      fs.writeFileSync(MAP_PATH, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker saveMap:', e);
    }
  }

  private loadOffset(): void {
    try { this.lastOffset = parseInt(fs.readFileSync(OFFSET_PATH, 'utf8'), 10) || 0; }
    catch { this.lastOffset = 0; }
  }

  private saveOffset(): void {
    try { fs.writeFileSync(OFFSET_PATH, String(this.lastOffset)); }
    catch { /* noop */ }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(LOG_PATH, { persistent: false }, () => {
        this.processNewEvents();
      });
    } catch (e) {
      console.error('[terminal-sessions] claude-tracker watch:', e);
    }
  }

  private processNewEvents(): void {
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size === this.lastOffset) return;
      if (stat.size < this.lastOffset) this.lastOffset = 0;
      const bytes = stat.size - this.lastOffset;
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, this.lastOffset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      let changed = false;
      for (const line of lines) {
        if (this.handleLine(line)) changed = true;
      }
      this.lastOffset = stat.size;
      this.saveOffset();
      if (changed) this._onChange.fire();
    } catch (e) {
      console.error('[terminal-sessions] processNewEvents:', e);
    }
  }

  private handleLine(line: string): boolean {
    let e: ClaudeEvent;
    try { e = JSON.parse(line); }
    catch { return false; }
    if (!e.event) return false;
    if (!e.tmuxSession) return false;

    const tsMs = (e.ts || Math.floor(Date.now() / 1000)) * 1000;
    const snap = this.snapshots.get(e.tmuxSession) ?? ({ state: 'none' } as ClaudeSnapshot);

    // Validate untrusted hook-sourced fields before feeding them to path joins
    // or the snapshot. sessionId is a Claude UUID — reject anything else so
    // a malformed log line can't smuggle `../../foo` into transcript paths.
    if (e.sessionId && !UUID_RE.test(e.sessionId)) return false;
    if (e.cwd) e.cwd = path.resolve(e.cwd); // collapses any `..` segments

    // Always update sessionId + transcript if we have one
    if (e.sessionId) {
      snap.sessionId = e.sessionId;
      if (e.transcriptPath || e.cwd) {
        const tp = e.transcriptPath || transcriptPathFor(e.cwd, e.sessionId);
        // A Claude sessionId can only be "live" in one tmux session at a time.
        // If the user ran `claude --resume <id>` in a different tmux tab later,
        // transfer ownership: clear any OTHER tmux sessions that had this id
        // so the sidebar doesn't show N tabs all mirroring the same state.
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
          cwd: e.cwd,
          transcriptPath: tp,
          timestamp: tsMs,
        });
        this.saveMap();
        this.transcript.start(e.sessionId, tp);
        // Persist the historical mapping in the session index too — the
        // live `map` above gets wiped when this sessionId moves to another
        // tmux (claude --resume in a different tab), but Stop -> Start needs
        // to find the original conversation here. The index entry survives
        // because nothing else writes to it.
        if (this.index) {
          const cfgPrefix = getConfig().sessionPrefix;
          const parsed = parseSessionName(e.tmuxSession, cfgPrefix);
          if (parsed) {
            this.index.setLastClaudeSessionId(parsed.hash, e.tmuxSession, e.sessionId);
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
        this.triggerWaitingNotify(e, tsMs);
        break;
      case 'Stop':
        snap.state = 'idle';
        snap.lastStopAt = new Date(tsMs);
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        snap.waitingSince = undefined;
        this.triggerStopNotify(e, tsMs);
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

  private triggerStopNotify(e: ClaudeEvent, tsMs: number): void {
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

    const label = path.basename(e.cwd || '') || 'Claude';
    void notify({
      title: '🤖 Claude done',
      subtitle: label,
      body: 'Ready for your next prompt',
    });
  }

  private triggerWaitingNotify(e: ClaudeEvent, _tsMs: number): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeWaiting) return;
    if (this.isSessionMuted(e.tmuxSession)) return;

    // Cooldown per-session so a rapid toggle doesn't spam multiple alerts.
    const last = this.lastWaitingNotifyPerSession.get(e.tmuxSession) || 0;
    if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
    this.lastWaitingNotifyPerSession.set(e.tmuxSession, Date.now());

    const label = path.basename(e.cwd || '') || 'Claude';
    const tmuxSession = e.tmuxSession;

    if (cfg.waitingAlertStyle === 'alert' && process.platform === 'darwin') {
      // Modal dialog (persistent until user clicks a button).
      void (async () => {
        const clicked = await macosAlert({
          title: 'Claude needs approval',
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
        title: '⚠ Claude needs approval',
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
