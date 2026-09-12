import { execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { brandedNotifier, resetBrandedNotifierCache } from './notifier-app';

/** Set once at activation: the branded notifier is built from assets that ship
 *  with the extension, and rebuilt when its version changes. */
let extRoot = '';
let extVersion = '0';
export function initNotifications(ctx: vscode.ExtensionContext): void {
  extRoot = ctx.extensionPath;
  extVersion = String((ctx.extension?.packageJSON as { version?: string } | undefined)?.version || '0');
}
function iconPath(): string { return path.join(extRoot, 'media', 'notifier.icns'); }
function extensionVersion(): string { return extVersion; }

/** Flipping `brandedNotifier` must take effect without a window reload. */
export function onNotifierSettingChanged(): void { resetBrandedNotifierCache(); }

const execFileP = promisify(execFile);

// macOS built-in system sounds. Anything else is silently dropped.
const VALID_SOUNDS = new Set([
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
]);

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
  sound?: string;              // overrides default sound
  level?: NotificationLevel;   // affects toast fallback
  /** terminal-notifier group: a new banner with the same id replaces the
   *  previous one, so a busy session never stacks five banners. Cleared by
   *  removeNotification() once the user has looked at the session. */
  groupId?: string;
  /** URL opened when the banner is clicked — our own deep link, so the click
   *  lands on the session's terminal tab instead of merely raising the window. */
  openUrl?: string;
  /** Where this came from. With the branded notifier the app icon says it; on
   *  every other surface (plain terminal-notifier, osascript, VS Code toast) it
   *  becomes a small badge, because "who woke me" is the first thing you read. */
  kind?: 'agent' | 'shell';
  /** One-line form for the in-editor toast, which is a single truncated line in
   *  a narrow popup and cannot afford the banner's three fields. The source
   *  badge is prepended for you. Falls back to the banner fields when absent. */
  short?: string;
  /** Button shown when this event lands as a VS Code toast (remote host, or
   *  native notifications off). Carried per event: a module-level latch would
   *  outlive an event delivered natively and hand the next toast a button
   *  pointing at the wrong session. */
  toastAction?: { label: string; callback: () => void };
}

/** Deep link the banner opens on click. Handled by the URI handler registered
 *  in extension.ts, which focuses (or reopens) that session's terminal. */
export function sessionFocusUrl(tmuxSession: string): string {
  const scheme = vscode.env.uriScheme || 'vscode';
  return `${scheme}://visul.terminal-sessions/focus?session=${encodeURIComponent(tmuxSession)}`;
}

/** One live banner per session — the id both groups and recalls them. */
export function sessionGroupId(tmuxSession: string): string {
  return `terminal-sessions-${tmuxSession}`;
}

/** True when the extension host runs on a different machine than the VS Code
 *  UI (Remote-SSH, Remote-WSL, Remote-Container, Codespaces). In that case
 *  OS native notifications posted from here land on the remote machine and
 *  are useless to the user sitting at the local Cursor window; we must route
 *  through the VS Code API, which automatically forwards to the local UI. */
function isRemoteExtensionHost(): boolean {
  return !!vscode.env.remoteName;
}

export async function notify(opts: NotifyOptions): Promise<void> {
  const cfg = getConfig();
  const mode = cfg.nativeNotifications;

  if (mode === 'never' || isRemoteExtensionHost()) {
    // The toast is the ONLY channel here, so it keeps its action button and
    // stays up until the user deals with it.
    showToast(opts, false);
    return;
  }

  const focused = vscode.window.state.focused;
  const wantNative = mode === 'always' || mode === 'both' || !focused;
  // `both`: the banner lands in the corner of the screen, which on a wide
  // display is nowhere near where you are looking — so when the window has
  // focus, also drop a transient toast inside it. Belt and braces, by choice.
  const alsoToast = mode === 'both' && focused;

  if (wantNative) {
    try {
      if (process.platform === 'darwin') {
        await macosNotify(opts, cfg.notificationSound);
        if (alsoToast) showToast({ ...opts, sound: undefined }, true);
        return;
      }
      if (process.platform === 'linux') {
        await linuxNotify(opts);
        if (alsoToast) showToast({ ...opts, sound: undefined }, true);
        return;
      }
      // Windows/other: no native backend wired; fall through to toast.
    } catch (e) {
      console.error('[terminal-sessions] native notify failed, falling back to toast:', e);
      showToast(opts, false);
      return;
    }
  }
  // `auto` with the window focused: the user is right here, so the toast is a
  // courtesy cue — transient, not another thing to click away.
  showToast(opts, true);
}

/**
 * Send a Linux desktop notification via `notify-send` (libnotify).
 * Available on nearly every GNOME/KDE/Xfce/Cinnamon/etc. desktop. On servers
 * without a notification daemon this will silently fail and the outer code
 * falls back to a VS Code toast.
 *
 * Urgency maps to level:
 *   - error   → critical (sticky until dismissed on most DEs)
 *   - warning → normal but with 8s timeout
 *   - info    → normal with 5s timeout
 */
async function linuxNotify(opts: NotifyOptions): Promise<void> {
  const urgency = opts.level === 'error' ? 'critical'
    : opts.level === 'warning' ? 'normal'
    : 'low';
  const timeoutMs = opts.level === 'warning' ? '8000' : '5000';
  const title = opts.title;
  // notify-send has no icon of ours to carry the source, same as the osascript
  // path, so the badge goes in the text.
  const state = badged(opts);
  const body = state ? `${state}\n${opts.body}`.trimEnd() : opts.body;
  await execFileP('/usr/bin/notify-send', [
    '-u', urgency,
    '-t', timeoutMs,
    '-a', 'Terminal Sessions',
    title,
    body,
  ]);
}

/**
 * Show a persistent modal dialog (not a banner) with one or two buttons.
 * Returns the label of the clicked button, or undefined if dismissed.
 * Use for high-attention events (e.g. Claude waiting for approval) where
 * a 5-second banner is not enough.
 *
 * macOS: osascript `display alert` (built in).
 * Linux: `zenity --question` if available; otherwise falls back to a
 *   sticky `notify-send -u critical` (no click-return — still visible until
 *   the user dismisses the notification).
 * Other platforms: returns undefined immediately.
 */
export async function macosAlert(opts: {
  title: string;
  message: string;
  primaryButton?: string;   // default "Show terminal"
  secondaryButton?: string; // default "Dismiss"
}): Promise<string | undefined> {
  // Remote extension host: we cannot reach the user's desktop with osascript
  // or zenity (those would run on the remote machine). Use VS Code's own
  // modal API, which is IPC-forwarded to the local Cursor window.
  if (isRemoteExtensionHost()) {
    const primary = opts.primaryButton || 'Show terminal';
    const secondary = opts.secondaryButton || 'Dismiss';
    const pick = await vscode.window.showWarningMessage(
      `${opts.title}\n\n${opts.message}`,
      { modal: true },
      primary,
      secondary,
    );
    return pick === primary ? primary : undefined;
  }
  if (process.platform === 'linux') {
    // Try zenity for a real modal with button. Falls through to notify-send
    // on exec failures (zenity not installed, no display, etc.).
    const primary = opts.primaryButton || 'Show terminal';
    try {
      const { stdout } = await execFileP('/usr/bin/zenity', [
        '--question',
        `--title=${opts.title}`,
        `--text=${opts.message}`,
        `--ok-label=${primary}`,
        `--cancel-label=${opts.secondaryButton || 'Dismiss'}`,
      ]);
      void stdout;
      return primary;
    } catch (e) {
      // zenity exit 1 = cancel button clicked → treat as dismissed.
      // any other error → fall back to a sticky banner so the user still sees something.
      if ((e as { code?: number }).code === 1) return undefined;
      try {
        await execFileP('/usr/bin/notify-send', [
          '-u', 'critical', '-a', 'Terminal Sessions',
          opts.title, opts.message,
        ]);
      } catch { /* ignore */ }
      return undefined;
    }
  }
  if (process.platform !== 'darwin') return undefined;
  const title = escapeOsa(opts.title);
  const message = escapeOsa(opts.message);
  const primary = escapeOsa(opts.primaryButton || 'Show terminal');
  const secondary = escapeOsa(opts.secondaryButton || 'Dismiss');
  const script =
    `display alert "${title}" message "${message}" ` +
    `buttons {"${secondary}", "${primary}"} default button "${primary}" ` +
    `cancel button "${secondary}"`;
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script]);
    const match = stdout.match(/button returned:(.*)/);
    return match ? match[1].trim() : undefined;
  } catch {
    // User clicked cancel button → osascript exits 1. Not an error we need to surface.
    return undefined;
  }
}

/**
 * Run terminal-notifier without waiting for it.
 *
 * It keeps an NSApplication run loop alive after posting — it has to, to be
 * there when the banner is clicked — and even `-remove` can sit there for
 * minutes. Awaiting it therefore never resolves in the normal case, which
 * silently killed everything sequenced after the call (the companion toast,
 * the scheduled withdrawal) and left one live process per notification.
 *
 * So: post, keep the handle, and put it on a leash — clicks work while the
 * process lives, and it is reaped afterwards instead of accumulating.
 */
function runNotifier(tn: string, args: string[], leashMs: number): ChildProcess {
  const child = execFile(tn, args, () => { /* exit code is not actionable */ });
  child.on('error', () => { /* spawn failed; nothing to notify about */ });
  child.unref();
  const leash = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, leashMs);
  (leash as unknown as { unref?: () => void }).unref?.();
  child.on('exit', () => clearTimeout(leash));
  return child;
}

/** How long a posted banner's process is kept around to service a click. */
const CLICK_LEASH_MS = 120_000;
/** A `-remove` only needs long enough to talk to Notification Center. */
const REMOVE_LEASH_MS = 5_000;

/** Cached location of `terminal-notifier` — if installed, clicks on our
 *  notifications bring Cursor to the front instead of Script Editor. */
let _tnPath: string | undefined | null = null;
let _bundleId: string | undefined | null = null;

async function detectTerminalNotifier(): Promise<string | undefined> {
  if (_tnPath !== null) return _tnPath;
  const candidates = [
    '/opt/homebrew/bin/terminal-notifier',
    '/usr/local/bin/terminal-notifier',
  ];
  for (const p of candidates) {
    try {
      await execFileP('/bin/ls', [p]);
      _tnPath = p;
      return p;
    } catch { /* next */ }
  }
  _tnPath = undefined;
  return undefined;
}

async function detectBundleId(): Promise<string | undefined> {
  if (_bundleId !== null) return _bundleId;
  const appName = vscode.env.appName || 'Cursor';
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', `id of app "${appName}"`]);
    _bundleId = stdout.trim() || undefined;
    return _bundleId;
  } catch {
    _bundleId = undefined;
    return undefined;
  }
}

/** The subtitle with a source badge in front — `🤖 ✓ Claude done`. Used
 *  wherever the notification does not carry our own icon. */
function badged(opts: NotifyOptions): string {
  const mark = opts.kind === 'agent' ? '🤖' : opts.kind === 'shell' ? '🖥' : '';
  if (!opts.subtitle) return mark;
  return mark ? `${mark} ${opts.subtitle}` : opts.subtitle;
}

/** Which macOS sound this event gets: explicit override, then the per-level
 *  tone, then the user's default. Shared by the banner and the toast cue so
 *  both channels sound the same. */
function resolveSound(opts: NotifyOptions, defaultSound: string): string {
  const effectiveSound =
    opts.sound ||
    (opts.level === 'error' ? 'Basso' : opts.level === 'warning' ? 'Funk' : defaultSound) ||
    'Glass';
  return VALID_SOUNDS.has(effectiveSound) ? effectiveSound : 'Glass';
}

/** Our own bundle when the user opted in and it could be built, else the plain
 *  terminal-notifier. `branded` decides whether the text needs the badge. */
async function resolveNotifier(): Promise<{ bin: string; branded: boolean } | undefined> {
  const plain = await detectTerminalNotifier();
  if (!plain) return undefined;
  if (!getConfig().brandedNotifier) return { bin: plain, branded: false };
  const ours = await brandedNotifier(plain, iconPath(), extensionVersion());
  return ours ? { bin: ours, branded: true } : { bin: plain, branded: false };
}

async function macosNotify(opts: NotifyOptions, defaultSound: string): Promise<void> {
  const sound = resolveSound(opts, defaultSound);
  const cfg = getConfig();

  // Prefer terminal-notifier when installed: clicks activate Cursor directly
  // instead of bouncing through Script Editor (osascript's implicit owner).
  const notifier = await resolveNotifier();
  const tn = notifier?.bin;
  const bundleId = tn ? await detectBundleId() : undefined;
  if (tn && bundleId) {
    const args = [
      '-title', opts.title,
      '-message', opts.body,
      '-sound', sound,
    ];
    const subtitle = notifier?.branded ? opts.subtitle : badged(opts);
    if (subtitle) args.push('-subtitle', subtitle);
    // One live banner per session: same group id replaces the standing one.
    // A timeout needs a handle to remove by, so give an ungrouped banner a
    // throwaway id rather than leaving it unremovable.
    const timeoutSec = cfg.bannerTimeoutSeconds;
    const group = (opts.groupId && cfg.notificationGrouping)
      ? opts.groupId
      : (timeoutSec > 0 ? `terminal-sessions-tmp-${++bannerSeq}` : undefined);
    if (group) args.push('-group', group);
    if (cfg.notificationSenderIcon) {
      // Impersonate the IDE so the banner carries its icon and gets its own
      // entry under System Settings > Notifications. terminal-notifier then
      // hands the click to that app, which discards our deep link — hence
      // opt-in, and mutually exclusive with click-to-session.
      args.push('-sender', bundleId);
    } else {
      if (opts.openUrl) args.push('-open', opts.openUrl);
      args.push('-activate', bundleId);
    }
    const child = runNotifier(tn, args, CLICK_LEASH_MS);
    if (group && timeoutSec > 0) scheduleBannerRemoval(group, timeoutSec, child);
    return;
  }

  // Fallback: osascript. Click will open Script Editor (macOS attributes
  // the notification to the posting process). Users who care about click-
  // to-focus should `brew install terminal-notifier` or switch waiting
  // alerts to the `alert` style (modal dialog that we handle directly).
  const title = escapeOsa(opts.title);
  const body = escapeOsa(opts.body);
  const badgedSubtitle = badged(opts);
  const subtitle = badgedSubtitle ? escapeOsa(badgedSubtitle) : undefined;
  let script = `display notification "${body}" with title "${title}"`;
  if (subtitle) script += ` subtitle "${subtitle}"`;
  script += ` sound name "${sound}"`;
  await execFileP('/usr/bin/osascript', ['-e', script]);
}

/** Take back a banner the user no longer needs (they opened or dismissed the
 *  session). Only terminal-notifier can recall a delivered notification; the
 *  osascript fallback has no such handle, so this is a silent no-op there. */
export async function removeNotification(groupId: string): Promise<void> {
  if (!getConfig().notificationGrouping) return;
  await removeGroup(groupId);
}

/** Unconditional withdrawal — used by the timeout path, which owns its group id
 *  whether or not per-session grouping is on. */
async function removeGroup(groupId: string): Promise<void> {
  if (process.platform !== 'darwin' || isRemoteExtensionHost()) return;
  const tn = await detectTerminalNotifier();
  if (!tn) return;
  runNotifier(tn, ['-remove', groupId], REMOVE_LEASH_MS);
}

/** Which banner currently owns a group id, so a timer that fires late does not
 *  withdraw the notification that replaced the one it was scheduled for. */
const bannerOwner = new Map<string, number>();
let bannerSeq = 0;

/**
 * Show it, then take it back: the banner has its usual few seconds on screen,
 * and after `seconds` it is withdrawn from Notification Center too, leaving no
 * residue to clear by hand. This is what `terminal-notifier -timeout` used to
 * do before 2.0.0 dropped the flag.
 */
function scheduleBannerRemoval(groupId: string, seconds: number, poster?: ChildProcess): void {
  const seq = ++bannerSeq;
  bannerOwner.set(groupId, seq);
  const timer = setTimeout(() => {
    if (bannerOwner.get(groupId) !== seq) return;  // superseded; its timer owns it
    bannerOwner.delete(groupId);
    void removeGroup(groupId);
    // The banner is gone, so nothing is left to click: let its process go too
    // rather than hold it for the full click leash.
    try { poster?.kill(); } catch { /* already gone */ }
  }, seconds * 1000);
  // Never hold the extension host open for a notification.
  (timer as unknown as { unref?: () => void }).unref?.();
}

function escapeOsa(s: string): string {
  // AppleScript string literals need backslash and quote escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** @param transient the native banner path was available and the toast is only
 *  a courtesy cue for a focused window — it may dismiss itself. When false the
 *  toast is the only channel the user has, so it keeps its button and stays. */
function showToast(opts: NotifyOptions, transient: boolean): void {
  // A toast is one truncated line, so it says only what it must: where it came
  // from, how it went, which session — and a detail only when it changes what
  // you do next.
  const mark = opts.kind === 'agent' ? '🤖' : opts.kind === 'shell' ? '🖥' : '';
  const msg = opts.short
    ? [mark, opts.short].filter(Boolean).join(' ')
    : (() => {
      const state = badged(opts);
      const head = state ? `${opts.title} — ${state}` : opts.title;
      return opts.body ? `${head} · ${opts.body}` : head;
    })();
  const level = opts.level || 'info';
  const action = opts.toastAction;
  playToastSound(opts);
  if (level === 'error') {
    void vscode.window.showErrorMessage(msg);
    return;
  }
  if (level === 'warning') {
    const secs = getConfig().toastAutoDismissSeconds;
    // showWarningMessage sticks in the corner until clicked, and VS Code has no
    // API to retract it. withProgress is the one notification that can end by
    // itself — at the cost of the action button, which is why this is limited
    // to the case where the user is already looking at the window.
    if (transient && secs > 0) {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: msg },
        () => new Promise<void>(resolve => setTimeout(resolve, secs * 1000)),
      );
      return;
    }
    if (action) {
      void vscode.window.showWarningMessage(msg, action.label).then((clicked) => {
        if (clicked === action.label) action.callback();
      });
    } else {
      void vscode.window.showWarningMessage(msg);
    }
    return;
  }
  if (action) {
    void vscode.window.showInformationMessage(msg, action.label).then((clicked) => {
      if (clicked === action.label) action.callback();
    });
    return;
  }
  void vscode.window.showInformationMessage(msg);
}

/** VS Code toasts are silent. On macOS play the sound the banner would have
 *  used, so "Claude is done" is audible even with the window focused — the
 *  single biggest reason `auto` felt quieter than a plain hook. */
function playToastSound(opts: NotifyOptions): void {
  if (process.platform !== 'darwin' || isRemoteExtensionHost()) return;
  const cfg = getConfig();
  if (!cfg.toastSound) return;
  // In `both` the native banner has already sounded; a second chime would just
  // be an echo.
  if (cfg.nativeNotifications === 'both' && vscode.window.state.focused) return;
  const sound = resolveSound(opts, cfg.notificationSound);
  void execFileP('/usr/bin/afplay', [`/System/Library/Sounds/${sound}.aiff`])
    .catch(() => { /* sound file missing or audio unavailable */ });
}


