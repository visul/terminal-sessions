// Shared agent-abstraction types. Kept dependency-free (no imports from the
// concrete tracker/transcript modules) so it can sit at the bottom of the
// import graph: claude-transcript.ts, claude-tracker.ts and every provider
// import FROM here, never the other way around. That avoids a cycle between
// the provider interface (which references TranscriptTailState) and the
// transcript module (which references AgentProvider).

import type {
  SubagentSnapshot,
  TranscriptSnapshot,
  MsgInfo,
} from '../claude-transcript';

export type AgentId = 'claude' | 'codex' | 'agy' | 'grok';

/** Normalized lifecycle state every provider maps its native events onto. */
export type AgentState = 'none' | 'working' | 'tool' | 'waiting' | 'idle';

// The transcript snapshot types (TranscriptSnapshot, SubagentSnapshot, MsgInfo,
// SubagentState) live in claude-transcript.ts. They're imported here type-only
// — a type-only import cycle that tsc erases at emit, so there's no runtime
// circular dependency.

/** Mutable per-session tail state. The generic TranscriptTailer owns the file
 *  bookkeeping (offset/watcher) and delegates line parsing to the provider's
 *  `reduceTranscriptLine(state, line)`. Provider-specific scratch state lives
 *  under `scratch`. */
export interface TranscriptTailState {
  snapshot: TranscriptSnapshot;
  offset: number;
  watcher?: import('fs').FSWatcher;
  pendingToolUseIds: Set<string>;
  /** message.id values already billed for, to de-duplicate retried turns. */
  seenMessageIds: Set<string>;
  /** Per-subagent mutable state (same items as snapshot.subagents, indexed). */
  subagentMap: Map<string, SubagentSnapshot>;
  /** msg.uuid → parent lookup so we can attribute sidechain activity. */
  msgInfo: Map<string, MsgInfo>;
  /** Byte offset at the start of the current line being parsed. */
  currentLineStart: number;
  /** The provider that owns this session's parsing. */
  provider: AgentProvider;
  /** Free-form per-provider scratch (Codex/agy keep their own running state). */
  scratch?: Record<string, unknown>;
}

// ───────────────────────── provider discovery ─────────────────────────

/** A past session found on disk, surfaced in the manual "Resume Other…" picker. */
export interface AgentSessionSummary {
  agent: AgentId;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  firstUserMessage?: string;
  lineCount?: number;
  byteSize?: number;
  mtimeMs?: number;
  /** Set when this session is a spawned sub-session rather than a top-level
   *  user thread: `teammate` = an agent-team member, `subagent` = a transcript
   *  that is purely subagent/sidechain activity. The archive picker hides these
   *  so only main threads are listed. Providers without the concept never set
   *  it, so all their sessions stay visible (Codex/agy/grok today). */
  subsessionRole?: 'teammate' | 'subagent';
}

/**
 * Declarative description of an agent's "YOLO" (auto-approve) launch surface.
 *
 * Agents express the same idea with different flags — and several express it
 * more than one way (`--yolo` vs `--full-auto`, or a *value* flag such as
 * `--permission-mode bypassPermissions`). Detection therefore has to consider
 * every spelling, while turning the mode ON only ever emits the canonical one.
 */
export interface YoloSpec {
  /** Canonical flags added when switching a session TO yolo. */
  on: readonly string[];
  /** Valueless flags that MEAN yolo. Any of them present ⇒ the session is yolo;
   *  all of them are removed when switching to Normal. Include every alias, not
   *  just the canonical `on` flag. */
  off: readonly string[];
  /** Value-taking flags whose listed values also mean yolo, e.g.
   *  `{'--permission-mode': ['bypassPermissions']}`. Matching pairs are removed
   *  in BOTH directions: switching to Normal because they grant the bypass, and
   *  switching to YOLO because they would otherwise conflict with `on`. */
  offValues?: Readonly<Record<string, readonly string[]>>;
  /** Value flags that contradict yolo and must be dropped when enabling it
   *  (Codex's `--sandbox`/`--ask-for-approval` refuse to coexist with `--yolo`).
   *  Unlike `offValues` these are dropped whatever their value, and only when
   *  switching TO yolo. */
  conflicts?: readonly string[];
}

// ───────────────────────── the provider contract ─────────────────────────

export interface AgentProvider {
  id: AgentId;
  /** Human label shown in the sidebar/tooltips ("Claude", "Codex", …). */
  displayName: string;
  /** Short tag rendered next to a row so agents are distinguishable at a glance. */
  badge: string;
  /** Codicon id used to tint/badge this agent's rows (optional flourish). */
  badgeIcon?: string;
  /** CLI present on PATH. */
  isInstalled(): boolean;

  // ---- hook install (per-agent settings target) ----
  /** The agent's settings file we write hooks into. */
  settingsPath(): string;
  /** Event names this agent emits (used for upgrade detection / UI). */
  hookEvents: readonly string[];
  /** Install our forwarder as a hook for every event. `forwarderPath` is the
   *  shared `agent-hook.sh`; the provider wires it as `"<path>" <id> <Event>`. */
  installHook(forwarderPath: string): Promise<boolean>;
  uninstallHook(): Promise<boolean>;
  isHookInstalled(): boolean;
  /** True when a hook is installed but missing newer events. */
  needsHookUpgrade(): boolean;

  // ---- identity & transcript ----
  isValidSessionId(id: string): boolean;
  /** Locate the transcript file for a session. `hintedPath` is the
   *  `transcript_path` the hook reported (most reliable when present). */
  resolveTranscriptPath(sessionId: string, cwd: string, hintedPath?: string): string | undefined;
  /** Parse one transcript line into the mutable tail state. Returns true if the
   *  snapshot changed. */
  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean;
  /** Optional post-delta hook (e.g. Claude background-agent dir scan). */
  afterTranscriptDelta?(state: TranscriptTailState): boolean;
  /** Context window for a model string (used when the transcript doesn't carry
   *  an explicit limit). */
  contextLimitFor(model: string | undefined): number;

  // ---- launch-flag preservation ----
  /** Executable basenames to match when reading launch flags from `ps`
   *  (e.g. `['claude']`). Used to find the live agent process under a tmux pane. */
  processNames: readonly string[];
  /** Extract the allowlisted "character" launch flags (yolo, --model, sandbox, …)
   *  from a live process argv, so resume can relaunch the conversation the way it
   *  was started. Drops resume/continue/print/prompt and ephemeral MCP flags. */
  captureResumeFlags(argv: readonly string[]): string[];
  /** Which of this agent's launch flags mean "auto-approve everything". Drives
   *  the 🚨 sidebar chip and the Switch to YOLO/Normal Mode commands. Omit it
   *  and both are hidden for the agent — no UI claims a mode it can't set. */
  yolo?: YoloSpec;

  // ---- resume ----
  /** Build the shell command that resumes `sessionId`. `terminalCwd` is where
   *  the attached terminal currently sits; providers that are cwd-sensitive may
   *  prepend a `cd`. `extraFlags` are the captured launch flags to re-apply
   *  (dead path flags are filtered out by the provider at build time). */
  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string;
  /** Whether resume needs to run from the recorded cwd (Claude: yes; Codex: no). */
  resumeNeedsCwd: boolean;

  // ---- fork ----
  /** Whether this agent can fork a conversation into a NEW, independent
   *  conversation id (Claude: `--fork-session`). When false, the Fork command is
   *  hidden for the agent's sessions — a plain resume in a second live tab would
   *  interleave both into one transcript rather than branching. */
  supportsFork: boolean;
  /** Build the shell command that forks `sessionId` into an independent branch
   *  (same shape as buildResumeCommand). Only implemented/called when
   *  `supportsFork` is true. */
  buildForkCommand?(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string;

  // ---- discovery ----
  /** Recent sessions on disk for the manual picker, newest-ish first. */
  listSessions(cwd?: string): AgentSessionSummary[];
  /** Lightweight summary of a transcript for the resume picker + ranking
   *  (cwd-subset filter, size tie-break, preview). Optional — when absent,
   *  callers fall back to `fs.stat` for byteSize/mtimeMs and skip the cwd
   *  filter for that agent. */
  readTranscriptSummary?(transcriptPath: string): {
    cwd?: string;
    firstUserMessage?: string;
    lineCount?: number;
    byteSize?: number;
    mtimeMs?: number;
    subsessionRole?: 'teammate' | 'subagent';
  } | undefined;
}
