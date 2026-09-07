import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ───────────────────────── OpenCode on-disk storage (read-only) ─────────────────────────
//
// OpenCode (opencode.ai) stores every conversation of every project in one
// SQLite database (WAL mode):
//   $XDG_DATA_HOME/opencode/opencode.db            release builds
//   $XDG_DATA_HOME/opencode/opencode-<channel>.db  beta/dev channels
//   $OPENCODE_DB                                   explicit override
// with `~/.local/share` as the XDG default on macOS and Linux alike.
//
// We only READ it, and only for cold discovery (the resume picker, the recorded
// directory of a conversation we have no transcript for). Live state comes from
// the plugin, never from here — "waiting for permission" does not exist on disk.
// Reads go through the `sqlite3` CLI (`-readonly`, JSON output): macOS ships it
// at /usr/bin/sqlite3, most Linux distros package it, and shelling out avoids a
// native module per Electron ABI. A hung read is killed by the timeout.
//
// Schema notes (v1.18): `session` has id, project_id, parent_id, directory,
// title, agent, model (JSON), cost, tokens_*, time_created/updated/archived.
// Messages live in `message` + `part` (`data` JSON); a newer `session_message`
// table exists but is not the CLI's write path yet — we probe before relying on
// either, so a future flip degrades to "no preview" instead of an empty picker.

const DATA_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'opencode')
  : path.join(os.homedir(), '.local', 'share', 'opencode');
const CACHE_DIR = process.env.XDG_CACHE_HOME
  ? path.join(process.env.XDG_CACHE_HOME, 'opencode')
  : path.join(os.homedir(), '.cache', 'opencode');

export const OPENCODE_DATA_DIR = DATA_DIR;
export const OPENCODE_MODELS_CACHE = path.join(CACHE_DIR, 'models.json');

const SQLITE_TIMEOUT_MS = 2000;

/** Resolve the database OpenCode is writing to, or undefined when none exists. */
export function opencodeDbPath(): string | undefined {
  const override = process.env.OPENCODE_DB;
  if (override && override !== ':memory:') {
    const p = path.isAbsolute(override) ? override : path.join(DATA_DIR, override);
    return fs.existsSync(p) ? p : undefined;
  }
  const main = path.join(DATA_DIR, 'opencode.db');
  if (fs.existsSync(main)) return main;
  // Channel builds: newest opencode-<channel>.db wins.
  let best: { p: string; m: number } | undefined;
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^opencode-[A-Za-z0-9._-]+\.db$/.test(f)) continue;
      const p = path.join(DATA_DIR, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  } catch { /* no data dir */ }
  return best?.p;
}

let sqliteBin: string | null | undefined;
function sqlite3Binary(): string | undefined {
  if (sqliteBin !== undefined) return sqliteBin ?? undefined;
  for (const cand of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (fs.existsSync(cand)) { sqliteBin = cand; return cand; }
  }
  try {
    execFileSync('/bin/sh', ['-lc', 'command -v sqlite3'], { stdio: 'ignore', timeout: 3000 });
    sqliteBin = 'sqlite3';
    return sqliteBin;
  } catch { sqliteBin = null; return undefined; }
}

/** Run a read-only query, rows as objects. Empty array on any failure — callers
 *  treat "nothing" and "unreadable" the same (both mean: no picker entries). */
export function querySqlite<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
  const bin = sqlite3Binary();
  if (!bin) return [];
  try {
    const out = execFileSync(bin, ['-readonly', '-json', '-cmd', '.timeout 1500', dbPath, sql], {
      encoding: 'utf8',
      timeout: SQLITE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Tables present in the db (cached per path for the extension's lifetime;
 *  a schema flip needs an OpenCode upgrade, which needs a restart anyway). */
const tableCache = new Map<string, Set<string>>();
function tablesOf(dbPath: string): Set<string> {
  const hit = tableCache.get(dbPath);
  if (hit) return hit;
  const rows = querySqlite<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
  const set = new Set(rows.map(r => r.name));
  if (set.size) tableCache.set(dbPath, set);
  return set;
}

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  title: string;
  agent?: string;
  model?: string;
  cost: number;
  timeCreated: number;
  timeUpdated: number;
  firstUserMessage?: string;
}

/**
 * Root (non-subagent), non-archived conversations, newest first. `cwd` keeps
 * only sessions started at or under that directory. `limit` bounds the picker.
 */
export function listOpencodeSessions(cwd?: string, limit = 200): OpencodeSessionRow[] {
  const db = opencodeDbPath();
  if (!db) return [];
  const tables = tablesOf(db);
  if (!tables.has('session')) return [];
  const where = ['parent_id IS NULL', 'time_archived IS NULL'];
  if (cwd) {
    const base = cwd.replace(/\/+$/, '');
    where.push(`(directory = ${sqlString(base)} OR directory LIKE ${sqlString(base + '/%')})`);
  }
  const rows = querySqlite<{
    id: string; directory: string; title: string; agent: string | null; model: string | null;
    cost: number; time_created: number; time_updated: number;
  }>(db, `SELECT id, directory, title, agent, model, cost, time_created, time_updated
          FROM session WHERE ${where.join(' AND ')}
          ORDER BY time_updated DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`);
  const out: OpencodeSessionRow[] = rows
    .filter(r => typeof r.id === 'string' && r.id.startsWith('ses_'))
    .map(r => {
      let model: string | undefined;
      if (r.model) {
        try {
          const m = JSON.parse(r.model) as { id?: string; providerID?: string };
          if (m?.id) model = m.providerID ? `${m.providerID}/${m.id}` : m.id;
        } catch { /* not JSON */ }
      }
      return {
        id: r.id,
        directory: r.directory,
        title: r.title,
        agent: r.agent ?? undefined,
        model,
        cost: typeof r.cost === 'number' ? r.cost : 0,
        timeCreated: r.time_created,
        timeUpdated: r.time_updated,
      };
    });

  // First user prompt per session, one batched query against the V1 tables.
  // Skipped when the schema has moved on — the title still identifies the row.
  if (out.length && tables.has('message') && tables.has('part')) {
    const ids = out.map(r => sqlString(r.id)).join(',');
    const previews = querySqlite<{ session_id: string; t: string | null }>(db,
      `SELECT p.session_id AS session_id, json_extract(p.data,'$.text') AS t, MIN(p.id)
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id IN (${ids})
          AND json_extract(m.data,'$.role') = 'user'
          AND json_extract(p.data,'$.type') = 'text'
        GROUP BY p.session_id`);
    const byId = new Map(previews.map(p => [p.session_id, p.t ?? undefined]));
    for (const r of out) {
      const t = byId.get(r.id);
      if (t) r.firstUserMessage = t.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }
  return out;
}

/** The recorded directory of one conversation (for resume when we have no transcript). */
export function opencodeSessionDirectory(sessionId: string): string | undefined {
  if (!/^ses_[0-9A-Za-z]{26}$/.test(sessionId)) return undefined;
  const db = opencodeDbPath();
  if (!db) return undefined;
  const rows = querySqlite<{ directory: string }>(db,
    `SELECT directory FROM session WHERE id = ${sqlString(sessionId)} LIMIT 1`);
  const d = rows[0]?.directory;
  return typeof d === 'string' && d.startsWith('/') ? d : undefined;
}

// ───────────────────────── models catalog → context limit ─────────────────────────

interface ModelsCatalog {
  [providerID: string]: { models?: { [modelID: string]: { limit?: { context?: number } } } };
}

let catalog: { mtimeMs: number; data: ModelsCatalog } | undefined;

function loadCatalog(): ModelsCatalog | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(OPENCODE_MODELS_CACHE); }
  catch { return catalog?.data; }
  if (catalog && catalog.mtimeMs === stat.mtimeMs) return catalog.data;
  try {
    const data = JSON.parse(fs.readFileSync(OPENCODE_MODELS_CACHE, 'utf8')) as ModelsCatalog;
    catalog = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return catalog?.data;
  }
}

/**
 * Context window for a provider/model pair from OpenCode's own catalog cache
 * (~/.cache/opencode/models.json, refreshed by OpenCode itself). The limit is
 * per PROVIDER — the same model id can be capped differently by a proxy
 * provider — so the provider match is tried first, any provider second.
 * Undefined when the catalog or the model is unknown.
 */
export function contextLimitForModel(providerID: string | undefined, modelID: string | undefined): number | undefined {
  if (!modelID) return undefined;
  const cat = loadCatalog();
  if (!cat) return undefined;
  const direct = providerID ? cat[providerID]?.models?.[modelID]?.limit?.context : undefined;
  if (direct && direct > 0) return direct;
  for (const p of Object.values(cat)) {
    const c = p?.models?.[modelID]?.limit?.context;
    if (c && c > 0) return c;
  }
  return undefined;
}

/** Context limit for a `provider/model` string (split on the FIRST slash —
 *  OpenRouter-style ids carry slashes of their own). */
export function contextLimitForModelString(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  if (i < 0) return contextLimitForModel(undefined, model);
  return contextLimitForModel(model.slice(0, i), model.slice(i + 1));
}
