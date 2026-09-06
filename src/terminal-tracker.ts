import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';
import { sessionNameForTerminal, resolveTmuxNameForTerminalLive } from './profile-provider';

interface TrackedInfo {
  sessionName: string;
  workspaceHash: string;
  lastSeenName: string;
}

/**
 * Watches all persistent terminals for name changes (from tab right-click → Rename)
 * and saves the new name as the session label in our index so it survives restart.
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
    this.tracked.clear();
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
  }

  private reconcile(terminal: vscode.Terminal, hash: string, sessionName: string, tabId: number): void {
    const tabName = (terminal.name || '').trim();
    if (!tabName || tabName === 'tmux') return;
    const meta = this.index.getSessionMeta(hash, sessionName);
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
      if (term.name === info.lastSeenName) continue;
      const parsed = parseSessionName(info.sessionName, cfg.sessionPrefix);
      const newLabel = this.extractLabel(term.name, parsed?.tabId);
      if (newLabel) {
        this.index.setSessionLabel(info.workspaceHash, info.sessionName, newLabel);
      }
      info.lastSeenName = term.name;
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
