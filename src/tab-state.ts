// Agent state on the NATIVE terminal tab (the tab list VS Code renders, not our
// sidebar). VS Code owns the tab icon and color: `TerminalOptions.iconPath`/`color`
// apply at creation only, `Terminal.creationOptions` is readonly, and the internal
// `changeIcon(icon)` is never reachable with an argument (both the `changeIcon` and
// `changeIconActiveTab` commands drop it and open the picker). Status entries —
// the yellow ⚠ that replaces a tab's icon — are internal to VS Code too.
//
// What IS reachable: the tab DESCRIPTION template. `terminal.integrated.tabs.description`
// expands `${sequence}`, the title an application inside the terminal sets with an
// OSC 2 escape sequence. So a short state string written into the pane reaches the
// tab row. The title template can't be used: our terminals are created with a `name`,
// which VS Code treats as a static title that bypasses the template entirely.
//
// The write goes to the ACTIVE pane's tty wrapped in tmux passthrough (DCS tmux; …),
// so tmux forwards it verbatim to the attached client instead of eating it. Claude's
// own OSC titles stay inside tmux (we never turn `set-titles` on), so nothing fights
// over the string.
//
// Cost per tick: one `tmux list-panes -a` (session list + tty in one spawn) and a
// ~30-byte write per session whose text actually changed.
//
// Known, accepted: a second writer on the pane's pty can land between two writes
// of the pane's own program, inside one of its escape sequences, which tmux then
// aborts (a stray fragment during a heavy TUI redraw). Rare — we write only when
// the text changes — and the alternative, writing to the client tty, interleaves
// with tmux's own buffered output instead, which is worse.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig, type TabStateStyle, type TabStateClear } from './config';
import * as tmuxMod from './tmux';
import { findTerminalForSession, sessionNameForTerminal } from './profile-provider';
import { parseSessionName } from './workspace-id';
import type { ClaudeTracker, ClaudeSnapshot } from './claude-tracker';
import { outcomeIsBad } from './outcome';

const execFileP = promisify(execFile);

/** State glyphs, one set per `terminalSessions.tabStateStyle`. Plain text, no
 *  codicon markup: the description is rendered as a label, and an unsupported
 *  `$(name)` would show up as literal text. Coloured sets are the default because
 *  the description is drawn in a dim grey, where a thin outline glyph disappears;
 *  `glyphs` is there for anyone who wants the row monochrome. */
export interface StateSymbols { working: string; waiting: string; done: string; failed: string }

// The coloured sets answer ONE question — is this tab my turn? — with two marks:
// green once the agent has handed control back (finished, blocked on a prompt, or
// failed; the age tells them apart) and a dark dot while it is still working, so a
// busy column stays quiet and only the green ones pull the eye. The monochrome and
// word sets keep a mark per state for anyone who wants the detail on the tab.
export const STYLES: Record<TabStateStyle, StateSymbols> = {
  blue: { working: '🔵', waiting: '🟢', done: '🟢', failed: '🟢' },
  dark: { working: '⚫', waiting: '🟢', done: '🟢', failed: '🟢' },
  glyphs: { working: '⟳', waiting: '⚠', done: '✓', failed: '✗' },
  words: { working: 'running', waiting: 'needs you', done: 'done', failed: 'failed' },
};

/** Default set, kept as a named export for callers that don't care about style. */
export const SYM = STYLES.blue;

/** A finished session stops being "recent" after this long and its text clears. */
const DONE_TTL_MS = 30 * 60 * 1000;
/** Max characters written into the description (it is truncated by the tab width). */
const MAX_TEXT = 24;
/** Relative-clock refresh. Text only ever changes at minute granularity. */
const TICK_MS = 15_000;
/** After a failed write to a pane's tty, skip that session for a while. */
const RETRY_AFTER_MS = 60_000;
/** Every tmux call is bounded: a hung server must not latch the tick. */
const TMUX_TIMEOUT_MS = 5_000;
/** A positive passthrough answer is re-asked this often — a config reload can
 *  turn it off under us without the server going away. */
const PASSTHROUGH_TTL_MS = 5 * 60_000;

const TEMPLATE_KEY = 'tabStateTemplateAsked-v1';
const PASSTHROUGH_KEY = 'tabStatePassthroughWarned-v1';
const DESCRIPTION_SETTING = 'terminal.integrated.tabs.description';
const SEQ_VAR = '${sequence}';

/** Coarse age: nothing under a minute (the glyph alone reads as "just now"). */
export function shortAge(ms: number): string {
  if (ms < 60_000) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The string for one session. Deliberately asymmetric: a RUNNING agent gets no
 * clock (the sidebar already times it, and a number that changes every minute on
 * every tab is noise), while everything the user might have to come back to —
 * finished, blocked on a question, failed — carries how long it has been that way.
 */
export function formatTabState(
  snap: ClaudeSnapshot | undefined,
  now = Date.now(),
  style: TabStateStyle = 'blue',
  clear: TabStateClear = 'seen',
): string {
  if (!snap) return '';
  const SYM = STYLES[style] ?? STYLES.blue;
  switch (snap.state) {
    case 'working':
    case 'tool':
      return SYM.working;
    case 'waiting': {
      // Grows without limit on purpose: an agent blocked on a permission prompt
      // for an hour is exactly what this feature exists to surface.
      const age = snap.waitingSince ? shortAge(now - snap.waitingSince.getTime()) : '';
      return age ? `${SYM.waiting} ${age}` : SYM.waiting;
    }
    case 'idle': {
      const at = snap.lastStopAt?.getTime();
      if (!at) return '';
      // Relaunched since that stop (Start on a stopped row, `--resume` in a new
      // tab): the green belongs to the previous run, and this one has not
      // finished anything yet.
      if (snap.lastStartAt && snap.lastStartAt.getTime() > at) return '';
      const dt = now - at;
      if (dt < 0) return '';
      // 'seen': every finish gets the mark, even one you watched — the tab then
      // reads "done 2m ago" — and it leaves on your next visit to that terminal
      // after the finish (or Dismiss), however long that takes. The sidebar's
      // unread marker is stricter (never set for a watched finish); using it
      // here made a turn that ended under your eyes never show green at all.
      // 'timer': 30 minutes after it finished, looked or not.
      if (clear === 'seen') {
        if (snap.dismissed) return '';
        if (snap.tabSeenAt && snap.tabSeenAt.getTime() >= at) return '';
      } else if (dt > DONE_TTL_MS) {
        return '';
      }
      const sym = outcomeIsBad(snap.outcome) ? SYM.failed : SYM.done;
      const age = shortAge(dt);
      return age ? `${sym} ${age}` : sym;
    }
    default:
      return '';
  }
}

/** OSC 2 (window title) wrapped in tmux passthrough. Every ESC in the payload is
 *  doubled - that is how tmux knows which bytes to forward verbatim. */
export function titleSequence(text: string): string {
  // Strip C0/DEL so a stray byte can never close the sequence early.
  // eslint-disable-next-line no-control-regex
  // A blank title is not "no text" to VS Code: it resets the tab label to the
  // process name ("tmux"), throwing away the name the extension gave the tab.
  // One space is invisible in the description and keeps the label intact.
  const safe = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_TEXT) || ' ';
  const osc = `\x1b]2;${safe}\x07`;
  return `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

interface PaneRow { session: string; tty: string; attached: boolean }

/** Active pane (of the active window) per tmux session — the only pane whose
 *  passthrough output tmux forwards to the attached client. `attached` says a
 *  client exists to receive it at all. */
export async function activePanes(tmux: string, prefix: string): Promise<PaneRow[]> {
  // Session name LAST: a `|` inside a renamed session can't shift the columns.
  const fmt = '#{pane_tty}|#{window_active}|#{pane_active}|#{session_attached}|#{session_name}';
  const { stdout } = await execFileP(tmux, ['list-panes', '-a', '-F', fmt], { timeout: TMUX_TIMEOUT_MS });
  const rows: PaneRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [tty, win, pane, attached, ...rest] = line.split('|');
    const session = rest.join('|');
    if (!session || !tty) continue;
    if (win !== '1' || pane !== '1') continue;
    if (!parseSessionName(session, prefix)) continue;
    rows.push({ session, tty, attached: (parseInt(attached, 10) || 0) > 0 });
  }
  return rows;
}

class TabStateWriter {
  private readonly last = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private running = false;
  /** A change event landed while a tick was in flight; run once more after it. */
  private pending = false;
  /** Set only by a real "on"/"all" answer from a running server. */
  private passthroughOk = false;
  private passthroughCheckedAt = 0;
  /** Feature off: the previous extension host may have left marks on the tabs
   *  of this window (host restart keeps terminals alive). Blank them once. */
  private blankedOnce = false;
  private disposed = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly tracker: ClaudeTracker,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Agent events already stream in for the sidebar; piggyback on them so a
    // finished turn shows up immediately instead of on the next clock tick.
    this.ctx.subscriptions.push(this.tracker.onChange(() => this.schedule()));
    // A recreated VS Code terminal (re-attach, Restart, window reload) starts
    // with no sequence title, and tmux does not replay passthrough on attach:
    // forget what we wrote so the next tick paints it again.
    this.ctx.subscriptions.push(vscode.window.onDidOpenTerminal(t => {
      const name = sessionNameForTerminal(t);
      if (name) this.last.delete(name); else this.last.clear();
      this.schedule();
    }));
    void this.tick();
  }

  /** Force a redraw now (an option changed under us). */
  refreshNow(): void { this.schedule(); }

  private schedule(): void {
    if (this.disposed) return;
    if (this.running) { this.pending = true; return; }
    if (this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.tick(); }, 500);
  }

  private async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      const cfg = getConfig();
      if (cfg.tabStateText !== 'on') {
        await this.clearAll();
        if (!this.blankedOnce) { this.blankedOnce = true; await this.blankThisWindow(cfg.tmuxPath, cfg.sessionPrefix); }
        return;
      }
      const tmux = await tmuxMod.detectTmuxPath(cfg.tmuxPath);
      if (!tmux || this.disposed) return;
      if (!(await this.checkPassthrough(tmux)) || this.disposed) return;
      // No `${sequence}` in the user's template means nothing we write can be
      // seen — so write nothing. (Re-read every tick: adding it by hand starts
      // the text flowing without a reload.)
      if (!templateShowsSequence()) { await this.clearAll(); return; }
      let panes: PaneRow[] = [];
      try { panes = await activePanes(tmux, cfg.sessionPrefix); }
      catch { this.last.clear(); this.passthroughOk = false; return; } // server gone: re-ask everything
      if (this.disposed) return;
      const now = Date.now();
      const live = new Set<string>();
      for (const p of panes) {
        // Only sessions with a tab in THIS window: the passthrough lands in the
        // client attached here, and every window runs its own writer.
        if (!findTerminalForSession(p.session)) continue;
        live.add(p.session);
        if (!p.attached) {
          // Nobody to receive it — tmux drops passthrough without a client.
          // Forget the text so it is written again once a client is back.
          this.last.delete(p.session);
          continue;
        }
        // 'seen' needs the unread markers; with those disabled, fall back to the clock.
        const clear: TabStateClear = cfg.unreadBadges ? cfg.tabStateClear : 'timer';
        const text = formatTabState(this.tracker.getSnapshot(p.session), now, cfg.tabStateStyle, clear);
        this.write(p.session, p.tty, text);
      }
      // A session that disappeared took its tab with it; drop the memory so a
      // reused name starts clean.
      for (const name of Array.from(this.last.keys())) {
        if (!live.has(name)) { this.last.delete(name); this.retryAt.delete(name); }
      }
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) { this.pending = false; this.schedule(); }
    }
  }

  /** Writing raw escape bytes into a pane is only safe when tmux is configured to
   *  forward them: with passthrough off the sequence would be printed as garbage
   *  over whatever the agent is drawing. A real "on" is cached for the session.
   *  "No server" (activation runs before restore has created anything) is not an
   *  answer: no cache, no warning, ask again next tick. */
  private async checkPassthrough(tmux: string): Promise<boolean> {
    if (this.passthroughOk && Date.now() - this.passthroughCheckedAt < PASSTHROUGH_TTL_MS) return true;
    let value: string;
    try {
      const { stdout } = await execFileP(tmux, ['show-options', '-gv', 'allow-passthrough'], { timeout: TMUX_TIMEOUT_MS });
      value = stdout.trim();
    } catch { return false; }
    const ok = value === 'on' || value === 'all';
    if (ok) { this.passthroughOk = true; this.passthroughCheckedAt = Date.now(); return true; }
    if (!this.ctx.globalState.get<boolean>(PASSTHROUGH_KEY)) {
      void this.ctx.globalState.update(PASSTHROUGH_KEY, true);
      void vscode.window.showWarningMessage(
        'Agent state in terminal tabs needs tmux `allow-passthrough on`. '
        + 'Update the managed tmux config (Terminal Sessions: Reload tmux Config) and restart the tmux server.',
      );
    }
    return false;
  }

  private write(session: string, tty: string, text: string): void {
    if (this.disposed) return;
    if (this.last.get(session) === text) return;
    const retry = this.retryAt.get(session);
    if (retry !== undefined && Date.now() < retry) return;
    if (writeToTty(tty, titleSequence(text))) {
      this.last.set(session, text);
      this.retryAt.delete(session);
    } else {
      // Pane died between listing and writing, tty not writable, or not
      // draining right now (EAGAIN) — never block the host, try again later.
      this.retryAt.set(session, Date.now() + RETRY_AFTER_MS);
    }
  }

  /** Blank every prefixed tab of this window, whether or not THIS host wrote to
   *  it — for the marks a previous host left behind while the feature is off. */
  private async blankThisWindow(tmuxPath: string, prefix: string): Promise<void> {
    const tmux = await tmuxMod.detectTmuxPath(tmuxPath);
    if (!tmux || this.disposed) return;
    let panes: PaneRow[] = [];
    try { panes = await activePanes(tmux, prefix); } catch { return; }
    for (const p of panes) {
      if (!p.attached || !findTerminalForSession(p.session)) continue;
      writeToTty(p.tty, titleSequence(''));
    }
  }

  /** Blank every tab we ever wrote to (feature turned off, or shutdown). */
  private async clearAll(): Promise<void> {
    if (this.last.size === 0) return;
    const cfg = getConfig();
    const tmux = await tmuxMod.detectTmuxPath(cfg.tmuxPath);
    if (!tmux) { this.last.clear(); return; }
    let panes: PaneRow[] = [];
    try { panes = await activePanes(tmux, cfg.sessionPrefix); } catch { /* nothing to clear */ }
    for (const p of panes) {
      if (!this.last.has(p.session) || !p.attached) continue;
      writeToTty(p.tty, titleSequence(''));
    }
    this.last.clear();
    this.retryAt.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    void this.clearAll();
  }
}

/** One short write to a pty, without ever blocking the extension host: no
 *  controlling-tty side effects (O_NOCTTY), no wait on a pane that is not being
 *  drained (O_NONBLOCK → EAGAIN → false), never truncating anything. */
function writeToTty(tty: string, data: string): boolean {
  // The path comes from tmux, but it is still an external string: accept only a
  // /dev node, and only one that turns out to be a character device once open.
  if (!tty.startsWith('/dev/') || tty.includes('..')) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tty, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isCharacterDevice()) return false;
    fs.writeSync(fd, data);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The template with `${sequence}` at the FRONT. VS Code truncates a tab's
 *  description from the end, so a mark appended after `${cwdFolder}` is the first
 *  thing to vanish in a narrow tab list; in front, the folder name gives way
 *  instead. Also migrates our own earlier placement (`… ${sequence}` at the end). */
export function withSequenceFirst(current: string): string {
  const rest = current.replace(/\s*\$\{sequence\}\s*/g, ' ').trim();
  return rest ? `${SEQ_VAR} ${rest}` : SEQ_VAR;
}

/** Does the tab description template expand the sequence title we write? */
export function templateShowsSequence(): boolean {
  const v = vscode.workspace.getConfiguration().get<string>(DESCRIPTION_SETTING) ?? '';
  return v.includes(SEQ_VAR);
}

/**
 * `${sequence}` has to be in the user's tab-description template or the text we
 * write is invisible. "Add it" and "Never ask" are remembered; "Not now" asks
 * again on the next activation — the setting is theirs.
 */
export async function maybeOfferDescriptionTemplate(ctx: vscode.ExtensionContext): Promise<void> {
  if (getConfig().tabStateText !== 'on') return;
  const cfg = vscode.workspace.getConfiguration();
  const current = cfg.get<string>(DESCRIPTION_SETTING) ?? '';
  const info = cfg.inspect<string>(DESCRIPTION_SETTING);
  // Update the scope that currently WINS: a workspace or folder override would
  // otherwise keep hiding the variable no matter what the user setting says.
  const target = info?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  if (current.includes(SEQ_VAR)) {
    // Our earlier placement appended it; a narrow tab list cut the mark off.
    if (!current.trimStart().startsWith(SEQ_VAR)) {
      try { await cfg.update(DESCRIPTION_SETTING, withSequenceFirst(current), target); } catch { /* keep as is */ }
    }
    return;
  }
  if (ctx.globalState.get<boolean>(TEMPLATE_KEY)) return;
  const sym = STYLES[getConfig().tabStateStyle] ?? STYLES.blue;
  const pick = await vscode.window.showInformationMessage(
    `Show agent state in terminal tabs? This puts ${SEQ_VAR} in front of ${DESCRIPTION_SETTING}, `
    + `where the extension writes ${sym.working} while an agent runs and `
    + `${sym.done} with an age once it is your turn again.`,
    'Add it', 'Not now', 'Never ask',
  );
  if (pick === 'Never ask') { void ctx.globalState.update(TEMPLATE_KEY, true); return; }
  if (pick !== 'Add it') return;
  const next = withSequenceFirst(current);
  try {
    await cfg.update(DESCRIPTION_SETTING, next, target);
    // Remember it only once the effective value really carries the variable;
    // otherwise ask again next time instead of going silently dark.
    if (templateShowsSequence()) void ctx.globalState.update(TEMPLATE_KEY, true);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not update ${DESCRIPTION_SETTING}: ${String(e).slice(0, 120)}`);
  }
}

export function registerTabState(ctx: vscode.ExtensionContext, tracker: ClaudeTracker): void {
  const writer = new TabStateWriter(ctx, tracker);
  writer.start();
  ctx.subscriptions.push({ dispose: () => writer.dispose() });
  // Delayed: the restore / hook-install / mouse-guard prompts get the floor first.
  const ask = setTimeout(() => void maybeOfferDescriptionTemplate(ctx), 12_000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(ask) });
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    const text = e.affectsConfiguration('terminalSessions.tabStateText');
    const style = e.affectsConfiguration('terminalSessions.tabStateStyle')
      || e.affectsConfiguration('terminalSessions.tabStateClear')
      || e.affectsConfiguration('terminalSessions.unreadBadges');
    if (!text && !style) return;
    // Repaint at once: waiting up to a tick to see the style you just picked
    // reads as the setting not working.
    writer.refreshNow();
    if (text) void maybeOfferDescriptionTemplate(ctx);
  }));
}
