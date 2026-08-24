import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The transcript-cleanup notice: Claude Code silently deletes conversation
 * transcripts older than `cleanupPeriodDays` (default 30). Users discover this
 * only when an old session "starts empty" — the conversation is gone for good.
 * The sidebar shows a one-line dismissible notice until the user either raises
 * the setting or snoozes it (snooze re-arms after 30 days, on purpose: the
 * data loss is permanent, a one-time X should not bury it forever).
 *
 * All fs work is best-effort and vscode-free so it stays node-testable.
 */

const NOTICES_PATH = path.join(os.homedir(), '.terminal-sessions', 'notices.json');
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/** Below this, transcripts still die young enough to be worth warning about. */
const SAFE_CLEANUP_DAYS = 90;
/** What "Keep transcripts" writes: ~10 years = effectively never. */
export const KEEP_FOREVER_DAYS = 3650;
/** A dismissal re-arms after this long. */
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

interface NoticesFile {
  transcriptCleanup?: { dismissedAt?: string };
}

function readNotices(): NoticesFile {
  try {
    const d = JSON.parse(fs.readFileSync(NOTICES_PATH, 'utf8'));
    return d && typeof d === 'object' ? d as NoticesFile : {};
  } catch {
    return {};
  }
}

/** Claude's configured cleanup period, or undefined when unset/unreadable
 *  (unset means Claude applies its 30-day default). */
export function readClaudeCleanupDays(): number | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const v = d?.cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the sidebar should show the transcript-cleanup notice row.
 *  `hasExpiring` = actual transcripts are inside the warn window; that shows
 *  the notice even for a user whose setting is "safe" (≥ 90 days), because the
 *  loss is now concrete, not hypothetical. */
export function shouldShowCleanupNotice(hasExpiring = false): boolean {
  // No ~/.claude at all — Claude Code isn't in use here, nothing to lose.
  try { fs.statSync(path.join(os.homedir(), '.claude')); } catch { return false; }
  const days = readClaudeCleanupDays();
  const unsafeSetting = days === undefined || days < SAFE_CLEANUP_DAYS;
  if (!unsafeSetting && !hasExpiring) return false;
  const dismissedAt = readNotices().transcriptCleanup?.dismissedAt;
  if (dismissedAt) {
    const t = Date.parse(dismissedAt);
    if (Number.isFinite(t) && Date.now() - t < SNOOZE_MS) return false;
  }
  return true;
}

/** Transcripts smaller than this are "open then Esc" glances — losing them is
 *  no loss, so they don't count toward the expiring total. */
const MIN_COUNTED_BYTES = 10 * 1024;
/** Expiry scan is a readdir+stat sweep over every Claude project dir; cache it
 *  so the sidebar's frequent refreshes don't re-stat hundreds of files. */
const EXPIRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface ExpiryInfo {
  /** Transcripts that Claude will delete within the warn window. */
  count: number;
  /** Days until the FIRST of them dies (ceil; ≥ 0). */
  soonestDays: number;
}

let expiryCache: { at: number; days: number; warnDays: number; info: ExpiryInfo } | undefined;

export function clearExpiryCache(): void { expiryCache = undefined; }

/**
 * Count main-thread transcripts (~/.claude/projects/<slug>/*.jsonl) whose
 * deletion date — mtime + cleanupPeriodDays — falls within the next `warnDays`
 * days. Claude's cleanup keys off file mtime, so this predicts exactly what
 * its next startup sweep will remove. Best-effort: fs errors count as zero.
 */
export function countExpiringTranscripts(warnDays: number): ExpiryInfo {
  const days = readClaudeCleanupDays() ?? 30;
  const now = Date.now();
  if (expiryCache
    && now - expiryCache.at < EXPIRY_CACHE_TTL_MS
    && expiryCache.days === days
    && expiryCache.warnDays === warnDays) {
    return expiryCache.info;
  }
  let count = 0;
  let soonestMs = Infinity;
  const windowMs = warnDays * 24 * 60 * 60 * 1000;
  const lifeMs = days * 24 * 60 * 60 * 1000;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    for (const slug of fs.readdirSync(projectsDir)) {
      let files: string[];
      try { files = fs.readdirSync(path.join(projectsDir, slug)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        let st: fs.Stats;
        try { st = fs.statSync(path.join(projectsDir, slug, f)); } catch { continue; }
        if (!st.isFile() || st.size < MIN_COUNTED_BYTES) continue;
        const remaining = st.mtimeMs + lifeMs - now;
        if (remaining > 0 && remaining <= windowMs) {
          count++;
          if (remaining < soonestMs) soonestMs = remaining;
        }
      }
    }
  } catch { /* no projects dir — count stays 0 */ }
  const info: ExpiryInfo = {
    count,
    soonestDays: count > 0 ? Math.max(0, Math.ceil(soonestMs / (24 * 60 * 60 * 1000))) : 0,
  };
  expiryCache = { at: now, days, warnDays, info };
  return info;
}

/** X on the notice row: hide it for the next 30 days. */
export function snoozeCleanupNotice(): void {
  const d = readNotices();
  d.transcriptCleanup = { dismissedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(NOTICES_PATH), { recursive: true });
    fs.writeFileSync(NOTICES_PATH, JSON.stringify(d, null, 2) + '\n');
  } catch { /* best effort — worst case the notice shows again */ }
}

/**
 * Write `cleanupPeriodDays` into ~/.claude/settings.json, preserving the rest
 * of the file byte-for-byte (surgical textual edit, not a parse + re-stringify
 * that would reorder keys and drop formatting). Returns an error message on
 * failure, undefined on success.
 */
export function setClaudeCleanupDays(days: number): string | undefined {
  let raw: string | undefined;
  try { raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'); } catch { raw = undefined; }

  let next: string;
  if (raw === undefined || raw.trim() === '') {
    next = `{\n  "cleanupPeriodDays": ${days}\n}\n`;
  } else {
    try { JSON.parse(raw); } catch {
      return `~/.claude/settings.json is not valid JSON — fix it by hand, then add "cleanupPeriodDays": ${days}`;
    }
    if (/"cleanupPeriodDays"\s*:\s*-?\d+(\.\d+)?/.test(raw)) {
      next = raw.replace(/"cleanupPeriodDays"\s*:\s*-?\d+(\.\d+)?/, `"cleanupPeriodDays": ${days}`);
    } else {
      const idx = raw.indexOf('{');
      if (idx < 0) return '~/.claude/settings.json has no top-level object';
      next = raw.slice(0, idx + 1) + `\n  "cleanupPeriodDays": ${days},` + raw.slice(idx + 1);
    }
    try { JSON.parse(next); } catch {
      return 'edit would corrupt ~/.claude/settings.json — aborted, nothing written';
    }
  }
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, next);
    return undefined;
  } catch (e) {
    return `could not write ~/.claude/settings.json: ${String(e).slice(0, 120)}`;
  }
}
