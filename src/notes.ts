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
  /** Set when notes.json could not be parsed AND could not be backed up. While
   *  set, this window never writes, so the unreadable file stays intact for
   *  manual recovery. */
  private saveBlocked = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after any write from this window, and after a reload picked up
   *  another window's write. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidRemove = new vscode.EventEmitter<{ workspaceHash: string; sessionName: string }>();
  /** Fires when a specific note goes away. Lets the editor drop a pin on a
   *  session that was just killed — SessionIndex removes the note from a layer
   *  that cannot reach the view. */
  readonly onDidRemove = this._onDidRemove.event;

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
      if (!parsed || parsed.version !== 1 || !parsed.notes || typeof parsed.notes !== 'object') {
        throw new Error('unexpected notes shape');
      }
      // Per-entry validation, not just the envelope: a single malformed entry
      // (a null, a missing text) used to throw inside has()/namesWithNotes(),
      // which runs from the sidebar's root getChildren and would take the whole
      // tree down. Bad entries are dropped, good ones survive.
      const notes: Record<string, SessionNote> = {};
      for (const [k, v] of Object.entries(parsed.notes as Record<string, unknown>)) {
        const n = v as Partial<SessionNote> | null;
        if (!n || typeof n.text !== 'string') continue;
        notes[k] = { text: n.text, updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now() };
      }
      return { version: 1, notes };
    } catch (e) {
      // Starting empty means the next save REPLACES a file we could not read.
      // That is only acceptable once a copy exists; if the backup itself fails
      // there is nowhere to recover from, so refuse to write at all rather than
      // destroy notes we merely failed to parse.
      try {
        const bak = `${this.filePath}.corrupt.${Date.now()}`;
        fs.writeFileSync(bak, raw);
        console.error(`[terminal-sessions] notes.json unparseable (${e}); backed up to ${bak}`);
      } catch (be) {
        this.saveBlocked = true;
        console.error(`[terminal-sessions] notes.json unparseable (${e}) AND un-backupable (${be}); refusing to overwrite it`);
      }
      return { version: 1, notes: {} };
    }
  }

  private load(): void {
    this.data = this.readFromDisk() ?? { version: 1, notes: {} };
    try { this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch { this.lastMtimeMs = 0; }
  }

  /** Cheap (one statSync) check for another window's write. Fires onDidChange
   *  when the in-memory copy was actually replaced, so an open note editor
   *  repaints instead of sitting on text the other window has already
   *  superseded. Returns whether that happened.
   *
   *  This narrows, but cannot close, last-writer-wins: two windows typing into
   *  the same note still overwrite each other. Shrinking the stale window to
   *  one poll is the right trade for a single-user tool. */
  reloadIfChanged(): boolean {
    let mtime = 0;
    try { mtime = fs.statSync(this.filePath).mtimeMs; } catch { return false; }
    if (mtime === this.lastMtimeMs) return false;
    const fresh = this.readFromDisk();
    if (!fresh) return false;
    this.data = fresh;
    this.lastMtimeMs = mtime;
    this._onDidChange.fire();
    return true;
  }

  private save(): void {
    if (this.saveBlocked) return;
    // Atomic replace, and the temp name carries the pid: two VS Code windows
    // saving at the same moment must not write and truncate the SAME temp file,
    // which would lose one window's edit at the rename. Mirrors SessionIndex.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      try { this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch { /* keep prior */ }
    } catch (e) {
      console.error('[terminal-sessions] cannot save notes:', e);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      // Nothing reached disk: telling listeners "saved" would repaint the tree
      // from memory that no longer matches the file.
      return;
    }
    this._onDidChange.fire();
  }

  /** Re-read unconditionally, right before a mutation. save() rewrites the
   *  WHOLE file, so a mutation applied to a stale copy silently reverts every
   *  other note another window wrote in the meantime. reloadIfChanged() is not
   *  enough here: it is gated on mtime, which another window's write inside the
   *  same filesystem tick does not move. This leaves only the microseconds
   *  between the read and the rename, instead of a whole poll interval. */
  private refreshBeforeWrite(): void {
    const fresh = this.readFromDisk();
    if (!fresh) return;
    const changed = JSON.stringify(fresh.notes) !== JSON.stringify(this.data.notes);
    this.data = fresh;
    try { this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch { /* keep prior */ }
    if (changed) this._onDidChange.fire();
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
    this.refreshBeforeWrite();
    const key = noteKey(workspaceHash, sessionName);
    const existing = this.data.notes[key];
    if (text.trim().length === 0) {
      if (!existing) return;
      delete this.data.notes[key];
      this.save();
      this._onDidRemove.fire({ workspaceHash, sessionName });
      return;
    }
    if (existing && existing.text === text) return;
    this.data.notes[key] = { text, updatedAt: Date.now() };
    this.save();
  }

  remove(workspaceHash: string, sessionName: string): void {
    this.refreshBeforeWrite();
    const key = noteKey(workspaceHash, sessionName);
    if (!this.data.notes[key]) return;
    delete this.data.notes[key];
    this.save();
    this._onDidRemove.fire({ workspaceHash, sessionName });
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
    this._onDidRemove.dispose();
    // Clear the module singleton: a disable/enable cycle in the same process
    // would otherwise hand the next activate() this instance, whose emitters
    // are dead, and nothing would ever repaint again.
    if (store === this) store = undefined;
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
