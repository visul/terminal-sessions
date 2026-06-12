import { execFileSync } from 'child_process';

/**
 * True when `cmd` resolves on PATH. Uses a login shell (`sh -lc`) so it sees
 * the user's profile PATH even when the IDE was launched from Finder with a
 * stripped environment (a common cause of "claude/codex not found" in GUI apps).
 * Best-effort and cached per process — only used to default `enabledAgents`.
 */
const cache = new Map<string, boolean>();
export function commandOnPath(cmd: string): boolean {
  const hit = cache.get(cmd);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    execFileSync('/bin/sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
    ok = true;
  } catch { ok = false; }
  cache.set(cmd, ok);
  return ok;
}
