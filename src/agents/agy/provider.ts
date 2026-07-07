import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from '../types';
import { commandOnPath } from '../detect';
import {
  installJsonSettingsHook,
  uninstallJsonSettingsHook,
  isJsonSettingsHookInstalled,
} from '../hooks';
import { reduceAgyTranscriptLine, readAgyTranscriptSummary } from './transcript';
import { FlagSpec, captureFlags, withFlags } from '../launch-flags';

// agy mirrors Claude's launch surface (same `--dangerously-skip-permissions`
// yolo flag, per the user's `agyd` alias). MCP lives in agy's own config, not
// on the command line, so nothing MCP-ish is captured here.
const AGY_FLAGS: FlagSpec = {
  bool: ['--dangerously-skip-permissions'],
  value: { '--model': {}, '--add-dir': { path: true } },
};

// ───────────────────────── Antigravity (`agy`) provider ─────────────────────────
//
// Google Antigravity CLI. Go binary `agy` at ~/.local/bin/agy. It reuses the
// Claude-Code-compatible settings.json hook schema, so hook install/uninstall
// is shared via ../hooks. On top of the event hooks we also register a
// `statusLine` command so the forwarder receives rich live state (agent_state,
// context_window, conversation_id, model, cwd) on every state change.
//
// CLI home is ~/.gemini/antigravity-cli/ (NOT ~/.antigravity, and NOT the
// sibling ~/.gemini/settings.json which belongs to a different tool, Gemini CLI).

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SETTINGS_PATH = path.join(AGY_HOME, 'settings.json');
const BRAIN_DIR = path.join(AGY_HOME, 'brain');
const LAST_CONV_PATH = path.join(AGY_HOME, 'cache', 'last_conversations.json');
const HISTORY_PATH = path.join(AGY_HOME, 'history.jsonl');

// Events agy emits with the Claude-compatible hook schema. Stop → turn finished
// (idle); Notification → agent needs user input (waiting).
const AGY_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
] as const;

// Both the shared forwarder name and the marker we match on for our entries.
const HOOK_MARKER = 'agent-hook.sh';

function isOurAgyHook(command: string): boolean {
  return command.includes(HOOK_MARKER);
}

function transcriptPathForConv(convId: string): string {
  return path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function safeReadJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return undefined; }
}

/** Read the cwd → conversationId map agy keeps in cache/last_conversations.json. */
function readLastConversations(): Record<string, string> {
  return safeReadJson<Record<string, string>>(LAST_CONV_PATH) ?? {};
}

/** Reverse-lookup: the recorded cwd for a conversation id (best effort). */
function recordedCwdForConv(convId: string): string | undefined {
  const map = readLastConversations();
  for (const [cwd, id] of Object.entries(map)) {
    if (id === convId) return cwd;
  }
  return undefined;
}

/**
 * Register the statusLine command in agy's settings.json without disturbing the
 * hooks block. agy adopts the Claude-Code statusLine shape:
 *   { "statusLine": { "type": "command", "command": "…", "stack_with_default": true } }
 * `stack_with_default` keeps agy's own status line visible alongside ours.
 */
function installStatusLine(forwarderPath: string): boolean {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    const parsed = safeReadJson<Record<string, unknown>>(SETTINGS_PATH);
    if (!parsed) return false; // unparseable — installJsonSettingsHook already warned
    settings = parsed;
  }
  settings.statusLine = {
    type: 'command',
    command: `"${forwarderPath}" agy statusline`,
    stack_with_default: true,
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch { return false; }
}

function uninstallStatusLine(): void {
  if (!fs.existsSync(SETTINGS_PATH)) return;
  const settings = safeReadJson<Record<string, unknown>>(SETTINGS_PATH);
  if (!settings) return;
  const sl = settings.statusLine as { command?: unknown } | undefined;
  if (sl && typeof sl === 'object' && typeof sl.command === 'string' && isOurAgyHook(sl.command)) {
    delete settings.statusLine;
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); }
    catch { /* best effort */ }
  }
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}

export const agyProvider: AgentProvider = {
  id: 'agy',
  displayName: 'Antigravity',
  badge: 'agy',
  badgeIcon: 'rocket',
  resumeNeedsCwd: true,
  hookEvents: AGY_HOOK_EVENTS,

  isInstalled(): boolean {
    return commandOnPath('agy');
  },

  settingsPath(): string {
    return SETTINGS_PATH;
  },

  async installHook(forwarderPath: string): Promise<boolean> {
    const ok = await installJsonSettingsHook({
      settingsPath: SETTINGS_PATH,
      events: AGY_HOOK_EVENTS,
      command: (event) => `"${forwarderPath}" agy ${event}`,
      isOurs: isOurAgyHook,
    });
    if (!ok) return false;
    // Read-modify-write a second time to add the statusLine entry alongside the
    // hooks that installJsonSettingsHook just wrote.
    return installStatusLine(forwarderPath);
  },

  async uninstallHook(): Promise<boolean> {
    uninstallStatusLine();
    return uninstallJsonSettingsHook(SETTINGS_PATH, isOurAgyHook);
  },

  isHookInstalled(): boolean {
    return isJsonSettingsHookInstalled(SETTINGS_PATH, HOOK_MARKER);
  },

  needsHookUpgrade(): boolean {
    if (!fs.existsSync(SETTINGS_PATH)) return false;
    let raw: string;
    try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8'); }
    catch { return false; }
    if (!raw.includes(HOOK_MARKER)) return false;
    // Missing an expected event, or the statusLine registration → upgrade.
    for (const event of AGY_HOOK_EVENTS) {
      if (!raw.includes(event)) return true;
    }
    if (!raw.includes('statusline')) return true;
    return false;
  },

  isValidSessionId(id: string): boolean {
    return UUID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, cwd: string, hintedPath?: string): string | undefined {
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    if (!UUID_RE.test(sessionId)) return hintedPath;
    // The transcript may not exist yet for a brand-new conversation; return the
    // computed path so the tailer starts watching and picks it up on first write.
    return transcriptPathForConv(sessionId);
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceAgyTranscriptLine(state, line);
  },

  contextLimitFor(model: string | undefined): number {
    // Gemini-class models default to a very large window; the statusLine payload
    // supplies the real context_window_size when available.
    void model;
    return 1_000_000;
  },

  processNames: ['agy'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, AGY_FLAGS);
  },

  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    void transcriptPath;
    const recorded = recordedCwdForConv(sessionId);
    const base = recorded && recorded !== terminalCwd
      // agy is cwd-sensitive; cd back to the recorded workspace before resuming.
      ? `cd "${recorded.replace(/"/g, '\\"')}" && agy --conversation ${sessionId}`
      : `agy --conversation ${sessionId}`;
    return withFlags(base, extraFlags, AGY_FLAGS);
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const out: AgentSessionSummary[] = [];
    const lastConv = readLastConversations();

    // cwd → conv map gives us the authoritative cwd for each conversation.
    const cwdByConv = new Map<string, string>();
    for (const [dir, id] of Object.entries(lastConv)) {
      if (typeof id === 'string') cwdByConv.set(id, dir);
    }

    // Most recent prompt text per conversation (from the global history log).
    const firstMsgByConv = new Map<string, string>();
    try {
      const hist = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n');
      for (const line of hist) {
        if (!line) continue;
        try {
          const h = JSON.parse(line) as { display?: string; conversationId?: string };
          if (h.conversationId && typeof h.display === 'string' && !firstMsgByConv.has(h.conversationId)) {
            firstMsgByConv.set(h.conversationId, h.display.slice(0, 200));
          }
        } catch { /* skip */ }
      }
    } catch { /* no history yet */ }

    // Enumerate on-disk conversations by their brain/ transcript dirs.
    for (const convId of safeReaddir(BRAIN_DIR)) {
      if (!UUID_RE.test(convId)) continue;
      const tp = transcriptPathForConv(convId);
      if (!fs.existsSync(tp)) continue;
      const recordedCwd = cwdByConv.get(convId);
      if (cwd && recordedCwd && recordedCwd !== cwd) continue; // cwd filter
      const summary = readAgyTranscriptSummary(tp);
      out.push({
        agent: 'agy',
        sessionId: convId,
        transcriptPath: tp,
        cwd: recordedCwd,
        firstUserMessage: firstMsgByConv.get(convId) ?? summary?.firstUserMessage,
        lineCount: summary?.lineCount,
        byteSize: summary?.byteSize,
        mtimeMs: summary?.mtimeMs,
      });
    }

    out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    return out;
  },

  readTranscriptSummary(transcriptPath: string) {
    return readAgyTranscriptSummary(transcriptPath);
  },
};
