import * as fs from 'fs';
import type { TranscriptTailState } from '../types';

// ───────────────────────── Antigravity (agy) transcript ─────────────────────────
//
// agy writes a readable, append-only event log per conversation at
//   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
// One JSON object per line. Confirmed field shape (agy 1.0.6, this machine):
//
//   { step_index, source, type, status, created_at, content?, thinking?, tool_calls?[] }
//
//   source: "USER_EXPLICIT" | "MODEL" | "SYSTEM"
//   type:   "USER_INPUT" | "PLANNER_RESPONSE" | "CONVERSATION_HISTORY"
//           | "VIEW_FILE" | "RUN_COMMAND" | "CODE_ACTION" | "ERROR_MESSAGE" | …
//   content: string (USER_INPUT is wrapped in <USER_REQUEST>…</USER_REQUEST>;
//            tool-echo events like VIEW_FILE/RUN_COMMAND carry a result blob)
//   tool_calls: [{ name, args: { toolAction, toolSummary, AbsolutePath|CommandLine|… } }]
//
// Token / context usage is NOT in this transcript — it arrives via the agy
// `statusLine` payload, handled at the tracker level. Here we only populate
// messages, the current tool, and the model (when discoverable).

interface AgyEvent {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
}

interface AgyToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

/** Default context window for Gemini-class models when statusLine hasn't yet
 *  reported a real number. */
const AGY_DEFAULT_CONTEXT_LIMIT = 1_000_000;

const PREVIEW_MAX = 120;

function compactPreview(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX) return collapsed;
  return collapsed.slice(0, PREVIEW_MAX - 3) + '...';
}

/**
 * USER_INPUT content is wrapped by agy in pseudo-XML envelopes:
 *   <USER_REQUEST>…</USER_REQUEST><ADDITIONAL_METADATA>…</ADDITIONAL_METADATA>…
 * Extract the human request and drop the metadata/settings noise. Falls back to
 * the raw (collapsed) string when the wrapper isn't present.
 */
function unwrapUserRequest(raw: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw);
  if (m && typeof m[1] === 'string') return m[1];
  return raw;
}

/** Coerce a possibly-structured `content` field into a string preview. */
function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    // Be defensive about shape drift: accept {text} / {content} / {message}.
    for (const k of ['text', 'content', 'message', 'value']) {
      const v = c[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  return undefined;
}

/** Pull a short, human-meaningful preview out of a tool_call's args. agy stores
 *  `toolAction`/`toolSummary` (often JSON-string-quoted) plus tool-specific
 *  fields like AbsolutePath / CommandLine / Query. */
function toolInputPreview(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const order = [
    'toolAction',
    'toolSummary',
    'CommandLine',
    'AbsolutePath',
    'TargetFile',
    'DirectoryPath',
    'Query',
    'query',
    'SearchPath',
    'Description',
    'Prompt',
  ];
  for (const k of order) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) {
      // agy frequently stores these already JSON-encoded ("\"foo\"") — unquote.
      let s = v.trim();
      if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        try { s = JSON.parse(s); } catch { /* leave as-is */ }
      }
      if (typeof s === 'string' && s.trim()) return compactPreview(s);
    }
  }
  return '';
}

function firstToolCall(toolCalls: unknown): AgyToolCall | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const tc = toolCalls[0];
  if (tc && typeof tc === 'object') return tc as AgyToolCall;
  return undefined;
}

/**
 * Reduce one agy transcript line into the mutable tail state. Returns true when
 * the snapshot changed. Populates the SAME TranscriptSnapshot fields the Claude
 * reducer does: lastUserMessage(At), lastAssistantMessage(At), messageCount,
 * currentToolName/Input, model, currentContextLimit. Token counts are left to
 * the statusLine path. `subagents` stays untouched ([]).
 */
export function reduceAgyTranscriptLine(state: TranscriptTailState, line: string): boolean {
  let evt: AgyEvent;
  try { evt = JSON.parse(line) as AgyEvent; }
  catch { return false; }
  if (!evt || typeof evt !== 'object') return false;

  const snap = state.snapshot;
  const source = typeof evt.source === 'string' ? evt.source : '';
  const type = typeof evt.type === 'string' ? evt.type : '';
  const status = typeof evt.status === 'string' ? evt.status : '';
  const at = typeof evt.created_at === 'string' ? new Date(evt.created_at) : undefined;
  const validAt = at && !isNaN(at.getTime()) ? at : undefined;

  // Seed a sane default context window once; the statusLine path overrides with
  // real numbers later. (Avoid clobbering a value statusLine may have set.)
  if (!snap.currentContextLimit || snap.currentContextLimit === 200_000) {
    snap.currentContextLimit = AGY_DEFAULT_CONTEXT_LIMIT;
  }

  let changed = false;

  // ── user prompt ────────────────────────────────────────────────────────
  if (source === 'USER_EXPLICIT' && type === 'USER_INPUT') {
    const text = contentToText(evt.content);
    if (text) {
      const preview = compactPreview(unwrapUserRequest(text));
      if (preview) {
        snap.lastUserMessage = preview;
        if (validAt) snap.lastUserMessageAt = validAt;
        snap.messageCount++;
        changed = true;
      }
    }
    return changed;
  }

  // ── model turn (planner) ───────────────────────────────────────────────
  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    // A planner turn may narrate, finalize an answer, and/or kick off a tool.
    const tc = firstToolCall(evt.tool_calls);
    if (tc && typeof tc.name === 'string' && tc.name) {
      snap.currentToolName = tc.name;
      snap.currentToolInput = toolInputPreview(tc.args) || undefined;
      changed = true;
    } else if (status === 'DONE' && snap.currentToolName) {
      // Planner turn with no tool → the previous tool run is over (idle/answer).
      snap.currentToolName = undefined;
      snap.currentToolInput = undefined;
      changed = true;
    }

    const text = contentToText(evt.content);
    if (text && text.trim()) {
      snap.lastAssistantMessage = compactPreview(text);
      if (validAt) snap.lastAssistantMessageAt = validAt;
      snap.messageCount++;
      changed = true;
    }
    return changed;
  }

  return changed;
}

// ───────────────────────── summary (resume picker) ─────────────────────────

export interface AgyTranscriptSummary {
  cwd?: string;
  firstUserMessage?: string;
  lineCount?: number;
  byteSize?: number;
  mtimeMs?: number;
}

/**
 * Lightweight one-pass summary of an agy transcript for the manual-resume
 * picker: first user prompt (preview), line count, size, mtime. The transcript
 * itself doesn't embed an absolute cwd, so `cwd` is left undefined here — the
 * provider resolves it from `cache/last_conversations.json` instead.
 */
export function readAgyTranscriptSummary(transcriptPath: string): AgyTranscriptSummary | undefined {
  try {
    const stat = fs.statSync(transcriptPath);
    const buf = fs.readFileSync(transcriptPath, 'utf8');
    let firstUser: string | undefined;
    let lineCount = 0;
    let cursor = 0;
    while (cursor < buf.length) {
      const next = buf.indexOf('\n', cursor);
      const end = next < 0 ? buf.length : next;
      const line = buf.slice(cursor, end);
      if (line.length > 0) {
        lineCount++;
        if (!firstUser && lineCount <= 200 && line[0] === '{') {
          try {
            const o = JSON.parse(line) as AgyEvent;
            if (o.type === 'USER_INPUT') {
              const text = contentToText(o.content);
              if (text) firstUser = compactPreview(unwrapUserRequest(text)).slice(0, 200);
            }
          } catch { /* malformed line */ }
        }
      }
      if (next < 0) break;
      cursor = next + 1;
    }
    return {
      firstUserMessage: firstUser,
      lineCount,
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}
