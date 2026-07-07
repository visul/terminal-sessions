import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentProvider, AgentSessionSummary } from './agents/types';
import type { TranscriptSummary } from './claude-transcript';

/** A past session found on disk, plus its sidecar friendly name if any. */
export interface ArchivedSession extends AgentSessionSummary {
  friendlyName?: string;
}

/**
 * Merge every provider's on-disk session list into one mtime-desc list and
 * attach friendly names. Pure: providers and the name lookup are injected, so
 * this stays vscode-free and node-testable. `scopeCwd` is forwarded to each
 * provider's listSessions (undefined = all projects, a cwd = that slug only).
 *
 * Spawned sub-sessions (agent-team teammates, pure subagent transcripts) are
 * dropped by default so callers see only top-level, user-driven main threads.
 * Providers tag them via `subsessionRole`; filtering here keeps the policy in
 * one place so it applies uniformly to every agent (Claude/Codex/agy/grok) and
 * to both the resume picker and the cleanup scan. Pass
 * `{ includeSubsessions: true }` to keep them (none of today's callers do).
 */
export function scanArchive(
  providers: Pick<AgentProvider, 'listSessions'>[],
  nameLookup: (sessionId: string) => string | undefined,
  scopeCwd?: string,
  opts?: { includeSubsessions?: boolean },
): ArchivedSession[] {
  const merged: ArchivedSession[] = [];
  for (const p of providers) {
    let list: AgentSessionSummary[] = [];
    try { list = p.listSessions(scopeCwd); } catch { list = []; }
    for (const s of list) {
      if (s.subsessionRole && !opts?.includeSubsessions) continue;
      merged.push({ ...s, friendlyName: nameLookup(s.sessionId) });
    }
  }
  merged.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return merged;
}

/**
 * Decide a cleanup verdict for one session.
 *   - empty   = 0 user/assistant records and no summary line.
 *   - invalid = first user message is an "Invalid API key" stub.
 *   - keep    = everything else (and any unreadable summary — never delete
 *               something we couldn't classify).
 */
export function classifyForCleanup(
  summary: TranscriptSummary | undefined,
): 'empty' | 'invalid' | 'keep' {
  if (!summary) return 'keep';
  const first = summary.firstUserMessage || '';
  if (/Invalid API key|Please run \/login/i.test(first)) return 'invalid';
  if (summary.userAssistantCount === 0 && !summary.hasSummary) return 'empty';
  return 'keep';
}

/**
 * Soft-delete a session transcript by moving it into
 * `~/.claude/projects/.bak/<slug>__<id>.jsonl`. Also moves the session's
 * `<id>/subagents` sibling dir if present. A 0-byte file is unlinked outright.
 *
 * HARD BOUNDARY: only the `.jsonl` (+ its subagents dir) is touched. We never
 * read or write __store.db, sessions-index.json, history, or any other Claude
 * state — so Claude's index goes stale but is never corrupted.
 */
export function softDeleteSession(
  transcriptPath: string,
): { ok: boolean; dest?: string; error?: string } {
  try {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const slug = path.basename(path.dirname(transcriptPath));
    const id = path.basename(transcriptPath, '.jsonl');

    let stat: fs.Stats;
    try { stat = fs.statSync(transcriptPath); }
    catch { return { ok: false, error: 'not found' }; }

    if (stat.size === 0) {
      fs.unlinkSync(transcriptPath);
      // Best-effort: drop an empty subagents dir too.
      try { fs.rmSync(path.join(path.dirname(transcriptPath), id, 'subagents'), { recursive: true, force: true }); } catch { /* none */ }
      return { ok: true, dest: '(unlinked empty file)' };
    }

    const bakDir = path.join(projectsRoot, '.bak');
    try { fs.mkdirSync(bakDir, { recursive: true }); }
    catch (e) { return { ok: false, error: `mkdir .bak failed: ${String(e)}` }; }

    const dest = path.join(bakDir, `${slug}__${id}.jsonl`);
    fs.renameSync(transcriptPath, dest);

    // Move the background-agent transcripts dir if it exists.
    const subDir = path.join(path.dirname(transcriptPath), id, 'subagents');
    if (fs.existsSync(subDir)) {
      try { fs.renameSync(subDir, path.join(bakDir, `${slug}__${id}__subagents`)); } catch { /* best effort */ }
    }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
