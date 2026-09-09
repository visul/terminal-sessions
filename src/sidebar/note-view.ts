import * as vscode from 'vscode';
import { SessionIndex } from '../session-manager';
import { NoteStore, noteKey } from '../notes';
import { NOTE_MARK } from './items';
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
  /** `<wsHash>/<sessionName>` of the session being shown, '' when there is none.
   *  Echoed back with every edit so a late flush lands on the right note. */
  key: string;
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

  /** Keys this view has rendered. An incoming edit is accepted only for one of
   *  these, so a late flush can be honoured while nothing else can be written. */
  private readonly postedKeys = new Set<string>();

  /** When this host's textarea last took focus. Two visible hosts show the same
   *  note, so "which one do I focus" is decided by where the user was typing,
   *  not by which view id sorts first. */
  private focusedAt = 0;

  /** Tells the webview to throw away an edit it is still holding for a note
   *  that has since been deleted (by the delete command, or by a Kill that
   *  removed the session). Without it the pending flush recreates the note. */
  discard(key: string): void {
    if (!this.postedKeys.has(key)) return;
    void this.view?.webview.postMessage({ type: 'discard', key });
  }

  get lastFocusedAt(): number { return this.focusedAt; }

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
    view.webview.onDidReceiveMessage((msg: { type: string; text?: string; key?: string }) => {
      const t = this.controller.target;
      switch (msg.type) {
        case 'ready':
          this.post();
          break;
        case 'edit': {
          // The edit carries the key it was TYPED under, not the key that is
          // current now. A debounced (or blur) flush can land after the active
          // terminal changed or a different note was pinned; writing it to
          // whatever the target happens to be by then would file the text under
          // the wrong session. Only keys this view has actually shown are
          // accepted, so a stray message can't invent a note.
          if (typeof msg.text !== 'string' || !msg.key || !this.postedKeys.has(msg.key)) break;
          const slash = msg.key.indexOf('/');
          if (slash <= 0) break;
          this.store.set(msg.key.slice(0, slash), msg.key.slice(slash + 1), msg.text);
          // Repaint: if the target moved on while that edit was in flight, the
          // textarea is still showing the old session's text.
          this.post();
          break;
        }
        case 'focus':
          this.focusedAt = Date.now();
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
    view.onDidChangeVisibility(() => {
      if (view.visible) { this.post(); return; }
      // Going hidden. A collapsed webview does not reliably fire blur or
      // visibilitychange inside the iframe, so ask it directly rather than
      // hoping; retainContextWhenHidden keeps it alive to answer.
      void view.webview.postMessage({ type: 'flush' });
    });
    view.onDidDispose(() => { this.view = undefined; });
    this.post();
  }

  /** Push the current target + note text into the webview. Cheap enough to
   *  call on every store/controller event; the webview ignores text updates
   *  while the user is mid-keystroke. */
  post(): void {
    if (!this.view) return;
    // Another window may have rewritten this note since the last event; a
    // reload here also fires onDidChange, which is what repaints the peer view.
    this.store.reloadIfChanged();
    const t = this.controller.target;
    const note = t ? this.store.get(t.workspaceHash, t.sessionName) : undefined;
    const key = t ? noteKey(t.workspaceHash, t.sessionName) : '';
    if (key) this.postedKeys.add(key);
    const state: NoteViewState = {
      key,
      hasTarget: !!t,
      title: t ? t.label : '',
      subtitle: t?.workspaceLabel || '',
      text: note?.text || '',
      pinned: this.controller.pinned,
      hasNote: !!note,
      saved: note ? `saved ${humanAge(new Date(note.updatedAt))}` : '',
    };
    void this.view.webview.postMessage({ type: 'state', state });
    // Same signal as the tree's ✎ marker, carried by the host chrome so a note
    // is visible from the panel without leaving the Terminal tab.
    //
    // The title, NOT WebviewView.badge. A panel container holding one view
    // takes its tab label from that view's title, so this reaches the tab; the
    // badge does too, but it cannot be turned off. VS Code's WebviewViewPane
    // has `if (changed && (this.badge = e, e)) { …register activity… }` — a
    // clear updates the field, short-circuits on the falsy value, and never
    // disposes the activity that draws the badge. (The ordinary ViewPane in the
    // same bundle has the `else this._activity.clear()` this one is missing.)
    // So an emptied note kept showing its badge forever.
    try {
      this.view.title = note ? `${NOTE_VIEW_TITLE} ${NOTE_MARK}` : NOTE_VIEW_TITLE;
      this.view.description = t ? t.label : undefined;
    } catch { /* view disposed between the guard above and here */ }
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
  // Which note the textarea is showing, and which one the pending edit was
  // typed into. They differ exactly when the target moved while typing, which
  // is the case the key has to survive.
  let currentKey = '';
  let pendingKey = '';

  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    vscodeApi.postMessage({ type: 'edit', key: pendingKey, text: ta.value });
  }

  ta.addEventListener('input', () => {
    dirty = true;
    pendingKey = currentKey;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
  ta.addEventListener('focus', () => vscodeApi.postMessage({ type: 'focus' }));
  ta.addEventListener('blur', flush);
  window.addEventListener('blur', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  pinBtn.addEventListener('click', () => { flush(); vscodeApi.postMessage({ type: 'unpin' }); });
  // Clicking the button blurs the textarea first, so the blur listener already
  // flushes — but be explicit rather than relying on focus ordering.
  delBtn.addEventListener('click', () => { flush(); vscodeApi.postMessage({ type: 'delete' }); });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'flush') { flush(); return; }
    if (m.type === 'discard') {
      // The note this buffer belongs to was deleted. Saving it now would bring
      // it back, so drop it instead of racing the deletion.
      if (m.key === pendingKey || m.key === currentKey) { clearTimeout(timer); dirty = false; }
      return;
    }
    if (m.type !== 'state') return;
    const s = m.state;
    // Target changed: whatever is half-typed belongs to the PREVIOUS note, so
    // send it there before the textarea is repointed.
    const switching = s.key !== currentKey;
    if (switching) flush();
    currentKey = s.key;
    document.body.classList.toggle('no-target', !s.hasTarget);
    titleEl.textContent = s.title;
    subEl.textContent = s.subtitle;
    savedEl.textContent = s.saved;
    pinBtn.style.display = s.pinned ? '' : 'none';
    pinBtn.classList.toggle('on', s.pinned);
    delBtn.style.display = s.hasNote ? '' : 'none';
    // Never clobber typing in the host the user is actually in. The OTHER host
    // (both can be open at once, showing the same note) takes the update and
    // abandons its own stale buffer — its textarea lost focus when the user
    // moved away, which already flushed whatever was worth keeping.
    const typingHere = dirty && document.hasFocus() && document.activeElement === ta;
    if ((switching || !typingHere) && ta.value !== s.text) {
      clearTimeout(timer);
      dirty = false;
      ta.value = s.text;
    }
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

/** Base title of both hosts, kept in step with the `name` in package.json.
 *  Set explicitly (rather than left to the manifest) because the ✎ marker is
 *  appended to it, so it has to be removable again. */
const NOTE_VIEW_TITLE = 'Terminal Session Note';

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
    // Killing or deleting a session removes its note from inside SessionIndex,
    // which has no way to reach the editor. Follow the store instead, so a pin
    // on a session that just went away reverts to "no session selected".
    store.onDidRemove(({ workspaceHash, sessionName }) => {
      const key = noteKey(workspaceHash, sessionName);
      sidebarView.discard(key);
      panelView.discard(key);
      controller.forget(workspaceHash, sessionName);
    }),
    controller,
  );

  // Both hosts can be open at once showing the same note, so "which one do I
  // focus" is decided by where the user was last typing, then by what is on
  // screen, and only then by the Explorer default (the panel container may
  // never have been opened at all).
  const focusView = (): void => {
    const candidates: Array<[string, NoteWebviewProvider]> = [
      [NOTE_VIEW_ID, sidebarView],
      [NOTE_PANEL_VIEW_ID, panelView],
    ];
    const visible = candidates.filter(([, v]) => v.isVisible);
    const pool = visible.length > 0 ? visible : candidates;
    const best = pool.reduce((a, b) => (b[1].lastFocusedAt > a[1].lastFocusedAt ? b : a));
    void vscode.commands.executeCommand(`${best[0]}.focus`);
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
      // Unpinning is handled by the onDidRemove subscription above, which also
      // covers the Kill/Delete path that never reaches this command.
      store.remove(c.workspaceHash, c.sessionName);
    }),
  );

  return controller;
}
