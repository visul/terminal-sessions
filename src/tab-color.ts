// Coloured tab NAME alongside the `${progress}` mark written by tab-state.ts,
// following the same decision and the same clearing: magenta while the agent
// works (the spinner), green once it handed control back (finished, blocked
// on a prompt, or failed). Not yellow: that is VS Code's own ⚠ colour.
//
// The tab's icon and colour cannot be changed once the tab exists, but the
// tab list draws each terminal's label through the file-decorations service
// (`vscode-terminal:/<workspace>/<instanceId>`), and an extension's
// FileDecorationProvider is asked for those URIs like any other. Its colour
// tints the label text only, so an icon or colour the user picked stays. A
// status VS Code puts on the tab itself (the yellow ⚠ "relaunch needed")
// wins over it.
//
// The URI names the tab by its instance id alone: the title fragment is
// computed before the tab has a title, so it is always empty, and the
// extension API never exposes instance ids. Ids are handed out in creation
// order, the same order `window.terminals` lists terminals in, so once every
// open terminal's id has been seen, the n-th smallest id is the n-th
// terminal. Until then (or while a hidden terminal never shows up in a
// list) nothing is painted: an uncoloured tab beats a wrong one.

import * as vscode from 'vscode';

const TERMINAL_SCHEME = 'vscode-terminal';
const COLORS = {
  working: new vscode.ThemeColor('terminal.ansiMagenta'),
  turn: new vscode.ThemeColor('terminal.ansiGreen'),
} as const;
const TOOLTIPS = { working: 'Agent working', turn: 'Agent finished: your turn' } as const;
/** Coalesces the re-query once the id set becomes complete. */
const REFIRE_MS = 200;

export type TabColorKind = keyof typeof COLORS;
export interface MarkedTab { term: vscode.Terminal; kind: TabColorKind }

function instanceIdOf(uri: vscode.Uri): number | undefined {
  const last = uri.path.split('/').pop() ?? '';
  const id = Number.parseInt(last, 10);
  return Number.isFinite(id) && String(id) === last ? id : undefined;
}

export class TabColorDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private marked = new Map<string, MarkedTab>();
  /** Instance ids seen in decoration requests since the last terminal closed. */
  private readonly ids = new Set<number>();
  private refire?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      // A closed terminal leaves its id behind with no way to tell which one
      // it was: start over, every rendered tab is asked again.
      vscode.window.onDidCloseTerminal(() => { this.ids.clear(); this.emitter.fire(undefined); }),
    );
  }

  /** The sessions to paint, keyed by tmux session name. Repaints only when
   *  the set (or the tab or colour behind one of them) actually changed. */
  set(next: Map<string, MarkedTab>): void {
    const same = next.size === this.marked.size
      && Array.from(next).every(([k, v]) => {
        const had = this.marked.get(k);
        return had?.term === v.term && had.kind === v.kind;
      });
    this.marked = next;
    if (!same) this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TERMINAL_SCHEME) return undefined;
    const id = instanceIdOf(uri);
    if (id === undefined) return undefined;
    const grew = !this.ids.has(id);
    this.ids.add(id);
    const terms = vscode.window.terminals;
    if (this.ids.size > terms.length) {
      // Stale ids (should not happen with the close hook): rebuild.
      this.ids.clear();
      this.scheduleRefire();
      return undefined;
    }
    if (this.ids.size < terms.length) return undefined;
    // Just became complete: the tabs asked before this one got nothing.
    if (grew) this.scheduleRefire();
    if (this.marked.size === 0) return undefined;
    const rank = Array.from(this.ids).sort((a, b) => a - b).indexOf(id);
    const term = terms[rank];
    for (const m of this.marked.values()) {
      if (m.term === term) return { color: COLORS[m.kind], tooltip: TOOLTIPS[m.kind] };
    }
    return undefined;
  }

  private scheduleRefire(): void {
    if (this.refire) return;
    this.refire = setTimeout(() => { this.refire = undefined; this.emitter.fire(undefined); }, REFIRE_MS);
  }

  dispose(): void {
    if (this.refire) clearTimeout(this.refire);
    this.marked.clear();
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}
