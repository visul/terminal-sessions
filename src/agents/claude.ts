import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from './types';
import { commandOnPath } from './detect';
import { FlagSpec, captureFlags, withFlags } from './launch-flags';
import { posixQuote } from '../shell-escape';
import {
  installJsonSettingsHook,
  uninstallJsonSettingsHook,
  isJsonSettingsHookInstalled,
} from './hooks';
import {
  findTranscriptBySessionId,
  readTranscriptCwd,
  readTranscriptSummary,
  reduceClaudeTranscriptLine,
  scanBackgroundAgents,
  slugFromCwd,
  transcriptPathFor,
} from '../claude-transcript';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Launch flags worth restoring on resume. `--strict-mcp-config`/`--mcp-config`
// are captured but the path filter drops the ephemeral claude-pick temp at
// relaunch (and `--strict-mcp-config` goes with it), leaving MCP to claude-pick.
const CLAUDE_FLAGS: FlagSpec = {
  bool: ['--dangerously-skip-permissions', '--strict-mcp-config'],
  value: {
    '--model': {},
    '--permission-mode': {},
    '--add-dir': { path: true },
    '--settings': { path: true },
    '--mcp-config': { path: true },
  },
  companion: { '--strict-mcp-config': '--mcp-config' },
};

// Order matters only for readability; the forwarder is installed for each.
const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

// Match both the new shared forwarder and the legacy claude-only script so an
// install replaces a prior entry of ours and uninstall removes either.
function isOurClaudeHook(command: string): boolean {
  return command.includes('agent-hook.sh') || command.includes('claude-hook.sh');
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude',
  badge: 'claude',
  badgeIcon: 'hubot',
  resumeNeedsCwd: true,
  supportsFork: true,
  hookEvents: CLAUDE_HOOK_EVENTS,

  isInstalled(): boolean {
    return commandOnPath('claude');
  },

  settingsPath(): string {
    return SETTINGS_PATH;
  },

  installHook(forwarderPath: string): Promise<boolean> {
    return installJsonSettingsHook({
      settingsPath: SETTINGS_PATH,
      events: CLAUDE_HOOK_EVENTS,
      command: (event) => `"${forwarderPath}" claude ${event}`,
      isOurs: isOurClaudeHook,
    });
  },

  uninstallHook(): Promise<boolean> {
    return uninstallJsonSettingsHook(SETTINGS_PATH, isOurClaudeHook);
  },

  isHookInstalled(): boolean {
    return isJsonSettingsHookInstalled(SETTINGS_PATH, 'agent-hook.sh')
      || isJsonSettingsHookInstalled(SETTINGS_PATH, 'claude-hook.sh');
  },

  needsHookUpgrade(): boolean {
    if (!fs.existsSync(SETTINGS_PATH)) return false;
    let raw: string;
    try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8'); }
    catch { return false; }
    // Legacy single-purpose forwarder → migrate to the shared agent-hook.sh.
    if (raw.includes('claude-hook.sh') && !raw.includes('agent-hook.sh')) return true;
    if (!raw.includes('agent-hook.sh')) return false;
    // New forwarder present but missing one of the expected events.
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (!raw.includes(event)) return true;
    }
    return false;
  },

  isValidSessionId(id: string): boolean {
    return UUID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, cwd: string, hintedPath?: string): string | undefined {
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    const found = findTranscriptBySessionId(cwd, sessionId);
    if (found) return found;
    // New session — the jsonl may not exist yet. Return the computed path so the
    // tailer starts watching and picks it up on first write (matches the old
    // behavior that used transcriptPathFor directly).
    return cwd ? transcriptPathFor(cwd, sessionId) : hintedPath;
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceClaudeTranscriptLine(state, line);
  },

  afterTranscriptDelta(state: TranscriptTailState): boolean {
    return scanBackgroundAgents(state);
  },

  contextLimitFor(model: string | undefined): number {
    const m = model || '';
    // Opus / Sonnet 4.5+ default to the 1M-context window under Claude Code
    // Pro/Max; older models stay at 200k.
    return /claude-(opus|sonnet)-4-[5-9]/i.test(m) ? 1_000_000 : 200_000;
  },

  processNames: ['claude'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, CLAUDE_FLAGS);
  },

  // `--allow-dangerously-skip-permissions` is deliberately absent: it only makes
  // the bypass *available* ("without it being enabled by default"), so its
  // presence does not mean the session is running unattended.
  //
  // Of the `--permission-mode` values only `bypassPermissions` is auto-approve.
  // `dontAsk` is the OPPOSITE — Claude's own help text reads "Don't prompt for
  // permissions, deny if not pre-approved", i.e. a hardening mode for headless
  // runs — so treating it as yolo would slap the 🚨 on the most cautious users.
  // `acceptEdits` only covers file edits (shell commands still ask).
  //
  // `bypassPermissions` is kept even though on its own it is inert (the binary
  // refuses it with "the session was not launched with
  // --dangerously-skip-permissions"): combined with the
  // `--allow-dangerously-skip-permissions` gate it IS an effective bypass with
  // no bool flag present, and that combination would otherwise read as normal —
  // the one direction we must never get wrong.
  yolo: {
    on: ['--dangerously-skip-permissions'],
    off: ['--dangerously-skip-permissions'],
    offValues: { '--permission-mode': ['bypassPermissions'] },
  },

  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    const recordedCwd = transcriptPath ? readTranscriptCwd(transcriptPath) : undefined;
    const base = recordedCwd && recordedCwd !== terminalCwd
      // `claude --resume` only finds the conversation when invoked from the same
      // project slug it was launched in, so cd back to the recorded cwd first.
      // Both values are single-quoted (posixQuote) so a recorded path or session
      // id carrying shell metacharacters can't be expanded when the command is
      // typed into the terminal.
      ? `cd ${posixQuote(recordedCwd)} && claude --resume ${posixQuote(sessionId)}`
      : `claude --resume ${posixQuote(sessionId)}`;
    return withFlags(base, extraFlags, CLAUDE_FLAGS);
  },

  buildForkCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    const recordedCwd = transcriptPath ? readTranscriptCwd(transcriptPath) : undefined;
    // Identical to buildResumeCommand plus `--fork-session`, which makes Claude
    // continue this conversation under a NEW id — the two branches never share a
    // transcript, so they can run as independent live tabs. Same cd-back-to-slug
    // rule and posixQuote hardening apply.
    const base = recordedCwd && recordedCwd !== terminalCwd
      ? `cd ${posixQuote(recordedCwd)} && claude --resume ${posixQuote(sessionId)} --fork-session`
      : `claude --resume ${posixQuote(sessionId)} --fork-session`;
    return withFlags(base, extraFlags, CLAUDE_FLAGS);
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const out: AgentSessionSummary[] = [];
    const slugs = cwd ? [slugFromCwd(cwd)] : safeReaddir(root);
    for (const slug of slugs) {
      const dir = path.join(root, slug);
      for (const f of safeReaddir(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.replace(/\.jsonl$/, '');
        if (!UUID_RE.test(sessionId)) continue;
        const tp = path.join(dir, f);
        const s = readTranscriptSummary(tp);
        out.push({
          agent: 'claude',
          sessionId,
          transcriptPath: tp,
          cwd: s?.cwd,
          firstUserMessage: s?.firstUserMessage,
          lineCount: s?.lineCount,
          byteSize: s?.byteSize,
          mtimeMs: s?.mtimeMs,
          // Agent-team teammates / pure subagent transcripts are tagged here;
          // scanArchive() drops them so the picker lists only main threads.
          subsessionRole: s?.subsessionRole,
        });
      }
    }
    out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    return out;
  },

  readTranscriptSummary(transcriptPath: string) {
    return readTranscriptSummary(transcriptPath);
  },
};

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}
