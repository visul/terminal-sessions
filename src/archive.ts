import type { AgentProvider, AgentSessionSummary } from './agents/types';

/** A past session found on disk, plus its sidecar friendly name if any. */
export interface ArchivedSession extends AgentSessionSummary {
  friendlyName?: string;
}

/**
 * Merge every provider's on-disk session list into one mtime-desc list and
 * attach friendly names. Pure: providers and the name lookup are injected, so
 * this stays vscode-free and node-testable. `scopeCwd` is forwarded to each
 * provider's listSessions (undefined = all projects, a cwd = that slug only).
 */
export function scanArchive(
  providers: Pick<AgentProvider, 'listSessions'>[],
  nameLookup: (sessionId: string) => string | undefined,
  scopeCwd?: string,
): ArchivedSession[] {
  const merged: ArchivedSession[] = [];
  for (const p of providers) {
    let list: AgentSessionSummary[] = [];
    try { list = p.listSessions(scopeCwd); } catch { list = []; }
    for (const s of list) {
      merged.push({ ...s, friendlyName: nameLookup(s.sessionId) });
    }
  }
  merged.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return merged;
}
