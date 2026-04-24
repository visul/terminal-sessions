import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { costForUsage } from './claude-pricing';

export interface TranscriptSnapshot {
  sessionId: string;
  path: string;
  model?: string;
  lastUserMessage?: string;
  lastUserMessageAt?: Date;
  lastAssistantMessage?: string;
  lastAssistantMessageAt?: Date;
  currentToolName?: string;
  currentToolInput?: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate5m: number;
    cacheCreate1h: number;
  };
  messageCount: number;
  /** Real per-session API cost in USD, computed with the live Anthropic rate
   *  card (see claude-pricing.ts). Includes cache reads (billed at 0.1x).
   *  Deduplicated by `message.id` to avoid double-counting retried turns. */
  cost: number;
  costByModel: Record<string, number>;
  currentContextTokens: number;
  currentContextLimit: number;
  maxContextSeen: number;
}

interface TailState {
  snapshot: TranscriptSnapshot;
  offset: number;
  watcher?: fs.FSWatcher;
  pendingToolUseIds: Set<string>;
  /** message.id values we've already billed for, to de-duplicate retried turns. */
  seenMessageIds: Set<string>;
}

/** Convert `/a/b/c` to `-a-b-c` (Claude Code's project-slug convention). */
export function slugFromCwd(cwd: string): string {
  if (!cwd) return '';
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

export function transcriptPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', slugFromCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Tails one or more Claude transcript .jsonl files and maintains a snapshot
 * of the most recent state per session. Emits change events when a snapshot
 * is updated so the sidebar can refresh.
 */
export class TranscriptTailer {
  private tails = new Map<string, TailState>(); // keyed by sessionId
  private listeners: Array<(sessionId: string, snap: TranscriptSnapshot) => void> = [];

  onChange(cb: (sessionId: string, snap: TranscriptSnapshot) => void): void {
    this.listeners.push(cb);
  }

  getSnapshot(sessionId: string): TranscriptSnapshot | undefined {
    return this.tails.get(sessionId)?.snapshot;
  }

  /** Start tailing the transcript for a session. Idempotent. */
  start(sessionId: string, filePath: string): void {
    if (!sessionId || !filePath) return;
    const existing = this.tails.get(sessionId);
    if (existing && existing.snapshot.path === filePath) return;
    if (existing) this.stopOne(sessionId);

    const state: TailState = {
      snapshot: {
        sessionId,
        path: filePath,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
        messageCount: 0,
        cost: 0,
        costByModel: {},
        currentContextTokens: 0,
        currentContextLimit: 200_000,
        maxContextSeen: 0,
      },
      offset: 0,
      pendingToolUseIds: new Set(),
      seenMessageIds: new Set(),
    };
    this.tails.set(sessionId, state);
    this.readDelta(sessionId);
    try {
      state.watcher = fs.watch(filePath, { persistent: false }, () => {
        this.readDelta(sessionId);
      });
    } catch {
      // File may not exist yet; retry on next poll call
    }
  }

  /** Poll all tracked transcripts (cheap safety net for platforms where
   *  fs.watch misses events). */
  pollAll(): void {
    for (const sessionId of this.tails.keys()) this.readDelta(sessionId);
  }

  stopOne(sessionId: string): void {
    const state = this.tails.get(sessionId);
    if (!state) return;
    try { state.watcher?.close(); } catch { /* noop */ }
    this.tails.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of Array.from(this.tails.keys())) this.stopOne(sessionId);
    this.listeners = [];
  }

  private readDelta(sessionId: string): void {
    const state = this.tails.get(sessionId);
    if (!state) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(state.snapshot.path); }
    catch { return; }
    if (stat.size === state.offset) return;
    if (stat.size < state.offset) state.offset = 0;
    const bytes = stat.size - state.offset;
    let buf: Buffer;
    try {
      const fd = fs.openSync(state.snapshot.path, 'r');
      buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, state.offset);
      fs.closeSync(fd);
    } catch { return; }
    state.offset = stat.size;
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    let changed = false;
    for (const line of lines) {
      if (this.applyLine(state, line)) changed = true;
    }
    if (changed) {
      for (const cb of this.listeners) cb(sessionId, state.snapshot);
    }
  }

  private applyLine(state: TailState, line: string): boolean {
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line); }
    catch { return false; }
    const type = typeof evt.type === 'string' ? evt.type : '';
    if (type !== 'user' && type !== 'assistant') return false;

    const msg = evt.message as {
      role?: string;
      content?: unknown;
      model?: string;
      usage?: Record<string, number>;
    } | undefined;
    if (!msg) return false;

    const snap = state.snapshot;
    const ts = typeof evt.timestamp === 'string' ? new Date(evt.timestamp) : undefined;

    if (type === 'user' && msg.role === 'user') {
      const preview = extractText(msg.content);
      if (preview) {
        snap.lastUserMessage = preview;
        if (ts) snap.lastUserMessageAt = ts;
        snap.messageCount++;
        return true;
      }
      // tool_result — clear pending tool use (best effort)
      extractToolUseIds(msg.content, state.pendingToolUseIds, 'remove');
      if (state.pendingToolUseIds.size === 0 && snap.currentToolName) {
        snap.currentToolName = undefined;
        snap.currentToolInput = undefined;
        return true;
      }
      return false;
    }

    // assistant
    if (typeof msg.model === 'string') snap.model = msg.model;
    const isSidechain = evt.isSidechain === true;

    // Dedup by message.id so retried API calls (same response written multiple
    // times to the transcript) are billed once.
    const msgObj = msg as unknown as { id?: string };
    const msgId = typeof msgObj.id === 'string' ? msgObj.id : undefined;
    const alreadyBilled = msgId ? state.seenMessageIds.has(msgId) : false;
    if (msgId) state.seenMessageIds.add(msgId);

    if (msg.usage && !alreadyBilled) {
      const rawCC = Number(msg.usage.cache_creation_input_tokens || 0);
      const ccNested = (msg.usage as unknown as {
        cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      }).cache_creation;
      let cc5m = 0, cc1h = 0;
      if (ccNested && (ccNested.ephemeral_5m_input_tokens || ccNested.ephemeral_1h_input_tokens)) {
        cc5m = Number(ccNested.ephemeral_5m_input_tokens || 0);
        cc1h = Number(ccNested.ephemeral_1h_input_tokens || 0);
      } else {
        // Fallback: no breakdown → assume the cheaper 5m rate (matches Claude
        // Code behavior for short-lived cached blocks).
        cc5m = rawCC;
      }
      const u = {
        input: Number(msg.usage.input_tokens || 0),
        output: Number(msg.usage.output_tokens || 0),
        cacheRead: Number(msg.usage.cache_read_input_tokens || 0),
        cacheCreate5m: cc5m,
        cacheCreate1h: cc1h,
      };
      snap.tokens.input += u.input;
      snap.tokens.output += u.output;
      snap.tokens.cacheRead += u.cacheRead;
      snap.tokens.cacheCreate5m += u.cacheCreate5m;
      snap.tokens.cacheCreate1h += u.cacheCreate1h;
      const model = typeof msg.model === 'string' ? msg.model : 'unknown';
      const cost = costForUsage(model, u);
      snap.cost += cost;
      snap.costByModel[model] = (snap.costByModel[model] || 0) + cost;
    }

    if (!isSidechain && msg.usage) {
      const ctx = Number(msg.usage.input_tokens || 0)
        + Number(msg.usage.cache_read_input_tokens || 0)
        + Number(msg.usage.cache_creation_input_tokens || 0);
      snap.currentContextTokens = ctx;
      if (ctx > snap.maxContextSeen) snap.maxContextSeen = ctx;
      // Context window inference:
      //   (1) If we've directly observed a single turn > 200k tokens, we know
      //       the session is running with the 1M-context beta header.
      //   (2) Otherwise fall back to the model's STANDARD window. Opus and
      //       Sonnet 4.5+ default to 1M with Claude Code Pro/Max (matches
      //       what Claude's own status bar reports); older models stay 200k.
      // Previously we only used (1), which overstated ctx % for fresh Opus
      // sessions that hadn't yet crossed 200k in any single turn.
      const modelStr = typeof msg.model === 'string' ? msg.model : '';
      const is1MDefault = /claude-(opus|sonnet)-4-[5-9]/i.test(modelStr);
      const fallbackLimit = is1MDefault ? 1_000_000 : 200_000;
      snap.currentContextLimit = snap.maxContextSeen > 200_000 ? 1_000_000 : fallbackLimit;
    }
    const preview = extractText(msg.content);
    if (preview) {
      snap.lastAssistantMessage = preview;
      if (ts) snap.lastAssistantMessageAt = ts;
      snap.messageCount++;
    }
    // Track any new tool_use blocks
    extractToolUseIds(msg.content, state.pendingToolUseIds, 'add');
    const firstTool = firstToolUse(msg.content);
    if (firstTool) {
      snap.currentToolName = firstTool.name;
      snap.currentToolInput = firstTool.preview;
    }
    return true;
  }
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return compactPreview(content);
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  if (texts.length === 0) return undefined;
  return compactPreview(texts.join(' '));
}

function compactPreview(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 120) return collapsed;
  return collapsed.slice(0, 117) + '...';
}

function firstToolUse(content: unknown): { name: string; preview: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '';
    const input = b.input as Record<string, unknown> | undefined;
    let preview = '';
    if (input && typeof input === 'object') {
      for (const k of ['command', 'file_path', 'pattern', 'description', 'query', 'url']) {
        const v = input[k];
        if (typeof v === 'string' && v) { preview = compactPreview(v); break; }
      }
    }
    return { name, preview };
  }
  return undefined;
}

function extractToolUseIds(
  content: unknown,
  set: Set<string>,
  mode: 'add' | 'remove',
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (mode === 'add' && b.type === 'tool_use' && typeof b.id === 'string') {
      set.add(b.id);
    } else if (mode === 'remove' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      set.delete(b.tool_use_id);
    }
  }
}
