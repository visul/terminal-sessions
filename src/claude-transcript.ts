import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { costForUsage } from './claude-pricing';

export type SubagentState = 'working' | 'tool' | 'done';

export interface SubagentSnapshot {
  /** tool_use id of the `Task` call that spawned this subagent (stable key). */
  id: string;
  /** Parent subagent id (another Task tool_use id), or `undefined` when this
   *  subagent was spawned from the main conversation thread. */
  parentId?: string;
  /** Depth in the subagent tree (0 = direct child of main thread). */
  depth: number;
  /** `subagent_type` field from the Task tool input (e.g. "code-reviewer"). */
  agentType?: string;
  /** `description` field from the Task tool input (short label). */
  description?: string;
  /** Name of the tool currently executing inside this subagent (Bash, Grep…). */
  currentTool?: string;
  currentToolInput?: string;
  toolSince?: Date;
  lastMessage?: string;
  state: SubagentState;
  startedAt: Date;
  completedAt?: Date;
  /** Byte offset of the line where this subagent's first entry appears in
   *  the transcript, used by the "Open transcript" command to jump precisely. */
  firstOffset?: number;
}

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
  /** Flat list of subagents (Task tool_use spawns) seen in this transcript.
   *  Ordered by first appearance. Tree is computed by callers from parentId. */
  subagents: SubagentSnapshot[];
}

interface MsgInfo {
  /** Subagent id this message belongs to (undefined = main thread). */
  belongsTo?: string;
  /** Task tool_use ids spawned by this message (usually 0 or 1). */
  spawnedTasks: string[];
}

interface TailState {
  snapshot: TranscriptSnapshot;
  offset: number;
  watcher?: fs.FSWatcher;
  pendingToolUseIds: Set<string>;
  /** message.id values we've already billed for, to de-duplicate retried turns. */
  seenMessageIds: Set<string>;
  /** Per-subagent mutable state (same items as snapshot.subagents, indexed). */
  subagentMap: Map<string, SubagentSnapshot>;
  /** msg.uuid → parent lookup so we can attribute sidechain activity. */
  msgInfo: Map<string, MsgInfo>;
  /** Byte offset at the start of the current line being parsed (for
   *  firstOffset bookmarking). */
  currentLineStart: number;
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
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // fs.watch follows only the main transcript file, but background-agent
    // transcripts live in a sibling directory that we need to re-scan
    // periodically. A 3-second interval is imperceptible to the user and
    // cheap (readdir + statSync per tracked session).
    this.pollTimer = setInterval(() => this.pollAll(), 3_000);
  }

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
        subagents: [],
      },
      offset: 0,
      pendingToolUseIds: new Set(),
      seenMessageIds: new Set(),
      subagentMap: new Map(),
      msgInfo: new Map(),
      currentLineStart: 0,
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
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    for (const sessionId of Array.from(this.tails.keys())) this.stopOne(sessionId);
    this.listeners = [];
  }

  private readDelta(sessionId: string): void {
    const state = this.tails.get(sessionId);
    if (!state) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(state.snapshot.path); }
    catch { return; }
    // Even when the main jsonl is unchanged, a background-agent file may
    // have been updated — re-scan the subagents dir as a cheap periodic tick.
    if (stat.size === state.offset) {
      const before = state.subagentMap.size;
      const mapChanged = scanBackgroundAgents(state);
      if (mapChanged || state.subagentMap.size !== before) {
        state.snapshot.subagents = Array.from(state.subagentMap.values());
        for (const cb of this.listeners) cb(sessionId, state.snapshot);
      }
      return;
    }
    if (stat.size < state.offset) state.offset = 0;
    const bytes = stat.size - state.offset;
    let buf: Buffer;
    try {
      const fd = fs.openSync(state.snapshot.path, 'r');
      buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, state.offset);
      fs.closeSync(fd);
    } catch { return; }
    const startOffset = state.offset;
    state.offset = stat.size;
    const text = buf.toString('utf8');
    // Track each line's byte offset in the file so new subagents can bookmark
    // their firstOffset for "Open transcript at subagent" to jump precisely.
    let cursor = startOffset;
    let changed = false;
    for (const line of text.split('\n')) {
      if (line.length === 0) { cursor += 1; continue; } // eaten newline
      state.currentLineStart = cursor;
      if (this.applyLine(state, line)) changed = true;
      cursor += Buffer.byteLength(line, 'utf8') + 1; // +1 for the \n
    }

    // Claude Code ≥ 2.1.119 spawns background agents via the `Agent` tool
    // with `run_in_background: true`. Each background agent writes its own
    // transcript into `<sessionFile>/subagents/agent-<agentId>.jsonl` plus
    // a `.meta.json`. These are NOT sidechain messages in the main jsonl,
    // so the per-line parser above misses them. Merge them in now.
    const beforeBg = state.subagentMap.size;
    if (scanBackgroundAgents(state)) changed = true;
    if (state.subagentMap.size !== beforeBg) changed = true;

    if (changed) {
      // Rebuild the flat subagents list in insertion order from the map so
      // consumers get a stable snapshot (the map preserves insertion order in
      // modern V8 but we want an explicit array for easy serialization).
      state.snapshot.subagents = Array.from(state.subagentMap.values());
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
    const isSidechain = evt.isSidechain === true;

    // Resolve this message's owning subagent by walking the parent uuid chain.
    // A sidechain message inherits its parent's subagent; if the parent spawned
    // a new Task, this message is the first of that new subagent's chain.
    const uuid = typeof evt.uuid === 'string' ? evt.uuid : undefined;
    const parentUuid = typeof evt.parentUuid === 'string' ? evt.parentUuid : undefined;
    let belongsTo: string | undefined;
    if (isSidechain && parentUuid) {
      const parentInfo = state.msgInfo.get(parentUuid);
      if (parentInfo) {
        // Unresolved spawned Task from the parent → that's our owner. Fall
        // back to the parent's own belongsTo for deep sidechain messages.
        const unresolved = parentInfo.spawnedTasks.find(
          (tid) => state.subagentMap.get(tid)?.state !== 'done',
        );
        belongsTo = unresolved ?? parentInfo.belongsTo;
      }
    }
    const spawnedTasks: string[] = [];

    if (type === 'user' && msg.role === 'user') {
      if (uuid) state.msgInfo.set(uuid, { belongsTo, spawnedTasks });
      // tool_result blocks can resolve a subagent's Task call, marking it done.
      updateSubagentsFromToolResults(msg.content, state, ts, belongsTo);
      const preview = extractText(msg.content);
      if (preview) {
        if (belongsTo) {
          const sa = state.subagentMap.get(belongsTo);
          if (sa) sa.lastMessage = preview;
          return true;
        }
        snap.lastUserMessage = preview;
        if (ts) snap.lastUserMessageAt = ts;
        snap.messageCount++;
        return true;
      }
      // tool_result — clear pending tool use (best effort, main thread only)
      if (!belongsTo) {
        extractToolUseIds(msg.content, state.pendingToolUseIds, 'remove');
        if (state.pendingToolUseIds.size === 0 && snap.currentToolName) {
          snap.currentToolName = undefined;
          snap.currentToolInput = undefined;
          return true;
        }
      }
      return false;
    }

    // assistant
    if (typeof msg.model === 'string') snap.model = msg.model;

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

    // Scan assistant content for Task spawns (new subagents) and regular
    // tool uses (inside a subagent → update its currentTool).
    scanAssistantContent(msg.content, state, ts, belongsTo, spawnedTasks);

    const preview = extractText(msg.content);
    if (preview) {
      if (belongsTo) {
        const sa = state.subagentMap.get(belongsTo);
        if (sa) sa.lastMessage = preview;
      } else {
        snap.lastAssistantMessage = preview;
        if (ts) snap.lastAssistantMessageAt = ts;
        snap.messageCount++;
      }
    }
    // Track any new tool_use blocks on the MAIN thread only; sidechain tool
    // uses are already handled per-subagent by scanAssistantContent.
    if (!isSidechain) {
      extractToolUseIds(msg.content, state.pendingToolUseIds, 'add');
      const firstTool = firstToolUse(msg.content);
      if (firstTool) {
        snap.currentToolName = firstTool.name;
        snap.currentToolInput = firstTool.preview;
      }
    }

    if (uuid) state.msgInfo.set(uuid, { belongsTo, spawnedTasks });
    return true;
  }
}

/**
 * Scan `<sessionFile>/subagents/` for background-agent transcripts written by
 * Claude Code ≥ 2.1.119. Each agent is a file pair:
 *     agent-<id>.jsonl       — normal user/assistant entries, with `agentId`
 *     agent-<id>.meta.json   — { agentType, description }
 *
 * We read each file to infer:
 *   state         — 'working' / 'tool' / 'done' (mtime-based + last tool_use)
 *   currentTool   — name+input of the last unresolved tool_use
 *   lastMessage   — last assistant text preview
 *
 * Returns true if any subagent entry was added or updated.
 */
function scanBackgroundAgents(state: TailState): boolean {
  const dir = `${state.snapshot.path}`.replace(/\.jsonl$/, '') + '/subagents';
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return false; }

  let changed = false;
  const nowMs = Date.now();
  const DONE_AFTER_MS = 30_000; // no writes for 30s → agent is done
  const seen = new Set<string>();

  for (const entry of entries) {
    const m = /^agent-([0-9a-zA-Z]+)\.jsonl$/.exec(entry);
    if (!m) continue;
    const agentId = m[1];
    seen.add(agentId);
    const jsonlPath = `${dir}/${entry}`;
    const metaPath = `${dir}/agent-${agentId}.meta.json`;

    let stat: fs.Stats;
    try { stat = fs.statSync(jsonlPath); } catch { continue; }

    // Read meta once per agent (cheap, tiny files).
    let agentType: string | undefined;
    let description: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      agentType = typeof meta.agentType === 'string' ? meta.agentType : undefined;
      description = typeof meta.description === 'string' ? meta.description : undefined;
    } catch { /* no meta yet — fall back to undefined */ }

    // Walk the whole agent file to find the last text and outstanding tool.
    // Background-agent jsonls are typically 50-200KB and read fast.
    let lastText = '';
    let lastToolName: string | undefined;
    let lastToolInput: string | undefined;
    let pendingToolId: string | undefined;
    try {
      const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line); } catch { continue; }
        const msg = (e.message as { role?: string; content?: unknown }) || {};
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              const t = (b.text as string).trim();
              if (t) lastText = t;
            } else if (b.type === 'tool_use') {
              const name = typeof b.name === 'string' ? (b.name as string) : '';
              const id = typeof b.id === 'string' ? (b.id as string) : undefined;
              const input = (b.input as Record<string, unknown>) || {};
              let preview = '';
              for (const k of ['command', 'file_path', 'pattern', 'description', 'query', 'url']) {
                const v = input[k];
                if (typeof v === 'string' && v) { preview = compactPreview(v); break; }
              }
              lastToolName = name;
              lastToolInput = preview;
              pendingToolId = id;
            } else if (b.type === 'tool_result') {
              if (pendingToolId && b.tool_use_id === pendingToolId) {
                pendingToolId = undefined; // resolved
              }
            }
          }
        }
      }
    } catch { continue; }

    const ageMs = nowMs - stat.mtimeMs;
    const isDone = ageMs > DONE_AFTER_MS;
    const newState: SubagentState = isDone
      ? 'done'
      : pendingToolId
        ? 'tool'
        : 'working';

    const existing = state.subagentMap.get(agentId);
    const snap: SubagentSnapshot = {
      id: agentId,
      parentId: undefined,
      depth: 0,
      agentType,
      description: description ? compactPreview(description) : undefined,
      currentTool: newState === 'done' ? undefined : lastToolName,
      currentToolInput: newState === 'done' ? undefined : lastToolInput,
      lastMessage: lastText ? compactPreview(lastText) : undefined,
      state: newState,
      startedAt: existing?.startedAt || new Date(stat.birthtimeMs || stat.mtimeMs),
      completedAt: newState === 'done'
        ? (existing?.completedAt || new Date(stat.mtimeMs))
        : undefined,
      firstOffset: undefined,
    };

    // Detect meaningful change to avoid unnecessary sidebar refreshes.
    if (!existing
        || existing.state !== snap.state
        || existing.currentTool !== snap.currentTool
        || existing.lastMessage !== snap.lastMessage
        || existing.agentType !== snap.agentType
        || existing.description !== snap.description) {
      state.subagentMap.set(agentId, snap);
      changed = true;
    }
  }

  // Drop background-agent entries whose file no longer exists (unlikely but
  // handles manual cleanup). Task-spawned subagents (have parentId potentially
  // and a different id shape) are left alone.
  for (const id of Array.from(state.subagentMap.keys())) {
    const existing = state.subagentMap.get(id);
    if (!existing) continue;
    // Heuristic: background agent ids look like `aXXXXXXXXXXXXXXX` (17 alnum
    // chars), while Task tool_use ids start with `toolu_`. Only prune the
    // background-agent shape.
    if (/^a[0-9a-f]{16}$/i.test(id) && !seen.has(id)) {
      state.subagentMap.delete(id);
      changed = true;
    }
  }

  return changed;
}

/**
 * Walk the assistant content blocks, looking for:
 *   - `tool_use { name: "Task" }` → a new subagent spawn
 *   - other `tool_use` blocks → the subagent (or main thread) started a tool
 *   - `tool_result` blocks are handled by the user-role branch (above)
 *
 * `spawnedTasks` is appended in place so the caller can record the mapping
 * from this message's uuid to the Task ids it produced.
 */
function scanAssistantContent(
  content: unknown,
  state: TailState,
  ts: Date | undefined,
  belongsTo: string | undefined,
  spawnedTasks: string[],
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '';
    const id = typeof b.id === 'string' ? b.id : undefined;
    if (!id) continue;
    if (name === 'Task') {
      // New subagent — register it.
      const input = (b.input as Record<string, unknown>) || {};
      const existing = state.subagentMap.get(id);
      if (!existing) {
        // Count depth by walking parent chain.
        let depth = 0;
        let p = belongsTo;
        while (p) {
          const parentSub = state.subagentMap.get(p);
          if (!parentSub) break;
          depth++;
          p = parentSub.parentId;
        }
        const snap: SubagentSnapshot = {
          id,
          parentId: belongsTo,
          depth,
          agentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          description: typeof input.description === 'string' ? compactPreview(input.description) : undefined,
          state: 'working',
          startedAt: ts || new Date(),
          firstOffset: state.currentLineStart,
        };
        state.subagentMap.set(id, snap);
      }
      spawnedTasks.push(id);
    } else if (belongsTo) {
      // Non-Task tool use inside a subagent → update its current tool.
      const sa = state.subagentMap.get(belongsTo);
      if (sa) {
        const input = (b.input as Record<string, unknown>) || {};
        let preview = '';
        for (const k of ['command', 'file_path', 'pattern', 'description', 'query', 'url']) {
          const v = input[k];
          if (typeof v === 'string' && v) { preview = compactPreview(v); break; }
        }
        sa.currentTool = name;
        sa.currentToolInput = preview;
        sa.toolSince = ts || new Date();
        sa.state = 'tool';
      }
    }
  }
}

/**
 * When a user-role message arrives with tool_result blocks, check each
 * `tool_use_id` against our subagent registry. A matching id means the
 * corresponding Task tool call has returned, so the subagent is done.
 * For non-Task tool_results inside a subagent, reset its tool state.
 */
function updateSubagentsFromToolResults(
  content: unknown,
  state: TailState,
  ts: Date | undefined,
  belongsTo: string | undefined,
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
    if (!toolUseId) continue;
    const sub = state.subagentMap.get(toolUseId);
    if (sub) {
      // Task result → subagent completed.
      sub.state = 'done';
      sub.completedAt = ts || new Date();
      sub.currentTool = undefined;
      sub.currentToolInput = undefined;
      sub.toolSince = undefined;
      continue;
    }
    // Non-Task tool result inside a subagent → between tool runs, go back to
    // 'working' so the spinner no longer claims a finished tool is active.
    if (belongsTo) {
      const sa = state.subagentMap.get(belongsTo);
      if (sa && sa.state === 'tool') {
        sa.state = 'working';
        sa.currentTool = undefined;
        sa.currentToolInput = undefined;
        sa.toolSince = undefined;
      }
    }
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
