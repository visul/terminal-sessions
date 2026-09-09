import * as vscode from 'vscode';
import { SessionIndex } from '../session-manager';
import { NoteStore } from '../notes';
import { getConfig } from '../config';
import { parseSessionName } from '../workspace-id';
import { humanAge } from '../util';

/** Which session's note the editor is showing. */
export interface NoteTarget {
  workspaceHash: string;
  sessionName: string;
  /** Session label ("main", "#3") — display only. */
  label: string;
  /** Workspace folder name — display only. */
  workspaceLabel: string;
}

/**
 * Shared state behind BOTH note views (the Explorer one and the panel one).
 *
 * Default behaviour is to follow the active terminal, so the note you see is
 * the note for the session you're typing in. Clicking a row in the Notes
 * folder PINS a target instead, which is what lets you read the note of a
 * stopped session without starting it or opening a tab for it.
 */
export class NoteViewController {
  private followed: NoteTarget | undefined;
  private pinnedTarget: NoteTarget | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly index: SessionIndex) {}

  /** Resolve a tmux session name into a display target. Returns undefined for
   *  names that don't parse as ours (a plain terminal, or a foreign prefix). */
  resolve(sessionName: string | undefined): NoteTarget | undefined {
    if (!sessionName) return undefined;
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (!parsed) return undefined;
    return this.resolveKnown(parsed.hash, sessionName);
  }

  resolveKnown(workspaceHash: string, sessionName: string): NoteTarget {
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    return {
      workspaceHash,
      sessionName,
      label: this.index.getSessionLabel(workspaceHash, sessionName)
        || (parsed ? `#${parsed.tabId}` : sessionName),
      workspaceLabel: this.index.getWorkspace(workspaceHash)?.label || '',
    };
  }

  /** Re-resolves the display fields on every read so a session renamed while
   *  its note is open shows the new name without any extra plumbing. */
  get target(): NoteTarget | undefined {
    const t = this.pinnedTarget ?? this.followed;
    return t ? this.resolveKnown(t.workspaceHash, t.sessionName) : undefined;
  }

  get pinned(): boolean {
    return this.pinnedTarget !== undefined;
  }

  /** Called on every active-terminal switch. Ignored while pinned (the pin is
   *  an explicit "stay here" and must survive tab switching). */
  setFollowed(sessionName: string | undefined): void {
    const next = this.resolve(sessionName);
    if (next?.sessionName === this.followed?.sessionName
      && next?.label === this.followed?.label) return;
    this.followed = next;
    if (!this.pinnedTarget) this._onDidChange.fire();
  }

  pin(workspaceHash: string, sessionName: string): void {
    this.pinnedTarget = this.resolveKnown(workspaceHash, sessionName);
    this._onDidChange.fire();
  }

  unpin(): void {
    if (!this.pinnedTarget) return;
    this.pinnedTarget = undefined;
    this._onDidChange.fire();
  }

  /** Drop a pin that points at a session that no longer has a note (deleted or
   *  killed) so the editor doesn't sit on a ghost. */
  forget(workspaceHash: string, sessionName: string): void {
    if (this.pinnedTarget?.workspaceHash === workspaceHash
      && this.pinnedTarget?.sessionName === sessionName) {
      this.pinnedTarget = undefined;
      this._onDidChange.fire();
    }
  }

  dispose(): void { this._onDidChange.dispose(); }
}

interface NoteViewState {
  hasTarget: boolean;
  title: string;
  subtitle: string;
  text: string;
  pinned: boolean;
  saved: string;
  hasNote: boolean;
}

/**
 * The note editor itself. One instance per host view (Explorer + panel); both
 * read and write the same NoteStore through the same controller, so an edit in
 * one shows up in the other as soon as the debounce lands.
 */
export class NoteWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  /** Whether this host is currently on screen — decides which of the two the
   *  "open note" command focuses. */
  get isVisible(): boolean { return this.view?.visible === true; }

  constructor(
    private readonly controller: NoteViewController,
    private readonly store: NoteStore,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
      const t = this.controller.target;
      switch (msg.type) {
        case 'ready':
          this.post();
          break;
        case 'edit':
          if (t && typeof msg.text === 'string') {
            this.store.set(t.workspaceHash, t.sessionName, msg.text);
          }
          break;
        case 'unpin':
          this.controller.unpin();
          break;
        case 'delete':
          if (t) void vscode.commands.executeCommand('terminalSessions.deleteNote', {
            workspaceHash: t.workspaceHash, sessionName: t.sessionName,
          });
          break;
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    view.onDidDispose(() => { this.view = undefined; });
    this.post();
  }

  /** Push the current target + note text into the webview. Cheap enough to
   *  call on every store/controller event; the webview ignores text updates
   *  while the user is mid-keystroke. */
  post(): void {
    if (!this.view) return;
    const t = this.controller.target;
    const note = t ? this.store.get(t.workspaceHash, t.sessionName) : undefined;
    const state: NoteViewState = {
      hasTarget: !!t,
      title: t ? t.label : '',
      subtitle: t?.workspaceLabel || '',
      text: note?.text || '',
      pinned: this.controller.pinned,
      hasNote: !!note,
      saved: note ? `saved ${humanAge(new Date(note.updatedAt))}` : '',
    };
    void this.view.webview.postMessage({ type: 'state', state });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  header {
    display: flex; align-items: baseline; gap: 6px;
    padding: 6px 8px 4px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  #title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #subtitle {
    color: var(--vscode-descriptionForeground); font-size: 0.9em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto;
  }
  .actions { display: flex; gap: 4px; flex: 0 0 auto; }
  button {
    background: transparent; border: 1px solid transparent; border-radius: 3px;
    color: var(--vscode-descriptionForeground); cursor: pointer;
    font-family: inherit; font-size: 0.85em; padding: 1px 6px;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  button.on { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }
  textarea {
    flex: 1 1 auto; resize: none; border: none; outline: none;
    padding: 8px; box-sizing: border-box;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.45;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background, var(--vscode-sideBar-background));
  }
  footer {
    flex: 0 0 auto; padding: 3px 8px 5px; text-align: right;
    color: var(--vscode-descriptionForeground); font-size: 0.85em; min-height: 1em;
  }
  #empty {
    flex: 1 1 auto; display: none; align-items: center; justify-content: center;
    padding: 16px; text-align: center; color: var(--vscode-descriptionForeground);
  }
  body.no-target header, body.no-target textarea, body.no-target footer { display: none; }
  body.no-target #empty { display: flex; }
</style>
</head>
<body class="no-target">
  <header>
    <span id="title"></span>
    <span id="subtitle"></span>
    <span class="actions">
      <button id="pin" title="Pinned to this session. Click to follow the active terminal again.">pinned</button>
      <button id="del" title="Delete this note">delete</button>
    </span>
  </header>
  <textarea id="text" spellcheck="false" placeholder="Notes for this session…"></textarea>
  <footer id="saved"></footer>
  <div id="empty">No session selected.<br>Focus a persistent terminal, or click a note in the Terminal Sessions view.</div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const ta = document.getElementById('text');
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('subtitle');
  const savedEl = document.getElementById('saved');
  const pinBtn = document.getElementById('pin');
  const delBtn = document.getElementById('del');
  let timer;
  // True between a keystroke and the save that follows it. While set, an
  // incoming state must not overwrite what is being typed.
  let dirty = false;

  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    vscodeApi.postMessage({ type: 'edit', text: ta.value });
  }

  ta.addEventListener('input', () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
  ta.addEventListener('blur', flush);
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  pinBtn.addEventListener('click', () => { flush(); vscodeApi.postMessage({ type: 'unpin' }); });
  delBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'delete' }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'state') return;
    const s = m.state;
    document.body.classList.toggle('no-target', !s.hasTarget);
    titleEl.textContent = s.title;
    subEl.textContent = s.subtitle;
    savedEl.textContent = s.saved;
    pinBtn.style.display = s.pinned ? '' : 'none';
    pinBtn.classList.toggle('on', s.pinned);
    delBtn.style.display = s.hasNote ? '' : 'none';
    if (!dirty && ta.value !== s.text) ta.value = s.text;
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

/** View ids of the two hosts the same editor is contributed to: one under the
 *  session tree in the Explorer, one as its own tab in the bottom panel. */
export const NOTE_VIEW_ID = 'terminalSessions.note';
export const NOTE_PANEL_VIEW_ID = 'terminalSessions.notePanel';

/** Coordinates accepted by the note commands. Tree items carry them as their
 *  own fields, so a raw object and a clicked row are handled the same way. */
interface NoteCoords { workspaceHash: string; sessionName: string }

function coordsOf(arg: unknown): NoteCoords | undefined {
  const a = arg as { workspaceHash?: string; sessionName?: string; session?: { workspaceHash?: string; name?: string }; row?: { session?: { workspaceHash?: string; name?: string } } } | undefined;
  if (!a) return undefined;
  if (a.workspaceHash && a.sessionName) return { workspaceHash: a.workspaceHash, sessionName: a.sessionName };
  // SessionTreeItem
  if (a.session?.workspaceHash && a.session?.name) {
    return { workspaceHash: a.session.workspaceHash, sessionName: a.session.name };
  }
  // NoteTreeItem
  if (a.row?.session?.workspaceHash && a.row?.session?.name) {
    return { workspaceHash: a.row.session.workspaceHash, sessionName: a.row.session.name };
  }
  return undefined;
}

/**
 * Wires the note editor: one controller, two webview hosts, three commands.
 * Called from activate() after the note store exists.
 */
export function registerNoteViews(
  ctx: vscode.ExtensionContext,
  index: SessionIndex,
  store: NoteStore,
): NoteViewController {
  const controller = new NoteViewController(index);
  const sidebarView = new NoteWebviewProvider(controller, store);
  const panelView = new NoteWebviewProvider(controller, store);
  const push = (): void => { sidebarView.post(); panelView.post(); };

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NOTE_VIEW_ID, sidebarView,
      { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(NOTE_PANEL_VIEW_ID, panelView,
      { webviewOptions: { retainContextWhenHidden: true } }),
    controller.onDidChange(push),
    store.onDidChange(push),
    controller,
  );

  // Focus whichever host is already on screen; fall back to the Explorer one so
  // a click from the tree always lands somewhere visible.
  const focusView = (): void => {
    const id = panelView.isVisible && !sidebarView.isVisible ? NOTE_PANEL_VIEW_ID : NOTE_VIEW_ID;
    void vscode.commands.executeCommand(`${id}.focus`);
  };

  const open = (arg: unknown): void => {
    const c = coordsOf(arg);
    // Pin only when a specific session was named. Without one (palette), the
    // editor keeps following the active terminal and we just reveal it.
    if (c) controller.pin(c.workspaceHash, c.sessionName);
    focusView();
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('terminalSessions.openNote', open),
    vscode.commands.registerCommand('terminalSessions.editNote', open),
    vscode.commands.registerCommand('terminalSessions.deleteNote', async (arg: unknown) => {
      const c = coordsOf(arg) ?? (controller.target
        ? { workspaceHash: controller.target.workspaceHash, sessionName: controller.target.sessionName }
        : undefined);
      if (!c) return;
      const note = store.get(c.workspaceHash, c.sessionName);
      if (!note) return;
      const label = index.getSessionLabel(c.workspaceHash, c.sessionName) || c.sessionName;
      // Hand-written text with no undo anywhere — always confirm.
      const yes = await vscode.window.showWarningMessage(
        `Delete the note for "${label}"?`,
        { modal: true, detail: note.text.length > 300 ? `${note.text.slice(0, 300)}…` : note.text },
        'Delete Note',
      );
      if (yes !== 'Delete Note') return;
      store.remove(c.workspaceHash, c.sessionName);
      controller.forget(c.workspaceHash, c.sessionName);
    }),
  );

  return controller;
}
