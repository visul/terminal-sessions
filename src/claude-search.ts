import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionIndexEntry {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  title: string;        // derived from first user prompt
  firstPrompt: string;
  lastPrompt: string;
  turns: number;
  lastModified: number; // ms since epoch
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const INDEX_PATH = path.join(os.homedir(), '.terminal-sessions', 'search-index.json');
const HEAD_SCAN_BYTES = 256 * 1024;  // scan first 256 KB for first user prompt
const TAIL_SCAN_BYTES = 128 * 1024;  // last 128 KB for last user prompt
const MAX_PREVIEW = 200;
const SLASH_CMD_RE = /^(<command-name>|<command-message>|<command-args>|<local-command-[^>]+>|\/)/;

export class ClaudeSearchIndex {
  private entries = new Map<string, SessionIndexEntry>();  // key: transcriptPath
  private loaded = false;

  async load(): Promise<void> {
    try {
      const raw = fs.readFileSync(INDEX_PATH, 'utf8');
      const data = JSON.parse(raw) as Record<string, SessionIndexEntry>;
      for (const [k, v] of Object.entries(data)) this.entries.set(k, v);
    } catch { /* no index yet */ }
    this.loaded = true;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
      const obj = Object.fromEntries(this.entries);
      fs.writeFileSync(INDEX_PATH, JSON.stringify(obj));
    } catch (e) {
      console.error('[terminal-sessions] search-index save:', e);
    }
  }

  /** Walk ~/.claude/projects/, index any .jsonl file we haven't seen or
   *  whose mtime has advanced. Returns the number of entries added/updated. */
  async refresh(): Promise<number> {
    if (!this.loaded) await this.load();
    let changed = 0;
    let projectDirs: string[] = [];
    try { projectDirs = fs.readdirSync(PROJECTS_ROOT); }
    catch { return 0; }
    const live = new Set<string>();
    for (const dir of projectDirs) {
      const full = path.join(PROJECTS_ROOT, dir);
      let files: string[] = [];
      try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); }
      catch { continue; }
      for (const f of files) {
        const fpath = path.join(full, f);
        live.add(fpath);
        let stat: fs.Stats;
        try { stat = fs.statSync(fpath); }
        catch { continue; }
        const existing = this.entries.get(fpath);
        if (existing && existing.lastModified >= stat.mtimeMs && existing.turns > 0) continue;
        const entry = readTranscriptSummary(fpath, stat.mtimeMs, f.replace(/\.jsonl$/, ''));
        if (entry) {
          this.entries.set(fpath, entry);
          changed++;
        }
      }
    }
    // Drop entries for files that were deleted
    for (const p of Array.from(this.entries.keys())) {
      if (!live.has(p)) this.entries.delete(p);
    }
    if (changed > 0) this.save();
    return changed;
  }

  list(): SessionIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  search(query: string): SessionIndexEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    const tokens = q.split(/\s+/);
    const results: Array<{ e: SessionIndexEntry; score: number }> = [];
    for (const e of this.entries.values()) {
      const hay = `${e.title} ${e.firstPrompt} ${e.lastPrompt} ${e.cwd}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const idx = hay.indexOf(t);
        if (idx < 0) { score = -1; break; }
        score += 100 - Math.min(99, idx / 10);  // earlier match → higher score
      }
      if (score >= 0) {
        // Freshness bonus: recent sessions rank higher on ties
        score += Math.max(0, 10 - (Date.now() - e.lastModified) / (24 * 3600 * 1000));
        results.push({ e, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.map(r => r.e);
  }
}

function readTranscriptSummary(
  fpath: string,
  lastModified: number,
  sessionId: string,
): SessionIndexEntry | undefined {
  let firstPrompt = '';
  let lastPrompt = '';
  let cwd = '';
  let turns = 0;

  let stat: fs.Stats;
  try { stat = fs.statSync(fpath); } catch { return undefined; }
  const size = stat.size;

  // Read head window
  const headBuf = readRange(fpath, 0, Math.min(HEAD_SCAN_BYTES, size));
  if (headBuf) {
    const lines = headBuf.toString('utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const data = safeParse(line);
      if (!data) continue;
      if (!cwd && typeof data.cwd === 'string') cwd = data.cwd;
      const prompt = extractUserPrompt(data);
      if (prompt && !firstPrompt) {
        firstPrompt = prompt;
        break;
      }
    }
  }

  // Read tail window (and count assistant turns via full line count — cheap)
  if (size > HEAD_SCAN_BYTES) {
    const start = Math.max(0, size - TAIL_SCAN_BYTES);
    const tailBuf = readRange(fpath, start, size - start);
    if (tailBuf) {
      const text = tailBuf.toString('utf8');
      // Skip first (possibly partial) line
      const lines = text.split('\n').slice(start === 0 ? 0 : 1);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        const data = safeParse(line);
        if (!data) continue;
        const prompt = extractUserPrompt(data);
        if (prompt) { lastPrompt = prompt; break; }
      }
    }
  } else {
    lastPrompt = firstPrompt;
  }

  // Full turn count: we read the whole file for small ones (<2MB), else estimate
  if (size < 2 * 1024 * 1024) {
    try {
      const all = fs.readFileSync(fpath, 'utf8');
      for (const line of all.split('\n')) {
        if (!line) continue;
        if (line.includes('"type":"assistant"')) turns++;
      }
    } catch { /* leave as 0 */ }
  } else {
    // Rough: assume ~1 assistant line per ~1200 bytes (typical)
    turns = Math.round(size / 1200);
  }

  if (!firstPrompt) return undefined;
  const title = firstPrompt.slice(0, 80);
  return {
    sessionId,
    transcriptPath: fpath,
    cwd,
    title,
    firstPrompt: firstPrompt.slice(0, MAX_PREVIEW),
    lastPrompt: (lastPrompt || firstPrompt).slice(0, MAX_PREVIEW),
    turns,
    lastModified,
  };
}

function readRange(fpath: string, offset: number, length: number): Buffer | undefined {
  try {
    const fd = fs.openSync(fpath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    return buf;
  } catch { return undefined; }
}

function safeParse(line: string): Record<string, unknown> | undefined {
  try { return JSON.parse(line); }
  catch { return undefined; }
}

function extractUserPrompt(data: Record<string, unknown>): string {
  if (data.type !== 'user') return '';
  const msg = data.message as { role?: string; content?: unknown } | undefined;
  if (!msg || msg.role !== 'user') return '';
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') text += ' ' + block.text;
    }
  }
  text = text.trim();
  if (!text) return '';
  // Skip command-only messages ("/clear", hook outputs, etc.)
  if (SLASH_CMD_RE.test(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}
