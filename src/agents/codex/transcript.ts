import * as fs from 'fs';
import type { TranscriptTailState } from '../types';
import { costForUsageCodex } from './pricing';

// ───────────────────────────── Codex transcript shape ─────────────────────────────
//
// Codex writes a "rollout" JSONL per session to
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<session-uuid>.jsonl
// Every line is `{ "timestamp", "type", "payload" }`. The `type` discriminates:
//
//   session_meta   first line: payload.{id, cwd, cli_version, originator, git}
//   turn_context   payload.{cwd, model, approval_policy, ...}
//   response_item  payload.type ∈ message | reasoning | function_call |
//                  function_call_output
//   event_msg      payload.type ∈ task_started | task_complete | user_message |
//                  agent_message | token_count | turn_aborted | patch_apply_end |
//                  mcp_tool_call_end | web_search_end | context_compacted
//
// This reducer maps those onto the shared TranscriptSnapshot fields the same way
// reduceClaudeTranscriptLine does for Claude. The tracker derives working/idle
// from transcript mtime, so we do NOT set any `state` field here — we only keep
// tokens / messages / tool name / cost fresh.
//
// IMPORTANT differences from Claude's parser:
//   • Tokens come from a dedicated `token_count` event (cumulative + per-turn),
//     not from a per-message `usage` block. `payload.info` can be null (some
//     lines only carry `rate_limits`) — every nested field is guarded.
//   • There are TWO ways a user/assistant message shows up: a `response_item`
//     `message` (with role + structured content) and an `event_msg`
//     (`user_message` / `agent_message`, plain string). We prefer the
//     `response_item` form for messageCount/previews and treat the event_msg
//     form as a fallback so a turn isn't double-counted. We de-dupe via a
//     scratch Set keyed on a cheap content hash.

const DEFAULT_CONTEXT_LIMIT = 256_000;

interface CodexScratch {
  /** call_id of the in-flight function/tool call, so we can clear currentTool
   *  when its matching output/end event arrives. */
  pendingCallId?: string;
  /** Last user/assistant preview we recorded, used to skip the duplicate
   *  event_msg copy of a response_item message (and vice-versa). */
  lastUserPreview?: string;
  lastAssistantPreview?: string;
}

function scratchOf(state: TranscriptTailState): CodexScratch {
  if (!state.scratch) state.scratch = {};
  const s = state.scratch as { codex?: CodexScratch };
  if (!s.codex) s.codex = {};
  return s.codex;
}

/** Collapse whitespace and clip a string to a short preview. */
function compactPreview(s: string, max = 120): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3) + '...';
}

/** Pull display text out of a Codex `message.content`, which is either a plain
 *  string or an array of `{ type, text }` blocks. Codex uses `input_text` for
 *  user/developer content and `output_text` for assistant content; we accept
 *  any `text` field defensively. */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') return compactPreview(content);
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if ((t === 'input_text' || t === 'output_text' || t === 'text') && typeof b.text === 'string') {
      texts.push(b.text);
    }
  }
  if (texts.length === 0) return undefined;
  return compactPreview(texts.join(' '));
}

/** A short label for a function_call's arguments JSON (the command, path or
 *  query inside it) so the sidebar can show "exec_command: sed -n …". */
function previewFunctionArgs(args: unknown): string {
  let obj: Record<string, unknown> | undefined;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) as Record<string, unknown>; }
    catch { return compactPreview(args); }
  } else if (args && typeof args === 'object') {
    obj = args as Record<string, unknown>;
  }
  if (!obj) return '';
  for (const k of ['cmd', 'command', 'path', 'file_path', 'query', 'pattern', 'url', 'workdir']) {
    const v = obj[k];
    if (typeof v === 'string' && v) return compactPreview(v);
  }
  return '';
}

/**
 * Reduce one Codex rollout JSONL line into the tail state. Returns true if the
 * snapshot changed. This is the CodexProvider's `reduceTranscriptLine`.
 */
export function reduceCodexTranscriptLine(state: TranscriptTailState, line: string): boolean {
  let evt: { timestamp?: unknown; type?: unknown; payload?: unknown };
  try { evt = JSON.parse(line); }
  catch { return false; }

  const type = typeof evt.type === 'string' ? evt.type : '';
  const payload = (evt.payload && typeof evt.payload === 'object')
    ? (evt.payload as Record<string, unknown>)
    : undefined;
  if (!payload) return false;

  const snap = state.snapshot;
  const ts = typeof evt.timestamp === 'string' ? new Date(evt.timestamp) : undefined;
  const scratch = scratchOf(state);

  // ── session_meta / turn_context: capture cwd + model ────────────────────
  if (type === 'session_meta' || type === 'turn_context') {
    let changed = false;
    if (typeof payload.model === 'string' && payload.model && snap.model !== payload.model) {
      snap.model = payload.model;
      changed = true;
    }
    return changed;
  }

  // ── response_item: messages, function calls, their outputs ──────────────
  if (type === 'response_item') {
    const pt = typeof payload.type === 'string' ? payload.type : '';

    if (pt === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : '';
      const text = extractMessageText(payload.content);
      if (!text) return false;
      if (role === 'user') {
        // Skip the synthetic environment_context / permissions preamble blocks
        // so the "last user message" reflects an actual human prompt.
        if (/^<(environment_context|permissions)/i.test(text)) return false;
        if (scratch.lastUserPreview === text) return false;
        scratch.lastUserPreview = text;
        snap.lastUserMessage = text;
        if (ts) snap.lastUserMessageAt = ts;
        snap.messageCount++;
        return true;
      }
      if (role === 'assistant') {
        if (scratch.lastAssistantPreview === text) return false;
        scratch.lastAssistantPreview = text;
        snap.lastAssistantMessage = text;
        if (ts) snap.lastAssistantMessageAt = ts;
        snap.messageCount++;
        return true;
      }
      // developer/system/tool roles — ignore for previews.
      return false;
    }

    if (pt === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      scratch.pendingCallId = callId;
      snap.currentToolName = name;
      snap.currentToolInput = previewFunctionArgs(payload.arguments);
      return true;
    }

    if (pt === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      // Clear the in-flight tool when its matching output arrives (or
      // unconditionally if we never recorded a call_id).
      if (!callId || callId === scratch.pendingCallId) {
        scratch.pendingCallId = undefined;
        if (snap.currentToolName) {
          snap.currentToolName = undefined;
          snap.currentToolInput = undefined;
          return true;
        }
      }
      return false;
    }

    return false; // reasoning, etc. — nothing to surface
  }

  // ── event_msg: token usage, lifecycle, tool-end events ──────────────────
  if (type === 'event_msg') {
    const pt = typeof payload.type === 'string' ? payload.type : '';

    if (pt === 'token_count') {
      return applyTokenCount(state, payload);
    }

    // Plain-string fallbacks for user/assistant turns. We only use these when
    // the structured response_item message didn't already record the same text
    // (handles sessions where one form is present but not the other).
    if (pt === 'user_message') {
      const text = typeof payload.message === 'string' ? compactPreview(payload.message) : undefined;
      if (!text || scratch.lastUserPreview === text) return false;
      scratch.lastUserPreview = text;
      snap.lastUserMessage = text;
      if (ts) snap.lastUserMessageAt = ts;
      snap.messageCount++;
      return true;
    }
    if (pt === 'agent_message') {
      const text = typeof payload.message === 'string' ? compactPreview(payload.message) : undefined;
      if (!text || scratch.lastAssistantPreview === text) return false;
      scratch.lastAssistantPreview = text;
      snap.lastAssistantMessage = text;
      if (ts) snap.lastAssistantMessageAt = ts;
      snap.messageCount++;
      return true;
    }

    // Tool-end events surface a tool name and then immediately resolve it. We
    // set currentToolName so a glance shows what just ran; the next turn's
    // task_complete / function_call_output clears it.
    if (pt === 'patch_apply_end') {
      snap.currentToolName = 'patch';
      const changes = payload.changes;
      if (changes && typeof changes === 'object') {
        const files = Object.keys(changes as Record<string, unknown>);
        snap.currentToolInput = files.length ? compactPreview(files.join(', ')) : undefined;
      }
      // Resolved as soon as it ended.
      scratch.pendingCallId = undefined;
      return true;
    }
    if (pt === 'mcp_tool_call_end') {
      const inv = payload.invocation as Record<string, unknown> | undefined;
      const server = inv && typeof inv.server === 'string' ? inv.server : '';
      const tool = inv && typeof inv.tool === 'string' ? inv.tool : 'mcp';
      snap.currentToolName = server ? `${server}.${tool}` : `mcp.${tool}`;
      snap.currentToolInput = undefined;
      return true;
    }
    if (pt === 'web_search_end') {
      snap.currentToolName = 'web_search';
      const q = payload.query;
      snap.currentToolInput = typeof q === 'string' ? compactPreview(q) : undefined;
      return true;
    }

    if (pt === 'task_complete' || pt === 'turn_aborted') {
      // Turn ended — drop any lingering tool indicator.
      scratch.pendingCallId = undefined;
      if (snap.currentToolName) {
        snap.currentToolName = undefined;
        snap.currentToolInput = undefined;
        return true;
      }
      return false;
    }

    if (pt === 'task_started') {
      // New turn boundary — reset the intra-turn preview dedup so a genuinely
      // repeated prompt or answer next turn ("continue" twice) isn't swallowed
      // as a duplicate of the previous turn's text. Both user-message forms are
      // recorded AFTER task_started, so the same-turn dedup still works.
      scratch.lastUserPreview = undefined;
      scratch.lastAssistantPreview = undefined;
      return false;
    }

    // context_compacted, etc. — no snapshot fields to mutate (state is inferred
    // from mtime by the tracker).
    return false;
  }

  return false;
}

/**
 * Apply a `token_count` event. `payload.info` may be null (lines that carry
 * only `rate_limits`), so every field is guarded. We:
 *   • set currentContextTokens from the LATEST turn (`last_token_usage`
 *     input+output) — the cumulative `total_token_usage` sums every turn's input
 *     and so overshoots the context window after a few turns,
 *   • set currentContextLimit from model_context_window (fallback 256k),
 *   • accumulate per-turn input/output from `last_token_usage`,
 *   • map cached_input_tokens → cacheRead,
 *   • bill the per-turn delta via costForUsageCodex.
 */
function applyTokenCount(state: TranscriptTailState, payload: Record<string, unknown>): boolean {
  const info = payload.info;
  if (!info || typeof info !== 'object') return false;
  const i = info as Record<string, unknown>;
  const snap = state.snapshot;

  let changed = false;

  const last = i.last_token_usage as Record<string, unknown> | undefined;

  // Context meter: the LIVE window occupancy is the latest turn's prompt+output,
  // NOT the session-cumulative total. `total_token_usage.total_tokens` sums every
  // turn's input, so it blows past 100% after a few turns. Codex's input_tokens
  // already includes the cached prefix (cached ⊆ input — see pricing.ts), so the
  // current context is input + output of `last_token_usage`.
  if (last && typeof last === 'object') {
    const ctx = Number(last.input_tokens || 0) + Number(last.output_tokens || 0);
    if (ctx > 0) {
      snap.currentContextTokens = ctx;
      if (ctx > snap.maxContextSeen) snap.maxContextSeen = ctx;
      changed = true;
    }
  }

  const window = Number(i.model_context_window || 0);
  const limit = window > 0 ? window : DEFAULT_CONTEXT_LIMIT;
  if (snap.currentContextLimit !== limit) {
    snap.currentContextLimit = limit;
    changed = true;
  }

  // Per-turn delta drives token accumulation + cost. Codex reports this in
  // `last_token_usage`; if absent (rare), skip billing rather than re-counting
  // the cumulative total.
  if (last && typeof last === 'object') {
    const input = Number(last.input_tokens || 0);
    const cached = Number(last.cached_input_tokens || 0);
    const output = Number(last.output_tokens || 0);
    // reasoning_output_tokens are a subset of output billed at the output rate;
    // OpenAI already includes them in output_tokens, so don't add twice.
    if (input || output || cached) {
      snap.tokens.input += input;
      snap.tokens.output += output;
      snap.tokens.cacheRead += cached;
      const cost = costForUsageCodex(snap.model, { input, cachedInput: cached, output });
      const model = snap.model || 'gpt-5';
      snap.cost += cost;
      snap.costByModel[model] = (snap.costByModel[model] || 0) + cost;
      changed = true;
    }
  }

  return changed;
}

// ───────────────────────────── summary reader ─────────────────────────────

export interface CodexTranscriptSummary {
  cwd?: string;
  firstUserMessage?: string;
  lineCount?: number;
  byteSize?: number;
  mtimeMs?: number;
}

/**
 * Read summary fields from a Codex rollout file: the recorded cwd (from
 * session_meta / turn_context), the first real user prompt (preview for the
 * resume picker), byte size and mtime. Reads only a 256KB head window (these
 * rollouts can be hundreds of MB) and parses at most its first 200 lines for
 * cwd/first-user; `lineCount` is a cosmetic estimate from byte size. Returns
 * undefined when the file is unreadable.
 */
export function readCodexTranscriptSummary(transcriptPath: string): CodexTranscriptSummary | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return undefined;
  }

  // cwd + first user prompt live in the first handful of lines, so read only a
  // head window instead of the whole rollout — these files can be hundreds of MB
  // and listSessions() calls this for every recent session on picker open.
  const HEAD_BYTES = 256 * 1024;
  const readLen = Math.min(HEAD_BYTES, stat.size);
  let buf: string;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const b = Buffer.alloc(readLen);
    fs.readSync(fd, b, 0, readLen, 0);
    fs.closeSync(fd);
    buf = b.toString('utf8');
  } catch {
    return undefined;
  }

  const truncated = stat.size > readLen; // last line in the window may be partial
  let cwd: string | undefined;
  let firstUser: string | undefined;
  let headLines = 0;
  let cursor = 0;
  while (cursor < buf.length) {
    const next = buf.indexOf('\n', cursor);
    if (next < 0 && truncated) break; // drop the trailing partial line
    const end = next < 0 ? buf.length : next;
    const line = buf.slice(cursor, end);
    if (line.length > 0) {
      headLines++;
      if (headLines <= 200 && line[0] === '{' && (!cwd || !firstUser)) {
        try {
          const obj = JSON.parse(line) as { type?: unknown; payload?: unknown };
          const payload = (obj.payload && typeof obj.payload === 'object')
            ? (obj.payload as Record<string, unknown>)
            : undefined;
          if (payload) {
            if (!cwd && typeof payload.cwd === 'string' && payload.cwd.startsWith('/')) {
              cwd = payload.cwd;
            }
            if (!firstUser) {
              // event_msg/user_message carries a plain string; response_item
              // message carries structured content.
              if (obj.type === 'event_msg' && payload.type === 'user_message'
                  && typeof payload.message === 'string') {
                const t = payload.message.trim();
                if (t && !/^<(environment_context|permissions)/i.test(t)) firstUser = t;
              } else if (obj.type === 'response_item' && payload.type === 'message'
                  && payload.role === 'user') {
                const t = extractMessageText(payload.content);
                if (t && !/^<(environment_context|permissions)/i.test(t)) firstUser = t;
              }
            }
          }
        } catch { /* malformed line */ }
      }
    }
    if (next < 0) break;
    cursor = next + 1;
  }

  // lineCount is cosmetic; estimate it from byte size when the file exceeds the
  // head window rather than reading the whole file just to count newlines.
  const lineCount = truncated && headLines > 0
    ? Math.round(stat.size / (readLen / headLines))
    : headLines;

  return {
    cwd,
    firstUserMessage: firstUser?.slice(0, 200),
    lineCount,
    byteSize: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Read just the recorded cwd from a rollout file (first session_meta /
 *  turn_context with a `/`-prefixed cwd in the first 100 lines). */
export function readCodexTranscriptCwd(transcriptPath: string): string | undefined {
  try {
    const buf = fs.readFileSync(transcriptPath, 'utf8');
    const lines = buf.split('\n');
    for (let i = 0; i < Math.min(lines.length, 100); i++) {
      const line = lines[i];
      if (!line || line[0] !== '{') continue;
      try {
        const obj = JSON.parse(line) as { payload?: unknown };
        const payload = (obj.payload && typeof obj.payload === 'object')
          ? (obj.payload as Record<string, unknown>)
          : undefined;
        if (payload && typeof payload.cwd === 'string' && payload.cwd.startsWith('/')) {
          return payload.cwd;
        }
      } catch { /* malformed line, keep scanning */ }
    }
  } catch { /* unreadable */ }
  return undefined;
}
