import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';
import { sessionNameForTerminal, resolveTmuxNameForTerminalLive } from './profile-provider';

interface TrackedInfo {
  sessionName: string;
  workspaceHash: string;
  lastSeenName: string;
  /** Titles the extension asked VS Code for (name → give up at), still to be
   *  seen; when one shows up it is the extension's, not a rename by the user. */
  expected?: Map<string, number>;
}

/** Longer than one poll, so a slow retitle is still recognised. */
const EXPECT_MS = 5000;

/** A tab rename the user made (not one the extension applied itself). */
export interface UserTabRename {
  workspaceHash: string;
  sessionName: string;
  label: string;
}

/**
 * Watches all persistent terminals for name changes (from tab right-click → Rename)
 * and saves the new name as the session label in our index so it survives restart.
 * The last title seen on a live tab is kept too (`tabName`), so a reload does not
 * read an old title on a restored tab as a rename.
 *
 * Terminals restored across a window reload come back with trimmed
 * `creationOptions` (no shellArgs), so the cheap shellArgs match can't identify
 * them. Those are resolved through the live process instead (`ps` on the PID)
 * — otherwise a rename on any reload-restored tab was silently never saved, and
 * the sidebar kept showing the bare `#<id>` while the tab carried the new name.
 */
export class TerminalTracker implements vscode.Disposable {
  private tracked = new Map<vscode.Terminal, TrackedInfo>();
  /** Terminals we could not identify (not ours, or PID walk failed). Never retried
   *  more than once per open — the PID walk is a `ps` per terminal. */
  private untracked = new WeakSet<vscode.Terminal>();
  private resolving = new WeakSet<vscode.Terminal>();
  private interval: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly renamedByUser = new vscode.EventEmitter<UserTabRename>();
  /** Fires after a rename typed on the tab has been saved as the label. */
  readonly onDidRenameByUser = this.renamedByUser.event;

  constructor(private index: SessionIndex) {
    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => this.maybeTrack(t)),
      vscode.window.onDidCloseTerminal(t => this.tracked.delete(t)),
    );
    for (const t of vscode.window.terminals) this.maybeTrack(t);
  }

  start(): void {
    this.interval = setInterval(() => this.checkRenames(), 3000);
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.disposables.forEach(d => d.dispose());
    this.renamedByUser.dispose();
    this.tracked.clear();
  }

  /** The open tab of a session, reload-restored tabs included. */
  terminalFor(sessionName: string): vscode.Terminal | undefined {
    for (const [term, info] of this.tracked) {
      if (info.sessionName === sessionName && !term.exitStatus) return term;
    }
    return undefined;
  }

  /** The extension is about to give this tab `name` itself: not a user rename. */
  expectName(terminal: vscode.Terminal, name: string): void {
    const info = this.tracked.get(terminal);
    if (!info) return;
    info.expected ??= new Map();
    info.expected.set(name, Date.now() + EXPECT_MS);
  }

  private maybeTrack(terminal: vscode.Terminal): void {
    if (this.tracked.has(terminal) || this.untracked.has(terminal) || this.resolving.has(terminal)) return;
    const opts = terminal.creationOptions;
    if (!opts || typeof opts !== 'object') return;
    // ExtensionTerminalOptions has `pty` field, skip those
    if ('pty' in opts) return;
    const cfg = getConfig();
    // Expect either: new-session -A -s <name> ...   OR   attach-session -t <name>
    const direct = sessionNameForTerminal(terminal);
    if (direct) {
      this.adopt(terminal, direct, cfg.sessionPrefix, false);
      return;
    }
    // No shellArgs: a reload-restored tab. Identify it from the live process.
    // Deferred so activation (which constructs us) is not held up by `ps`.
    this.resolving.add(terminal);
    void resolveTmuxNameForTerminalLive(terminal, this.index, cfg.sessionPrefix)
      .then(name => {
        this.resolving.delete(terminal);
        if (terminal.exitStatus) return;
        if (!name) { this.untracked.add(terminal); return; }
        this.adopt(terminal, name, cfg.sessionPrefix, true);
      })
      .catch(() => { this.resolving.delete(terminal); this.untracked.add(terminal); });
  }

  private adopt(terminal: vscode.Terminal, sessionName: string, prefix: string, restored: boolean): void {
    if (!sessionName.startsWith(`${prefix}-`)) { this.untracked.add(terminal); return; }
    const parsed = parseSessionName(sessionName, prefix);
    if (!parsed) { this.untracked.add(terminal); return; }
    this.tracked.set(terminal, {
      sessionName,
      workspaceHash: parsed.hash,
      lastSeenName: terminal.name,
    });
    // A restored tab may have been renamed while nobody was watching it (before
    // the reload, or before this resolve landed). Reconcile once: if the tab
    // carries a name the extension would not have rendered for the session's
    // current label, that name is the user's and the index gets it.
    if (restored) this.reconcile(terminal, parsed.hash, sessionName, parsed.tabId);
    if (terminal.name && terminal.name !== 'tmux') this.index.setSessionTabName(parsed.hash, sessionName, terminal.name);
  }

  private reconcile(terminal: vscode.Terminal, hash: string, sessionName: string, tabId: number): void {
    const tabName = (terminal.name || '').trim();
    if (!tabName || tabName === 'tmux') return;
    const meta = this.index.getSessionMeta(hash, sessionName);
    // Still the title it had when last open: the label may have been renamed
    // since (in the sidebar), and that newer name stays.
    if (meta?.tabName && tabName === meta.tabName.trim()) return;
    const wsLabel = this.index.getWorkspace(hash)?.label;
    const extracted = this.extractLabel(tabName, tabId);
    if (!extracted) return;
    if (meta?.label && extracted === meta.label.trim()) return;
    // Unlabeled sessions render as `<workspace>#<id>` / `<folder>#<id>`; that
    // is the extension's own name, not something the user typed.
    if (!meta?.label) {
      const own = new Set([wsLabel, meta?.folderPath?.split('/').pop()].filter(Boolean));
      if (own.has(extracted)) return;
    }
    this.index.setSessionLabel(hash, sessionName, extracted);
  }

  private checkRenames(): void {
    const cfg = getConfig();
    // Terminals that were not identifiable at open time (PID not yet
    // available) get another look on the next tick.
    for (const t of vscode.window.terminals) this.maybeTrack(t);
    for (const [term, info] of this.tracked) {
      if (info.expected) {
        const now = Date.now();
        for (const [name, until] of info.expected) if (now > until) info.expected.delete(name);
        const ours = info.expected.has(term.name);
        // Seen: it and every title asked for before it are done with (the
        // map keeps insertion order).
        if (ours) {
          for (const name of [...info.expected.keys()]) {
            info.expected.delete(name);
            if (name === term.name) break;
          }
        }
        if (info.expected.size === 0) info.expected = undefined;
        if (ours) {
          info.lastSeenName = term.name;
          this.index.setSessionTabName(info.workspaceHash, info.sessionName, term.name);
          continue;
        }
      }
      if (term.name === info.lastSeenName) continue;
      const parsed = parseSessionName(info.sessionName, cfg.sessionPrefix);
      const newLabel = this.extractLabel(term.name, parsed?.tabId);
      info.lastSeenName = term.name;
      // "tmux" is VS Code falling back to the process name, not a rename.
      if (!newLabel || newLabel === 'tmux') continue;
      const before = this.index.getSessionLabel(info.workspaceHash, info.sessionName);
      this.index.setSessionLabel(info.workspaceHash, info.sessionName, newLabel);
      this.index.setSessionTabName(info.workspaceHash, info.sessionName, term.name);
      if (newLabel !== before?.trim()) {
        this.renamedByUser.fire({ workspaceHash: info.workspaceHash, sessionName: info.sessionName, label: newLabel });
      }
    }
  }

  private extractLabel(displayName: string, tabId?: number): string {
    // Strip our own "Persistent: " / "Attached: " prefix if present so label stores only user intent.
    let label = displayName.replace(/^(Persistent|Attached):\s*/i, '').trim();
    // Strip the trailing "#<tabId>" the extension itself appends when it builds the
    // tab name (defaultTermName). Without this, an in-place tab rename re-saves the
    // suffix into the label and displayName doubles it ("api-v2 #3 #3"). Only strip
    // when the number matches THIS session's own tabId so a user's own trailing "#7"
    // on an unrelated tab survives.
    if (tabId !== undefined) {
      label = label.replace(new RegExp(`\\s*#${tabId}$`), '').trim();
    }
    return label;
  }
}
