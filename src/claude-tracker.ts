import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { notify } from './notifications';
import { getConfig } from './config';
import {
  TranscriptTailer,
  TranscriptSnapshot,
  transcriptPathFor,
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
  private lastOffset = 0;
  private watcher: fs.FSWatcher | undefined;
  private transcript = new TranscriptTailer();
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(private ctx: vscode.ExtensionContext) {
    this.transcript.onChange(() => this._onChange.fire());
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

    // Age-out stale 'tool' / 'working' states
    if ((snap.state === 'tool' || snap.state === 'working') && snap.lastPromptAt) {
      if (Date.now() - snap.lastPromptAt.getTime() > STALE_TOOL_MS) {
        snap.state = 'idle';
      }
    }

    if (snap.sessionId) {
      const t = this.transcript.getSnapshot(snap.sessionId);
      if (t) {
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
        // derived 'tool' and 'waiting' states because the transcript can't
        // tell us those (tool_use blocks mean "Claude called a tool", but not
        // whether it's still running or finished).
        const tu = t.lastUserMessageAt?.getTime() || 0;
        const ta = t.lastAssistantMessageAt?.getTime() || 0;
        const interruptMarker = t.lastUserMessage?.includes('[Request interrupted by user]');

        if (snap.state !== 'tool' && snap.state !== 'waiting') {
          if (interruptMarker) {
            snap.state = 'idle';
            if (!snap.lastStopAt || (t.lastUserMessageAt && t.lastUserMessageAt > snap.lastStopAt)) {
              snap.lastStopAt = t.lastUserMessageAt;
            }
          } else if (tu > 0 && tu > ta) {
            // User is waiting for Claude — working
            snap.state = 'working';
            if (!snap.lastPromptAt || snap.lastPromptAt.getTime() < tu) {
              snap.lastPromptAt = t.lastUserMessageAt;
            }
          } else if (ta > 0 && ta >= tu) {
            // Claude's last reply is newer — idle
            snap.state = 'idle';
            if (!snap.lastStopAt || snap.lastStopAt.getTime() < ta) {
              snap.lastStopAt = t.lastAssistantMessageAt;
            }
          }
        }

        if (!snap.toolName && t.currentToolName && snap.state === 'tool') {
          snap.toolName = t.currentToolName;
          snap.toolInput = t.currentToolInput;
        }
      }
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

    // Always update sessionId + transcript if we have one
    if (e.sessionId) {
      snap.sessionId = e.sessionId;
      if (e.transcriptPath || e.cwd) {
        const tp = e.transcriptPath || transcriptPathFor(e.cwd, e.sessionId);
        this.map.set(e.tmuxSession, {
          sessionId: e.sessionId,
          cwd: e.cwd,
          transcriptPath: tp,
          timestamp: tsMs,
        });
        this.saveMap();
        this.transcript.start(e.sessionId, tp);
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
        break;
      case 'PreToolUse':
        snap.state = 'tool';
        snap.toolName = e.toolName || snap.toolName;
        snap.toolInput = e.toolInput || snap.toolInput;
        snap.toolSince = new Date(tsMs);
        break;
      case 'PostToolUse':
        snap.state = 'working';
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
        break;
      case 'Notification':
        snap.state = 'waiting';
        break;
      case 'Stop':
        snap.state = 'idle';
        snap.lastStopAt = new Date(tsMs);
        snap.toolName = undefined;
        snap.toolInput = undefined;
        snap.toolSince = undefined;
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
