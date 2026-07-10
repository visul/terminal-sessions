import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from '../types';
import { commandOnPath } from '../detect';
import { FlagSpec, captureFlags, withFlags } from '../launch-flags';
import { posixQuote } from '../../shell-escape';
import {
  reduceGrokTranscriptLine,
  readGrokTranscriptSummary,
  readGrokTranscriptCwd,
} from './transcript';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const GROK_HOME = path.join(os.homedir(), '.grok');
const SESSIONS_ROOT = path.join(GROK_HOME, 'sessions');
/** Live grok sessions: {session_id, pid, cwd}. Used for process-based discovery. */
export const ACTIVE_SESSIONS_PATH = path.join(GROK_HOME, 'active_sessions.json');

// Grok "character" launch flags. yolo is `--always-approve` (or
// `--permission-mode bypassPermissions`). Worktree / prompt / resume flags are
// launch-specific and intentionally NOT carried. MCP lives in grok's own config.
const GROK_FLAGS: FlagSpec = {
  bool: ['--always-approve'],
  value: {
    '--model': {},
    '--permission-mode': {},
    '--sandbox': {},
    '--effort': {},
    '--reasoning-effort': {},
    '--agent': {},
  },
  alias: { '-m': '--model' },
};

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}

function safeDecode(enc: string): string | undefined {
  try { return decodeURIComponent(enc); }
  catch { return undefined; }
}

/** True when `sessionCwd` is at or under `cwd` (so a workspace-root filter keeps
 *  sessions started in subfolders). */
function isCwdMatch(sessionCwd: string, cwd: string): boolean {
  const a = sessionCwd.replace(/\/+$/, '');
  const b = cwd.replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/');
}

/** The session directory `~/.grok/sessions/<urlencoded-cwd>/<id>`. Tries the
 *  encoded cwd first, then scans every cwd bucket for the id (handles a resume
 *  invoked from a different directory than the session was created in). */
function sessionDir(sessionId: string, cwd?: string): string | undefined {
  if (cwd) {
    const d = path.join(SESSIONS_ROOT, encodeURIComponent(cwd), sessionId);
    if (fs.existsSync(d)) return d;
  }
  for (const enc of safeReaddir(SESSIONS_ROOT)) {
    const d = path.join(SESSIONS_ROOT, enc, sessionId);
    if (fs.existsSync(d)) return d;
  }
  return undefined;
}

/** Path to a session's `updates.jsonl` stream (the file we tail). */
export function grokTranscriptPath(sessionId: string, cwd?: string): string | undefined {
  const d = sessionDir(sessionId, cwd);
  if (!d) return undefined;
  const u = path.join(d, 'updates.jsonl');
  return fs.existsSync(u) ? u : undefined;
}

export const grokProvider: AgentProvider = {
  id: 'grok',
  displayName: 'Grok',
  badge: 'grok',
  badgeIcon: 'zap',
  // Sessions are stored per-cwd and `grok -r` resolves them from the working
  // directory, so resume must cd back to the recorded cwd first.
  resumeNeedsCwd: true,
  // Grok hooks are project-scoped and trust-gated, so we do NOT install a global
  // lifecycle hook. Grok is tracked entirely from its transcript + a process
  // poll (see ClaudeTracker.pollGrokSessions). These no-ops keep it out of the
  // hook install/upgrade prompts.
  hookEvents: [],

  isInstalled(): boolean {
    return commandOnPath('grok');
  },

  settingsPath(): string {
    return GROK_HOME;
  },

  installHook(_forwarderPath: string): Promise<boolean> {
    return Promise.resolve(false); // transcript-driven; nothing to install
  },

  uninstallHook(): Promise<boolean> {
    return Promise.resolve(false);
  },

  isHookInstalled(): boolean {
    return true; // pretend satisfied so the "install hooks" prompt skips Grok
  },

  needsHookUpgrade(): boolean {
    return false;
  },

  isValidSessionId(id: string): boolean {
    return UUID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, cwd: string, hintedPath?: string): string | undefined {
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    if (!UUID_RE.test(sessionId)) return undefined;
    return grokTranscriptPath(sessionId, cwd);
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceGrokTranscriptLine(state, line);
  },

  contextLimitFor(_model: string | undefined): number {
    // The stream carries no explicit window; the reducer bumps to 1M once usage
    // crosses 200k. 256k is the pre-first-token fallback.
    return 256_000;
  },

  processNames: ['grok'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, GROK_FLAGS);
  },

  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    const recorded = transcriptPath ? readGrokTranscriptCwd(transcriptPath) : undefined;
    // Single-quote the recorded cwd and session id (posixQuote) so a path or id
    // carrying shell metacharacters isn't expanded when the resume command runs.
    const base = recorded && recorded !== terminalCwd
      ? `cd ${posixQuote(recorded)} && grok -r ${posixQuote(sessionId)}`
      : `grok -r ${posixQuote(sessionId)}`;
    return withFlags(base, extraFlags, GROK_FLAGS);
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const out: AgentSessionSummary[] = [];
    const encFilter = cwd ? encodeURIComponent(cwd) : undefined;
    for (const enc of safeReaddir(SESSIONS_ROOT)) {
      if (encFilter && enc !== encFilter) {
        // Allow subfolder sessions through a workspace-root filter.
        const decoded = safeDecode(enc);
        if (!decoded || !cwd || !isCwdMatch(decoded, cwd)) continue;
      }
      const bucket = path.join(SESSIONS_ROOT, enc);
      for (const sid of safeReaddir(bucket)) {
        if (!UUID_RE.test(sid)) continue;
        const u = path.join(bucket, sid, 'updates.jsonl');
        if (!fs.existsSync(u)) continue;
        const s = readGrokTranscriptSummary(u);
        out.push({
          agent: 'grok',
          sessionId: sid,
          transcriptPath: u,
          cwd: s?.cwd ?? safeDecode(enc),
          firstUserMessage: s?.firstUserMessage,
          lineCount: s?.lineCount,
          byteSize: s?.byteSize,
          mtimeMs: s?.mtimeMs,
        });
      }
    }
    out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    return out;
  },

  readTranscriptSummary(transcriptPath: string) {
    return readGrokTranscriptSummary(transcriptPath);
  },
};

/** A live grok session as recorded in ~/.grok/active_sessions.json. */
export interface GrokActiveSession {
  session_id: string;
  pid: number;
  cwd: string;
}

/** Read currently-running grok sessions (best-effort, never throws). */
export function readGrokActiveSessions(): GrokActiveSession[] {
  try {
    const raw = fs.readFileSync(ACTIVE_SESSIONS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: GrokActiveSession[] = [];
    for (const e of arr) {
      if (e && typeof e === 'object'
          && typeof e.session_id === 'string'
          && typeof e.pid === 'number'
          && typeof e.cwd === 'string') {
        out.push({ session_id: e.session_id, pid: e.pid, cwd: e.cwd });
      }
    }
    return out;
  } catch {
    return [];
  }
}
