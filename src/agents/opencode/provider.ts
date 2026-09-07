import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from '../types';
import { commandOnPath } from '../detect';
import { FlagSpec, captureFlags, withFlags } from '../launch-flags';
import { posixQuote } from '../../shell-escape';
import {
  reduceOpencodeTranscriptLine,
  readOpencodeTranscriptSummary,
  readOpencodeTranscriptCwd,
  isDefaultOpencodeTitle,
} from './transcript';
import {
  contextLimitForModelString,
  listOpencodeSessions,
  opencodeSessionDirectory,
} from './storage';

// OpenCode session ids: `ses_` + 12 hex (time field) + 14 base-62 chars. The
// strict shape is what the generator produces; OpenCode itself only checks the
// `ses` prefix, so accept the loose form too (older/foreign ids) but never
// anything that could carry path characters.
const SESSION_ID_RE = /^ses_[0-9A-Za-z]{20,40}$/;

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode');
/** The one file we install. OpenCode loads every `plugin/*.{js,ts}` in its
 *  config dir as a plugin, so nothing in opencode.json needs to change. */
export const PLUGIN_PATH = path.join(CONFIG_DIR, 'plugin', 'terminal-sessions.js');
/** Where our plugin writes the per-conversation JSONL we tail. */
export const TRANSCRIPT_DIR = path.join(os.homedir(), '.terminal-sessions', 'opencode');

const HOOK_VERSION_RE = /^\/\/ @terminal-sessions-hook-version (\d+)/m;

// OpenCode "character" launch flags. `--session/-s`, `--continue/-c`, `--fork`,
// `--prompt` and `--port/--hostname` are launch-specific and deliberately NOT
// carried; the positional project dir is dropped too (resume cd's into the
// recorded directory instead). `--auto` is the auto-approve switch; `--yolo`
// and `--dangerously-skip-permissions` are its hidden aliases.
const OPENCODE_FLAGS: FlagSpec = {
  bool: ['--auto', '--yolo', '--dangerously-skip-permissions', '--mini', '--pure'],
  value: {
    '--model': {},
    '--agent': {},
    '--log-level': {},
  },
  alias: { '-m': '--model' },
};

// The plugin emits Claude-Code hook names, so the tracker needs no OpenCode branch.
const OPENCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/** Reads the version marker of an installed plugin file, 0 when absent/foreign. */
function installedPluginVersion(): number {
  let head: string;
  try {
    const fd = fs.openSync(PLUGIN_PATH, 'r');
    const b = Buffer.alloc(512);
    const n = fs.readSync(fd, b, 0, 512, 0);
    fs.closeSync(fd);
    head = b.toString('utf8', 0, n);
  } catch { return 0; }
  const m = head.match(HOOK_VERSION_RE);
  return m ? parseInt(m[1], 10) : 0;
}

/** The plugin source shipped with this build of the extension. Resolved from
 *  the forwarder path (…/.terminal-sessions/agent-hook.sh) at install time so
 *  the provider stays free of the VS Code extension context. */
let bundledPluginSource: (() => string | undefined) | undefined;
export function setOpencodePluginSource(reader: () => string | undefined): void {
  bundledPluginSource = reader;
}
function bundledPluginVersion(src: string): number {
  const m = src.match(HOOK_VERSION_RE);
  return m ? parseInt(m[1], 10) : 0;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}

function transcriptPathFor(sessionId: string): string {
  return path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
}

export const opencodeProvider: AgentProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  badge: 'opencode',
  badgeIcon: 'code',
  // `opencode -s <id>` finds a session from any directory (the db is global),
  // but the instance binds to the cwd it starts in — project config, agents,
  // MCP servers and the title bar all follow it — so resume cd's back first.
  resumeNeedsCwd: true,
  supportsFork: true,
  hookEvents: OPENCODE_HOOK_EVENTS,

  isInstalled(): boolean {
    if (commandOnPath('opencode')) return true;
    // The curl installer drops the binary in ~/.opencode/bin, which a GUI-
    // launched IDE's PATH often lacks.
    return fs.existsSync(path.join(os.homedir(), '.opencode', 'bin', 'opencode'));
  },

  settingsPath(): string {
    return PLUGIN_PATH;
  },

  installHook(_forwarderPath: string): Promise<boolean> {
    const src = bundledPluginSource?.();
    if (!src) return Promise.resolve(false);
    try {
      // Only ever replace a file that is ours (marker in the head) or absent.
      if (fs.existsSync(PLUGIN_PATH) && installedPluginVersion() === 0) return Promise.resolve(false);
      fs.mkdirSync(path.dirname(PLUGIN_PATH), { recursive: true });
      const tmp = `${PLUGIN_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, src, { mode: 0o644 });
      fs.renameSync(tmp, PLUGIN_PATH);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  },

  uninstallHook(): Promise<boolean> {
    try {
      if (installedPluginVersion() === 0) return Promise.resolve(false);
      fs.unlinkSync(PLUGIN_PATH);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  },

  isHookInstalled(): boolean {
    return installedPluginVersion() > 0;
  },

  needsHookUpgrade(): boolean {
    const installed = installedPluginVersion();
    if (installed === 0) return false;
    const src = bundledPluginSource?.();
    if (!src) return false;
    return bundledPluginVersion(src) > installed;
  },

  isValidSessionId(id: string): boolean {
    return SESSION_ID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, _cwd: string, hintedPath?: string): string | undefined {
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    // Our plugin writes the file on the first event; return the computed path so
    // the tailer starts watching and picks it up when it appears.
    return transcriptPathFor(sessionId);
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceOpencodeTranscriptLine(state, line);
  },

  contextLimitFor(model: string | undefined): number {
    return contextLimitForModelString(model) ?? 200_000;
  },

  // The npm package ships the binary as `opencode.exe` on every platform.
  processNames: ['opencode', 'opencode.exe'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, OPENCODE_FLAGS);
  },

  // `--auto` = "auto-approve permissions that are not explicitly denied"; the
  // two hidden aliases mean the same. Argv reflects the INITIAL mode only — the
  // TUI can toggle auto-approve at runtime — but a live permission prompt is
  // reported by the plugin regardless, so the ⚠ is never wrong.
  yolo: {
    on: ['--auto'],
    off: ['--auto', '--yolo', '--dangerously-skip-permissions'],
  },

  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    const recorded = (transcriptPath ? readOpencodeTranscriptCwd(transcriptPath) : undefined)
      ?? opencodeSessionDirectory(sessionId);
    const base = recorded && recorded !== terminalCwd
      ? `cd ${posixQuote(recorded)} && opencode -s ${posixQuote(sessionId)}`
      : `opencode -s ${posixQuote(sessionId)}`;
    return withFlags(base, extraFlags, OPENCODE_FLAGS);
  },

  buildForkCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    // `--fork` with `-s` branches the conversation into a NEW session id
    // ("<title> (fork #N)") and opens that, so both branches can run live.
    const recorded = (transcriptPath ? readOpencodeTranscriptCwd(transcriptPath) : undefined)
      ?? opencodeSessionDirectory(sessionId);
    const base = recorded && recorded !== terminalCwd
      ? `cd ${posixQuote(recorded)} && opencode -s ${posixQuote(sessionId)} --fork`
      : `opencode -s ${posixQuote(sessionId)} --fork`;
    return withFlags(base, extraFlags, OPENCODE_FLAGS);
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const out = new Map<string, AgentSessionSummary>();
    // OpenCode's own database is the complete history (conversations that
    // predate our plugin included) …
    for (const r of listOpencodeSessions(cwd)) {
      const tp = transcriptPathFor(r.id);
      const hasTp = fs.existsSync(tp);
      const s = hasTp ? readOpencodeTranscriptSummary(tp) : undefined;
      out.set(r.id, {
        agent: 'opencode',
        sessionId: r.id,
        transcriptPath: hasTp ? tp : undefined,
        cwd: r.directory,
        firstUserMessage: s?.firstUserMessage ?? r.firstUserMessage,
        autoTitle: !isDefaultOpencodeTitle(r.title) ? r.title : s?.autoTitle,
        lineCount: s?.lineCount,
        byteSize: s?.byteSize,
        mtimeMs: r.timeUpdated,
      });
    }
    // … and our transcripts cover the case where sqlite3 is missing or the db
    // moved: anything we recorded is still listable and resumable.
    for (const f of safeReaddir(TRANSCRIPT_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId) || out.has(sessionId)) continue;
      const tp = path.join(TRANSCRIPT_DIR, f);
      const s = readOpencodeTranscriptSummary(tp);
      if (!s) continue;
      if (cwd && s.cwd) {
        const a = s.cwd.replace(/\/+$/, '');
        const b = cwd.replace(/\/+$/, '');
        if (a !== b && !a.startsWith(b + '/')) continue;
      }
      out.set(sessionId, {
        agent: 'opencode',
        sessionId,
        transcriptPath: tp,
        cwd: s.cwd,
        firstUserMessage: s.firstUserMessage,
        autoTitle: s.autoTitle,
        lineCount: s.lineCount,
        byteSize: s.byteSize,
        mtimeMs: s.mtimeMs,
      });
    }
    return [...out.values()].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  },

  readTranscriptSummary(transcriptPath: string) {
    return readOpencodeTranscriptSummary(transcriptPath);
  },
};
