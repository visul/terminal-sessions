// Kill & Delete Data: collect and delete the on-disk artifacts of a session's
// AI conversations (transcripts, sidecar dirs, todos, scratchpads).
//
// SAFETY MODEL — this module deletes user data, so every path must pass ALL of:
//   1. The conversation id is a strict UUID (no separators, no traversal).
//   2. The resolved path is absolute and sits strictly INSIDE an allowed root
//      (the user's home dir or a claude tmp root) — never a root itself.
//   3. The path's basename contains the full conversation id (transcripts,
//      sidecar dirs, todos, scratchpads are all named after it).
//   4. The path exists at plan time and is re-validated at execute time.
// Anything that fails a check is silently left alone — we prefer leaking a
// file over deleting the wrong one.
//
// Kept free of vscode imports so the whole planner/executor runs under the
// plain-node test harness.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionLabel } from './types';
import type { AgentId } from './agents/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrashTarget {
  agent: AgentId;
  conversationId: string;
  /** Absolute, validated, existing paths (files or dirs) belonging to this conversation. */
  paths: string[];
}

export interface TrashSkip {
  agent: AgentId;
  conversationId: string;
  reason: string;
}

export interface TrashPlan {
  targets: TrashTarget[];
  skipped: TrashSkip[];
  totalBytes: number;
  fileCount: number;
}

export interface TrashResult {
  deletedPaths: number;
  freedBytes: number;
  failures: string[];
}

/** Filesystem roots deletion is confined to. Overridable for tests. */
export interface TrashEnv {
  home: string;
  /** Claude Code scratchpad roots, e.g. /private/tmp/claude-501. */
  tmpRoots: string[];
}

export function defaultTrashEnv(): TrashEnv {
  let uid: number | undefined;
  try { uid = process.getuid?.(); } catch { /* windows */ }
  const tmpRoots = uid === undefined ? [] : [
    path.join('/private/tmp', `claude-${uid}`),
    path.join('/tmp', `claude-${uid}`),
  ].filter(p => fs.existsSync(p));
  return { home: os.homedir(), tmpRoots };
}

/** Every (agent, conversationId) pair recorded on a session, deduped.
 *  Merges the legacy Claude-only fields with the agent-tagged history. */
export function collectConversationIds(meta: SessionLabel): { agent: AgentId; id: string }[] {
  const seen = new Set<string>();
  const out: { agent: AgentId; id: string }[] = [];
  const push = (agent: AgentId, id: string | undefined) => {
    if (!id) return;
    const key = `${agent} ${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ agent, id });
  };
  for (const ref of meta.agentSessions ?? []) push(ref.agent, ref.id);
  push('claude', meta.lastClaudeSessionId);
  for (const id of meta.claudeSessionHistory ?? []) push('claude', id);
  return out;
}

/** True when `p` sits strictly inside one of the allowed roots (never equal to
 *  a root) and its basename carries the full conversation id. */
function isDeletable(p: string, conversationId: string, env: TrashEnv): boolean {
  if (!path.isAbsolute(p)) return false;
  const resolved = path.resolve(p);
  const roots = [env.home, ...env.tmpRoots];
  const inside = roots.some(root => {
    const r = path.resolve(root);
    return resolved !== r && resolved.startsWith(r + path.sep);
  });
  if (!inside) return false;
  return path.basename(resolved).includes(conversationId);
}

/** Size of a file, or the recursive size of a dir. Symlinks are counted as the
 *  link itself and never followed — a link out of the root must not pull
 *  foreign files into the plan's byte count (or, worse, its delete list). */
function sizeOf(p: string): { bytes: number; files: number } {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0, files = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(p); } catch { /* unreadable dir */ }
  for (const e of entries) {
    const child = sizeOf(path.join(p, e));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

/** The extra on-disk artifacts a Claude conversation leaves beside its
 *  transcript: the sidecar dir (subagents/tool-results/workflows), the todos
 *  files, and the per-session scratchpad under the claude tmp roots. */
function claudeSidecars(conversationId: string, transcriptPath: string | undefined, env: TrashEnv): string[] {
  const out: string[] = [];
  if (transcriptPath) {
    const sidecar = path.join(path.dirname(transcriptPath), conversationId);
    if (fs.existsSync(sidecar)) {
      try { if (fs.lstatSync(sidecar).isDirectory()) out.push(sidecar); } catch { /* raced away */ }
    }
  }
  const todosDir = path.join(env.home, '.claude', 'todos');
  let todoEntries: string[] = [];
  try { todoEntries = fs.readdirSync(todosDir); } catch { /* no todos dir */ }
  for (const e of todoEntries) {
    if (e.startsWith(conversationId)) out.push(path.join(todosDir, e));
  }
  for (const tmpRoot of env.tmpRoots) {
    let slugs: string[] = [];
    try { slugs = fs.readdirSync(tmpRoot); } catch { continue; }
    for (const slug of slugs) {
      const candidate = path.join(tmpRoot, slug, conversationId);
      if (fs.existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * Build the delete plan for one session's recorded conversations.
 *
 * `resolveTranscript` is the provider hook (may return a computed path that
 * does not exist yet — filtered here). `shouldSkip` returns a human reason to
 * leave a conversation alone (live in another pane, owned by another session),
 * or undefined to include it.
 */
export function planTrash(
  meta: SessionLabel,
  cwd: string,
  resolveTranscript: (agent: AgentId, id: string, cwd: string) => string | undefined,
  shouldSkip: (agent: AgentId, id: string) => string | undefined,
  env: TrashEnv = defaultTrashEnv(),
): TrashPlan {
  const targets: TrashTarget[] = [];
  const skipped: TrashSkip[] = [];
  const claimed = new Set<string>();
  let totalBytes = 0, fileCount = 0;
  for (const { agent, id } of collectConversationIds(meta)) {
    if (!UUID_RE.test(id)) {
      skipped.push({ agent, conversationId: id, reason: 'unrecognized id format' });
      continue;
    }
    const reason = shouldSkip(agent, id);
    if (reason) {
      skipped.push({ agent, conversationId: id, reason });
      continue;
    }
    const candidates: string[] = [];
    let transcript: string | undefined;
    try { transcript = resolveTranscript(agent, id, cwd); } catch { /* provider hiccup */ }
    if (transcript) candidates.push(transcript);
    if (agent === 'claude') candidates.push(...claudeSidecars(id, transcript, env));
    const paths: string[] = [];
    for (const c of candidates) {
      const resolved = path.resolve(c);
      if (claimed.has(resolved)) continue;             // already owned by an earlier target
      if (!fs.existsSync(resolved)) continue;          // computed-but-unwritten transcript
      if (!isDeletable(resolved, id, env)) continue;   // outside roots or foreign basename
      claimed.add(resolved);
      paths.push(resolved);
      const sz = sizeOf(resolved);
      totalBytes += sz.bytes;
      fileCount += sz.files;
    }
    if (paths.length > 0) targets.push({ agent, conversationId: id, paths });
  }
  return { targets, skipped, totalBytes, fileCount };
}

/** Delete everything in the plan. Each path is re-validated against the same
 *  guard as plan time (defense in depth — the plan may be stale). Best-effort:
 *  failures are collected, never thrown. */
export function executeTrash(plan: TrashPlan, env: TrashEnv = defaultTrashEnv()): TrashResult {
  let deletedPaths = 0, freedBytes = 0;
  const failures: string[] = [];
  for (const t of plan.targets) {
    for (const p of t.paths) {
      if (!isDeletable(p, t.conversationId, env)) {
        failures.push(`${p}: refused (failed safety re-check)`);
        continue;
      }
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; /* already gone */ }
      const sz = sizeOf(p);
      try {
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.rmSync(p, { force: true }); // plain files AND symlinks: unlink only
        deletedPaths++;
        freedBytes += sz.bytes;
      } catch (e) {
        failures.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { deletedPaths, freedBytes, failures };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
