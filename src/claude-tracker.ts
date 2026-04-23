import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { notify } from './notifications';
import { getConfig } from './config';

export interface ClaudeMapping {
  sessionId: string;
  cwd: string;
  timestamp: number;
}

interface ClaudeEvent {
  event: string;
  ts: number;
  sessionId: string;
  tmuxSession: string;
  cwd: string;
}

const ROOT = path.join(os.homedir(), '.terminal-sessions');
const LOG_PATH = path.join(ROOT, 'claude-events.log');
const MAP_PATH = path.join(ROOT, 'claude-map.json');
const OFFSET_PATH = path.join(ROOT, '.log-offset');
const HOOK_DEST = path.join(ROOT, 'claude-hook.sh');

// Don't ping more than once every 5 seconds for the same workspace (prevents
// noisy Stop-chains in fast tool-use loops).
const NOTIFY_COOLDOWN_MS = 5_000;

export class ClaudeTracker {
  private map = new Map<string, ClaudeMapping>();   // tmuxSession → mapping
  private sessionStarts = new Map<string, number>(); // sessionId → SessionStart ts
  private lastNotifyPerWs = new Map<string, number>();
  private lastOffset = 0;
  private watcher: fs.FSWatcher | undefined;

  constructor(private ctx: vscode.ExtensionContext) {}

  start(): void {
    this.ensureFiles();
    this.loadMap();
    this.loadOffset();
    this.processNewEvents();
    this.watch();
  }

  dispose(): void {
    try { this.watcher?.close(); } catch { /* noop */ }
  }

  /** Look up the Claude session-id most recently seen in a tmux session. */
  getSessionId(tmuxSession: string): string | undefined {
    return this.map.get(tmuxSession)?.sessionId;
  }

  get hookScriptPath(): string { return HOOK_DEST; }

  private ensureFiles(): void {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
      // Always copy the bundled hook to the stable location (idempotent).
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
      if (stat.size < this.lastOffset) this.lastOffset = 0; // truncated
      const bytes = stat.size - this.lastOffset;
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, this.lastOffset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) this.handleLine(line);
      this.lastOffset = stat.size;
      this.saveOffset();
    } catch (e) {
      console.error('[terminal-sessions] processNewEvents:', e);
    }
  }

  private handleLine(line: string): void {
    let e: ClaudeEvent;
    try { e = JSON.parse(line); } catch { return; }
    if (!e.event || !e.sessionId) return;
    const tsMs = (e.ts || 0) * 1000;

    if (e.event === 'SessionStart') {
      if (e.tmuxSession) {
        this.map.set(e.tmuxSession, {
          sessionId: e.sessionId,
          cwd: e.cwd,
          timestamp: tsMs,
        });
        this.saveMap();
      }
      this.sessionStarts.set(e.sessionId, tsMs);
      return;
    }

    if (e.event === 'Stop') {
      this.handleStop(e, tsMs);
      return;
    }
  }

  private handleStop(e: ClaudeEvent, tsMs: number): void {
    const cfg = getConfig();
    if (!cfg.notifyOnClaudeStop) return;

    // Skip if the session was very short (Claude often Stops in < 1s on quick turns).
    const started = this.sessionStarts.get(e.sessionId) || 0;
    const durationSec = started > 0 ? (tsMs - started) / 1000 : Infinity;
    if (durationSec < cfg.claudeStopMinDurationSeconds) return;

    // Cooldown per workspace path so chained tool-use doesn't ping-storm.
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
 * Install our hooks into ~/.claude/settings.json. Idempotent: removes existing
 * terminal-sessions hooks first, then adds fresh ones.
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

  for (const event of ['SessionStart', 'Stop'] as const) {
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
