import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** One free-form note per session. Plain text, no structure imposed. */
export interface SessionNote {
  text: string;
  /** Epoch ms of the last edit. Drives the "saved 2m ago" hint and the
   *  Notes-folder ordering (most recently touched first). */
  updatedAt: number;
}

interface NotesFile { version: 1; notes: Record<string, SessionNote> }

/** Store key. The tmux session NAME is stable across renames (the label is
 *  not), so a renamed session keeps its note. */
export function noteKey(workspaceHash: string, sessionName: string): string {
  return `${workspaceHash}/${sessionName}`;
}

/** First line of a note, for the one-line preview on a tree row. */
export function noteSummary(text: string, max = 60): string {
  const first = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * Per-session plain-text notes, persisted to ~/.terminal-sessions/notes.json.
 *
 * Deliberately a SEPARATE file from index.json: these are hand-written by the
 * user and irreplaceable, so they must never share a rewrite (or a corrupt
 * fallback) with the machine-generated session index. Same mtime-polling
 * reload trick as SessionIndex, so two VS Code windows editing notes converge.
 */
export class NoteStore {
  private readonly filePath: string;
  private data: NotesFile = { version: 1, notes: {} };
  private lastMtimeMs = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after any write from this window, and after a reload picked up
   *  another window's write. */
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    const dir = path.join(os.homedir(), '.terminal-sessions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    this.filePath = path.join(dir, 'notes.json');
    this.load();
  }

  /** Read + parse notes.json. A corrupt file is preserved (never silently
   *  discarded — the text in it is the user's own writing) and we start empty.
   *  Returns null on a read error other than ENOENT so callers keep memory. */
  private readFromDisk(): NotesFile | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, notes: {} };
      console.error('[terminal-sessions] cannot read notes:', e);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.notes && typeof parsed.notes === 'object') {
        return parsed as NotesFile;
      }
      throw new Error('unexpected notes shape');
    } catch (e) {
      try {
        const bak = `${this.filePath}.corrupt.${Date.now()}`;
        fs.writeFileSync(bak, raw);
        console.error(`[terminal-sessions] notes.json unparseable (${e}); backed up to ${bak}`);
      } catch { /* best effort */ }
      return { version: 1, notes: {} };
    }
  }

  private load(): void {
    this.data = this.readFromDisk() ?? { version: 1, notes: {} };
    try { this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch { this.lastMtimeMs = 0; }
  }

  /** Cheap (one statSync) check for another window's write. Returns true when
   *  the in-memory copy was actually replaced, so callers can skip a refresh. */
  reloadIfChanged(): boolean {
    let mtime = 0;
    try { mtime = fs.statSync(this.filePath).mtimeMs; } catch { return false; }
    if (mtime === this.lastMtimeMs) return false;
    const fresh = this.readFromDisk();
    if (!fresh) return false;
    this.data = fresh;
    this.lastMtimeMs = mtime;
    return true;
  }

  private save(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch (e) {
      console.error('[terminal-sessions] cannot save notes:', e);
    }
    this._onDidChange.fire();
  }

  get(workspaceHash: string, sessionName: string): SessionNote | undefined {
    return this.data.notes[noteKey(workspaceHash, sessionName)];
  }

  has(workspaceHash: string, sessionName: string): boolean {
    const n = this.data.notes[noteKey(workspaceHash, sessionName)];
    return !!n && n.text.trim().length > 0;
  }

  /** Writes the note, or removes it when the text is blank — an emptied note
   *  is a deleted note, so the ✎ marker and the Notes row disappear together.
   *  No-ops (and fires nothing) when the text is unchanged, so the debounced
   *  webview saves don't churn the file or the tree. */
  set(workspaceHash: string, sessionName: string, text: string): void {
    this.reloadIfChanged();
    const key = noteKey(workspaceHash, sessionName);
    const existing = this.data.notes[key];
    if (text.trim().length === 0) {
      if (!existing) return;
      delete this.data.notes[key];
      this.save();
      return;
    }
    if (existing && existing.text === text) return;
    this.data.notes[key] = { text, updatedAt: Date.now() };
    this.save();
  }

  remove(workspaceHash: string, sessionName: string): void {
    this.reloadIfChanged();
    const key = noteKey(workspaceHash, sessionName);
    if (!this.data.notes[key]) return;
    delete this.data.notes[key];
    this.save();
  }

  /** Session names in this workspace that carry a note, most recently edited
   *  first. The tree turns these into rows; ordering by edit recency is what
   *  makes the folder useful when several sessions have notes. */
  namesWithNotes(workspaceHash: string): string[] {
    const prefix = `${workspaceHash}/`;
    return Object.entries(this.data.notes)
      .filter(([k, v]) => k.startsWith(prefix) && v.text.trim().length > 0)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([k]) => k.slice(prefix.length));
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Process-wide store. Created in activate(); the tree, the webviews and the
 *  session index all read through this one instance so a write anywhere shows
 *  up everywhere on the next event. */
let store: NoteStore | undefined;

export function initNoteStore(): NoteStore {
  if (!store) store = new NoteStore();
  return store;
}

export function noteStore(): NoteStore | undefined {
  return store;
}
