import * as fs from 'fs';
import type { TranscriptTailState } from '../types';
import type { SubagentSnapshot } from '../../claude-transcript';
import { emptyTurnEvidence, noteAssistantText, noteToolResult } from '../../outcome';
import { contextLimitForModel } from './storage';

// ───────────────────────────── OpenCode transcript shape ─────────────────────────────
//
// OpenCode keeps every conversation in ONE shared SQLite database, so there is
// no per-session file to tail. Our plugin (media/opencode-plugin.js, installed
// as ~/.config/opencode/plugin/terminal-sessions.js) writes a JSONL of its own
// under ~/.terminal-sessions/opencode/<root-session-id>.jsonl. One file per ROOT
// conversation; subagent child sessions (OpenCode `parentID`) are written into
// the same file with their own `sessionID`, so the reducer can render them as
// subagents of the root. Every line carries `ts` (epoch ms) and `type`:
//
//   session   { id, parentID, directory, title, agent, version }
//   user      { sessionID, messageID, agent, text }
//   assistant { sessionID, messageID, providerID, modelID, agent, cost,
//               tokens{input,output,reasoning,cacheRead,cacheWrite,total},
//               finish, error, created, completed }
//   text      { sessionID, messageID, role:'assistant', text }
//   tool      { sessionID, messageID, callID, tool, status, input, title,
//               output?, error?, start, end }
//   turn_end  { sessionID, error }
//   error     { sessionID, name, message }
//
// As with Codex/Grok we set no `state` here — the plugin forwards the real
// lifecycle events through agent-hook.sh and the tracker owns the state
// machine. This reducer keeps tokens / cost / context / previews / tools /
// subagents fresh.

const DEFAULT_CONTEXT_LIMIT = 200_000;

interface OpencodeScratch {
  rootId?: string;
  cwd?: string;
  autoTitle?: string;
  /** callID → tool name, to clear the right in-flight tool on completion. */
  pendingCall?: string;
}

interface Line {
  ts?: number;
  type?: string;
  id?: string;
  parentID?: string | null;
  directory?: string;
  title?: string;
  agent?: string | null;
  sessionID?: string;
  messageID?: string;
  providerID?: string | null;
  modelID?: string | null;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  finish?: string | null;
  error?: string | boolean | null;
  completed?: number;
  text?: string;
  role?: string;
  callID?: string | null;
  tool?: string | null;
  status?: string | null;
  input?: string;
  output?: string;
  start?: number | null;
  end?: number | null;
  name?: string | null;
  message?: string | null;
}

function scratchOf(state: TranscriptTailState): OpencodeScratch {
  if (!state.scratch) state.scratch = {};
  const s = state.scratch as { opencode?: OpencodeScratch };
  if (!s.opencode) s.opencode = {};
  return s.opencode;
}

function compactPreview(s: string, max = 120): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3) + '...';
}

function tsOf(line: Line): Date {
  return typeof line.ts === 'number' ? new Date(line.ts) : new Date();
}

/** OpenCode's default title until its auto-titler runs. */
export function isDefaultOpencodeTitle(title: string | undefined): boolean {
  return !title || /^New session - /.test(title);
}

/**
 * Reduce one line of our OpenCode JSONL into the tail state. Returns true when
 * the snapshot changed. This is the OpencodeProvider's `reduceTranscriptLine`.
 */
export function reduceOpencodeTranscriptLine(state: TranscriptTailState, line: string): boolean {
  let o: Line;
  try { o = JSON.parse(line); }
  catch { return false; }
  if (!o || typeof o.type !== 'string') return false;

  const snap = state.snapshot;
  const scratch = scratchOf(state);
  const ts = tsOf(o);
  const rootId = scratch.rootId ?? snap.sessionId;
  const sid = typeof o.sessionID === 'string' ? o.sessionID : undefined;
  const sub = sid && sid !== rootId ? state.subagentMap.get(sid) : undefined;
  const isRoot = !sid || sid === rootId;

  switch (o.type) {
    case 'session': {
      if (typeof o.id !== 'string') return false;
      if (!o.parentID) {
        // Root conversation header (also rewritten whenever the title changes).
        scratch.rootId = o.id;
        if (typeof o.directory === 'string') scratch.cwd = o.directory;
        if (!isDefaultOpencodeTitle(o.title)) scratch.autoTitle = o.title;
        return false;
      }
      // Child session → subagent row. Keyed by the child's session id.
      const existing = state.subagentMap.get(o.id);
      if (existing) {
        if (o.title && !isDefaultOpencodeTitle(o.title)) existing.description = compactPreview(o.title);
        return true;
      }
      const parentSub = o.parentID !== rootId ? state.subagentMap.get(o.parentID) : undefined;
      const sa: SubagentSnapshot = {
        id: o.id,
        parentId: parentSub ? parentSub.id : undefined,
        depth: parentSub ? parentSub.depth + 1 : 0,
        agentType: typeof o.agent === 'string' ? o.agent : undefined,
        description: !isDefaultOpencodeTitle(o.title) ? compactPreview(o.title as string) : undefined,
        state: 'working',
        startedAt: ts,
        firstOffset: state.currentLineStart,
      };
      state.subagentMap.set(o.id, sa);
      return true;
    }

    case 'user': {
      const text = typeof o.text === 'string' ? compactPreview(o.text, 200) : '';
      if (sub) {
        if (text) sub.lastMessage = text;
        sub.state = 'working';
        return true;
      }
      if (!isRoot) return false;
      if (text) snap.lastUserMessage = text;
      snap.lastUserMessageAt = ts;
      snap.messageCount++;
      // A new human turn: drop the previous turn's tool evidence.
      snap.turn = emptyTurnEvidence();
      return true;
    }

    case 'assistant': {
      const msgId = typeof o.messageID === 'string' ? o.messageID : undefined;
      const billed = msgId ? state.seenMessageIds.has(msgId) : false;
      if (msgId) state.seenMessageIds.add(msgId);
      const t = o.tokens || {};
      const input = t.input || 0;
      const output = t.output || 0;
      const reasoning = t.reasoning || 0;
      const cacheRead = t.cacheRead || 0;
      const cacheWrite = t.cacheWrite || 0;
      const model = o.providerID && o.modelID ? `${o.providerID}/${o.modelID}` : (o.modelID || undefined);
      if (!billed) {
        // Cost is OpenCode's own figure (it prices against the same catalog the
        // TUI shows), summed across the root and its subagents like Claude does.
        snap.tokens.input += input;
        snap.tokens.output += output;
        snap.tokens.cacheRead += cacheRead;
        snap.tokens.cacheCreate5m += cacheWrite;
        const cost = typeof o.cost === 'number' && isFinite(o.cost) ? o.cost : 0;
        snap.cost += cost;
        if (model) snap.costByModel[model] = (snap.costByModel[model] || 0) + cost;
      }
      if (sub) {
        sub.state = 'working';
        return true;
      }
      if (!isRoot) return false;
      if (model) snap.model = model;
      snap.lastAssistantMessageAt = typeof o.completed === 'number' ? new Date(o.completed) : ts;
      snap.messageCount++;
      // Context = the sidebar formula OpenCode's own TUI uses: every token field
      // of the LAST assistant message that produced output (aborted/empty steps
      // would otherwise reset the gauge to 0%).
      if (output > 0) {
        const used = input + output + reasoning + cacheRead + cacheWrite;
        snap.currentContextTokens = used;
        if (used > snap.maxContextSeen) snap.maxContextSeen = used;
        const limit = contextLimitForModel(o.providerID || undefined, o.modelID || undefined);
        snap.currentContextLimit = limit ?? (snap.maxContextSeen > DEFAULT_CONTEXT_LIMIT ? 1_000_000 : DEFAULT_CONTEXT_LIMIT);
      }
      if (typeof o.error === 'string' && o.error) {
        const ev = (snap.turn ??= emptyTurnEvidence());
        if (/rate|overload|quota|429|529/i.test(o.error)) ev.rateLimitHint = o.error;
      }
      return true;
    }

    case 'text': {
      const text = typeof o.text === 'string' ? o.text : '';
      if (!text) return false;
      if (sub) { sub.lastMessage = compactPreview(text); return true; }
      if (!isRoot) return false;
      snap.lastAssistantMessage = compactPreview(text, 200);
      noteAssistantText(snap.turn ??= emptyTurnEvidence(), text);
      return true;
    }

    case 'tool': {
      const tool = typeof o.tool === 'string' && o.tool ? o.tool : 'tool';
      const status = typeof o.status === 'string' ? o.status : '';
      const callId = typeof o.callID === 'string' ? o.callID : undefined;
      if (sub) {
        if (status === 'running' || status === 'pending') {
          sub.state = 'tool';
          sub.currentTool = tool;
          sub.currentToolInput = o.input ? compactPreview(o.input) : undefined;
          sub.toolSince = ts;
        } else {
          sub.state = 'working';
          sub.currentTool = undefined;
          sub.currentToolInput = undefined;
          sub.toolSince = undefined;
        }
        return true;
      }
      if (!isRoot) return false;
      if (status === 'running' || status === 'pending') {
        scratch.pendingCall = callId;
        snap.currentToolName = tool;
        snap.currentToolInput = o.input ? compactPreview(o.input) : undefined;
        return true;
      }
      // completed / error: fold the result into the turn evidence, clear the
      // in-flight tool when it is the one we showed.
      const isError = status === 'error';
      const body = isError ? (o.error as string | undefined) : o.output;
      noteToolResult(snap.turn ??= emptyTurnEvidence(), typeof body === 'string' ? body : undefined, isError, tool);
      if (!callId || callId === scratch.pendingCall || !snap.currentToolName) {
        scratch.pendingCall = undefined;
        snap.currentToolName = undefined;
        snap.currentToolInput = undefined;
      }
      return true;
    }

    case 'turn_end': {
      if (sub) {
        sub.state = 'done';
        sub.completedAt = ts;
        sub.currentTool = undefined;
        sub.currentToolInput = undefined;
        return true;
      }
      if (!isRoot) return false;
      scratch.pendingCall = undefined;
      // The plugin flags a turn that ended on `session.error`; when no `error`
      // line explained it (event lost), the verdict must still not read "done".
      if (o.error === true) {
        const ev = (snap.turn ??= emptyTurnEvidence());
        if (!ev.lastToolErrored && !ev.rateLimitHint) {
          ev.toolErrors++;
          ev.lastToolErrored = true;
          ev.lastToolErrorPreview = 'turn ended with an error';
        }
      }
      if (snap.currentToolName) {
        snap.currentToolName = undefined;
        snap.currentToolInput = undefined;
        return true;
      }
      return o.error === true;
    }

    case 'error': {
      if (!isRoot) return false;
      const msg = [o.name, o.message].filter(Boolean).join(': ');
      if (!msg) return false;
      const ev = (snap.turn ??= emptyTurnEvidence());
      if (/rate|overload|quota|429|529/i.test(msg)) ev.rateLimitHint = compactPreview(msg, 90);
      else if (!/abort/i.test(msg)) { ev.toolErrors++; ev.lastToolErrored = true; ev.lastToolErrorPreview = compactPreview(msg, 90); }
      return true;
    }

    default:
      return false;
  }
}

// ───────────────────────────── summary reader ─────────────────────────────

export interface OpencodeTranscriptSummary {
  /** A root `session` header was seen (a subagent's file has only child headers). */
  isRoot: boolean;
  cwd?: string;
  firstUserMessage?: string;
  autoTitle?: string;
  lineCount?: number;
  byteSize?: number;
  mtimeMs?: number;
}

/**
 * Summary for the resume picker: recorded directory, OpenCode's auto title (the
 * newest `session` line wins — the title is rewritten as it changes), first user
 * prompt, size and mtime. Reads a bounded head window: these files hold
 * previews, not full outputs, so 256KB covers any realistic header.
 */
export function readOpencodeTranscriptSummary(transcriptPath: string): OpencodeTranscriptSummary | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(transcriptPath); }
  catch { return undefined; }

  const HEAD_BYTES = 256 * 1024;
  const readLen = Math.min(HEAD_BYTES, stat.size);
  let buf: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const b = Buffer.alloc(readLen);
    const n = fs.readSync(fd, b, 0, readLen, 0);
    buf = b.toString('utf8', 0, n);   // only what was read: the file may have shrunk since stat
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }

  const truncated = stat.size > readLen;
  let isRoot = false;
  let cwd: string | undefined;
  let firstUser: string | undefined;
  let autoTitle: string | undefined;
  let headLines = 0;
  let cursor = 0;
  while (cursor < buf.length) {
    const next = buf.indexOf('\n', cursor);
    if (next < 0 && truncated) break;
    const end = next < 0 ? buf.length : next;
    const line = buf.slice(cursor, end);
    if (line.length > 0) {
      headLines++;
      if (line[0] === '{') {
        try {
          const o = JSON.parse(line) as Line;
          if (o.type === 'session' && !o.parentID) {
            isRoot = true;
            if (!cwd && typeof o.directory === 'string' && o.directory.startsWith('/')) cwd = o.directory;
            if (!isDefaultOpencodeTitle(o.title)) autoTitle = o.title;
          } else if (o.type === 'user' && !firstUser && typeof o.text === 'string') {
            const t = o.text.trim();
            if (t) firstUser = t;
          }
        } catch { /* malformed line */ }
      }
    }
    if (next < 0) break;
    cursor = next + 1;
  }

  const lineCount = truncated && headLines > 0
    ? Math.round(stat.size / (readLen / headLines))
    : headLines;

  return {
    isRoot,
    cwd,
    firstUserMessage: firstUser?.slice(0, 200),
    autoTitle,
    lineCount,
    byteSize: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Just the recorded directory of a root conversation (first `session` header). */
export function readOpencodeTranscriptCwd(transcriptPath: string): string | undefined {
  try {
    const buf = fs.readFileSync(transcriptPath, 'utf8');
    const lines = buf.split('\n');
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      const line = lines[i];
      if (!line || line[0] !== '{') continue;
      try {
        const o = JSON.parse(line) as Line;
        if (o.type === 'session' && !o.parentID && typeof o.directory === 'string' && o.directory.startsWith('/')) {
          return o.directory;
        }
      } catch { /* keep scanning */ }
    }
  } catch { /* unreadable */ }
  return undefined;
}
