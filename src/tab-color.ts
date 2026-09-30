// Coloured tab NAME alongside the `${progress}` mark written by tab-state.ts,
// following the same decision and the same clearing: magenta while the agent
// works (the spinner), green once it handed control back (finished, blocked
// on a prompt, or failed). Not yellow: that is VS Code's own ⚠ colour.
//
// The tab's icon and colour cannot be changed once the tab exists, but the
// tab list draws each terminal's label through the file-decorations service
// (`vscode-terminal:/<workspace>/<instanceId>`), and an extension's
// FileDecorationProvider is asked for those URIs like any other. Its colour
// tints the label text only, so an icon or colour the user picked stays.
// Extension decorations outweigh VS Code's own, so on a tab with the ⚠
// "relaunch needed" status the name (and the ⚠) take this colour instead
// of yellow; the ⚠ itself stays.
//
// The URI names the tab by its instance id alone: the title fragment is
// computed before the tab has a title, so it is always empty, and the
// extension API never exposes instance ids. Ids are handed out in creation
// order, the same order `window.terminals` lists terminals in, so once every
// open terminal's id has been seen, the n-th smallest id is the n-th
// terminal. Until then (or while a hidden terminal never shows up in a
// list) nothing is painted: an uncoloured tab beats a wrong one.
//
// One case breaks the order: an extension-host restart inside the same
// window (Restart Extensions after an update). The new host lists the
// terminals that already exist by tab-list layout, not by id, so a dragged
// tab would shift every rank. Those terminals (and all of them when some
// sit in the editor area, which the host lists after the panel) are never
// painted; they hold the smallest ids, so terminals opened afterwards still
// map by rank. A window reload creates every terminal anew, in list order,
// and is safe. The restart is recognised by `env.sessionId`, which survives
// a host restart but not a reload. The ids live in workspace state (one
// window per workspace, so no two windows rewrite the same list) with the
// time each was last active, and are kept for two weeks.
//
// Also accepted: the tab list asks only for the rows it has drawn. A
// terminal that is never drawn (scrolled out of a long tab list, or hidden
// from the user) never reports its id, and until it does nothing is
// painted, because a missing id would shift every later rank.

import * as vscode from 'vscode';

const TERMINAL_SCHEME = 'vscode-terminal';
const COLORS = {
  working: new vscode.ThemeColor('terminal.ansiMagenta'),
  turn: new vscode.ThemeColor('terminal.ansiGreen'),
} as const;
const TOOLTIPS = {
  working: 'Agent working',
  done: 'Agent finished: your turn',
  waiting: 'Agent is waiting for you',
  failed: 'Agent turn failed: your turn',
} as const;
/** Coalesces the re-query once the id set becomes complete. */
const REFIRE_MS = 200;
/** Window sessions this extension has already started in (newest first). */
const SESSIONS_KEY = 'tabColorSessions-v2';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type TabColorKind = keyof typeof COLORS;
export interface MarkedTab {
  term: vscode.Terminal;
  kind: TabColorKind;
  /** What the hover says; green covers finished, blocked and failed alike. */
  why: keyof typeof TOOLTIPS;
}

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
  /** Set once more ids than terminals were seen: an unlisted tab is in the
   *  set, so even a later equal count would shift every rank. */
  private overflowed = false;
  /** Terminals whose place in `window.terminals` does not follow their id
   *  (they predate an extension-host restart); never painted. */
  private readonly unordered = new Set<vscode.Terminal>();
  private refire?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(state: vscode.Memento) {
    const now = Date.now();
    const seen = state.get<Record<string, number>>(SESSIONS_KEY) ?? {};
    const sessionId = vscode.env.sessionId;
    const hostRestart = sessionId in seen;
    const kept: Record<string, number> = { [sessionId]: now };
    for (const [id, at] of Object.entries(seen)) if (now - at < SESSION_TTL_MS && id !== sessionId) kept[id] = at;
    void state.update(SESSIONS_KEY, kept);
    const inEditors = vscode.window.tabGroups.all
      .some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTerminal));
    if (hostRestart || inEditors) for (const t of vscode.window.terminals) this.unordered.add(t);
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      // A closed terminal leaves its id behind with no way to tell which one
      // it was: start over, every rendered tab is asked again.
      vscode.window.onDidCloseTerminal(t => {
        this.unordered.delete(t);
        this.ids.clear();
        this.overflowed = false;
        this.emitter.fire(undefined);
      }),
    );
  }

  /** The sessions to paint, keyed by tmux session name. Repaints only when
   *  the set (or the tab or colour behind one of them) actually changed. */
  set(next: Map<string, MarkedTab>): void {
    const same = next.size === this.marked.size
      && Array.from(next).every(([k, v]) => {
        const had = this.marked.get(k);
        return had?.term === v.term && had.kind === v.kind && had.why === v.why;
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
    // More ids than terminals: a tab the API does not list (or an id the
    // close hook missed). The ranks cannot be trusted; paint nothing until
    // the next close starts over. Never re-query from here: the same URIs
    // would overflow again on every round.
    if (this.ids.size > terms.length) this.overflowed = true;
    if (this.overflowed || this.ids.size < terms.length) return undefined;
    // Just became complete: the tabs asked before this one got nothing.
    if (grew) this.scheduleRefire();
    if (this.marked.size === 0) return undefined;
    const rank = Array.from(this.ids).sort((a, b) => a - b).indexOf(id);
    // The oldest ids are the unordered terminals, listed first.
    if (rank < this.unordered.size) return undefined;
    const term = terms[rank];
    if (this.unordered.has(term)) return undefined;
    for (const m of this.marked.values()) {
      if (m.term === term) return { color: COLORS[m.kind], tooltip: TOOLTIPS[m.why] };
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
