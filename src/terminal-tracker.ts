import * as vscode from 'vscode';
import { SessionIndex } from './session-manager';
import { parseSessionName } from './workspace-id';
import { getConfig } from './config';

interface TrackedInfo {
  sessionName: string;
  workspaceHash: string;
  lastSeenName: string;
}

/**
 * Watches all persistent terminals for name changes (from tab right-click → Rename)
 * and saves the new name as the session label in our index so it survives restart.
 */
export class TerminalTracker implements vscode.Disposable {
  private tracked = new Map<vscode.Terminal, TrackedInfo>();
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
    const opts = terminal.creationOptions;
    if (!opts || typeof opts !== 'object') return;
    // ExtensionTerminalOptions has `pty` field, skip those
    if ('pty' in opts) return;
    const shellArgs = (opts as vscode.TerminalOptions).shellArgs;
    if (!shellArgs) return;
    const args = Array.isArray(shellArgs) ? shellArgs : [shellArgs];
    // Expect either: new-session -A -s <name> ...   OR   attach-session -t <name>
    const sIdx = args.indexOf('-s');
    const tIdx = args.indexOf('-t');
    const nameIdx = sIdx >= 0 ? sIdx + 1 : (tIdx >= 0 ? tIdx + 1 : -1);
    if (nameIdx < 0 || nameIdx >= args.length) return;
    const sessionName = args[nameIdx];
    const cfg = getConfig();
    if (!sessionName.startsWith(`${cfg.sessionPrefix}-`)) return;
    const parsed = parseSessionName(sessionName, cfg.sessionPrefix);
    if (!parsed) return;
    this.tracked.set(terminal, {
      sessionName,
      workspaceHash: parsed.hash,
      lastSeenName: terminal.name,
    });
  }

  private checkRenames(): void {
    for (const [term, info] of this.tracked) {
      if (term.name === info.lastSeenName) continue;
      const newLabel = this.extractLabel(term.name);
      if (newLabel) {
        this.index.setSessionLabel(info.workspaceHash, info.sessionName, newLabel);
      }
      info.lastSeenName = term.name;
    }
  }

  private extractLabel(displayName: string): string {
    // Strip our own "Persistent: " / "Attached: " prefix if present so label stores only user intent.
    return displayName.replace(/^(Persistent|Attached):\s*/i, '').trim();
  }
}
