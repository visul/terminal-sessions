import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptTailState } from '../types';

// ───────────────────────────── Grok transcript shape ─────────────────────────────
//
// Grok (xAI CLI) writes a session under
//   ~/.grok/sessions/<urlencoded-cwd>/<session-id>/
// with several files. We tail `updates.jsonl` — an Agent-Client-Protocol (ACP)
// stream where every line is a JSON-RPC notification:
//
//   { "timestamp": <unix-s>, "method": "session/update" | "_x.ai/session/update",
//     "params": { "sessionId", "update": { "sessionUpdate": <type>, ... },
//                 "_meta": { "totalTokens", "promptId", "eventId", ... } } }
//
// sessionUpdate types we care about:
//   user_message_chunk / agent_message_chunk  → streamed message text (chunks)
//   agent_thought_chunk                        → thinking (activity, no field)
//   tool_call                                  → tool start (title + rawInput)
//   tool_call_update                           → tool progress/end (status)
//   available_commands_update / hook_execution → ignored
//
// Like the Codex reducer we do NOT set any `state` — the tracker derives
// working/idle from transcript mtime + the user/assistant message timestamps.
// We keep tokens (from `_meta.totalTokens`), the last user/assistant preview,
// message count, model (read once from the sibling summary.json) and the live
// tool name/input fresh. Grok is subscription-billed and the stream carries no
// per-token cost split, so we leave `tokens`/`cost` at 0 and surface context%.

interface GrokScratch {
  modelChecked?: boolean;
  curRole?: 'user' | 'assistant';
  curPromptId?: string;
  userBuf?: string;
  asstBuf?: string;
}

function scratchOf(state: TranscriptTailState): GrokScratch {
  if (!state.scratch) state.scratch = {};
  const s = state.scratch as { grok?: GrokScratch };
  if (!s.grok) s.grok = {};
  return s.grok;
}

function compactPreview(s: string, max = 120): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3) + '...';
}

/** Short label for a tool_call's rawInput (the command/path/query inside it). */
function previewToolInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'target_directory', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = o[k];
    if (typeof v === 'string' && v) return compactPreview(v);
  }
  return undefined;
}

function tsFrom(v: unknown): Date | undefined {
  if (typeof v === 'number') return new Date(v * 1000);
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; }
  return undefined;
}

/**
 * Reduce one Grok `updates.jsonl` line into the tail state. Returns true if the
 * snapshot changed. This is the GrokProvider's `reduceTranscriptLine`.
 */
export function reduceGrokTranscriptLine(state: TranscriptTailState, line: string): boolean {
  let o: { timestamp?: unknown; method?: unknown; params?: unknown };
  try { o = JSON.parse(line); }
  catch { return false; }

  const method = typeof o.method === 'string' ? o.method : '';
  if (method !== 'session/update' && method !== '_x.ai/session/update') return false;
  const params = (o.params && typeof o.params === 'object') ? (o.params as Record<string, unknown>) : undefined;
  if (!params) return false;
  const update = (params.update && typeof params.update === 'object') ? (params.update as Record<string, unknown>) : undefined;
  if (!update) return false;
  const su = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const meta = (params._meta && typeof params._meta === 'object') ? (params._meta as Record<string, unknown>) : {};

  const snap = state.snapshot;
  const scratch = scratchOf(state);
  const ts = tsFrom(o.timestamp);
  let changed = false;

  // One-time: pull the model from the sibling summary.json (the stream doesn't
  // carry it reliably). Guarded by a scratch flag so it's a single file read.
  if (!scratch.modelChecked) {
    scratch.modelChecked = true;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(path.dirname(snap.path), 'summary.json'), 'utf8'));
      const m = info?.current_model_id ?? info?.info?.current_model_id;
      if (typeof m === 'string' && m) { snap.model = m; changed = true; }
    } catch { /* no summary yet */ }
  }

  // Cumulative context tokens. Limit is unknown from the stream, so mirror the
  // Claude heuristic: bump to 1M once we cross 200k, else assume 256k.
  const tt = Number(meta.totalTokens || 0);
  if (tt > 0 && tt !== snap.currentContextTokens) {
    snap.currentContextTokens = tt;
    if (tt > snap.maxContextSeen) snap.maxContextSeen = tt;
    snap.currentContextLimit = snap.maxContextSeen > 200_000 ? 1_000_000 : 256_000;
    changed = true;
  }

  const promptId = typeof meta.promptId === 'string' ? meta.promptId : undefined;

  if (su === 'user_message_chunk' || su === 'agent_message_chunk') {
    const role: 'user' | 'assistant' = su === 'user_message_chunk' ? 'user' : 'assistant';
    const content = update.content;
    const text = (content && typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string')
      ? (content as Record<string, string>).text
      : (typeof content === 'string' ? content : '');
    if (!text) return changed;

    // First chunk of a message = role switched or a new promptId. Count it once
    // and reset that role's accumulation buffer.
    const newMsg = scratch.curRole !== role || (!!promptId && promptId !== scratch.curPromptId);
    if (newMsg) {
      scratch.curRole = role;
      scratch.curPromptId = promptId;
      if (role === 'user') scratch.userBuf = ''; else scratch.asstBuf = '';
      snap.messageCount++;
    }
    if (role === 'user') {
      scratch.userBuf = (scratch.userBuf || '') + text;
      snap.lastUserMessage = compactPreview(scratch.userBuf);
      if (ts) snap.lastUserMessageAt = ts;
    } else {
      scratch.asstBuf = (scratch.asstBuf || '') + text;
      snap.lastAssistantMessage = compactPreview(scratch.asstBuf);
      if (ts) snap.lastAssistantMessageAt = ts;
    }
    return true;
  }

  if (su === 'tool_call') {
    snap.currentToolName = typeof update.title === 'string' && update.title ? update.title : 'tool';
    snap.currentToolInput = previewToolInput(update.rawInput);
    return true;
  }

  if (su === 'tool_call_update') {
    const status = typeof update.status === 'string' ? update.status : '';
    if ((status === 'completed' || status === 'failed' || status === 'cancelled') && snap.currentToolName) {
      snap.currentToolName = undefined;
      snap.currentToolInput = undefined;
      return true;
    }
    return changed;
  }

  return changed;
}

// ───────────────────────────── summary reader ─────────────────────────────

export interface GrokTranscriptSummary {
  cwd?: string;
  firstUserMessage?: string;
  lineCount?: number;
  byteSize?: number;
  mtimeMs?: number;
}

/** Read picker/ranking fields for a Grok session. `transcriptPath` points at the
 *  session's `updates.jsonl`; the cwd + a human title come from the sibling
 *  `summary.json`, and byteSize/mtime from the stream file itself. */
export function readGrokTranscriptSummary(transcriptPath: string): GrokTranscriptSummary | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(transcriptPath); }
  catch { return undefined; }
  let cwd: string | undefined;
  let title: string | undefined;
  let msgs: number | undefined;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(path.dirname(transcriptPath), 'summary.json'), 'utf8'));
    cwd = typeof info?.info?.cwd === 'string' ? info.info.cwd : undefined;
    const t = info?.session_summary ?? info?.generated_title;
    title = typeof t === 'string' ? t : undefined;
    msgs = typeof info?.num_chat_messages === 'number' ? info.num_chat_messages : undefined;
  } catch { /* no summary */ }
  return {
    cwd,
    firstUserMessage: title ? compactPreview(title, 200) : undefined,
    lineCount: msgs,
    byteSize: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Recorded cwd for a Grok session, from the sibling summary.json. */
export function readGrokTranscriptCwd(transcriptPath: string): string | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(path.dirname(transcriptPath), 'summary.json'), 'utf8'));
    const cwd = info?.info?.cwd;
    return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
  } catch {
    return undefined;
  }
}
