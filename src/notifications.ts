import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getConfig } from './config';

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
    showToast(opts);
    return;
  }

  const focused = vscode.window.state.focused;
  const wantNative = mode === 'always' || !focused;

  if (wantNative) {
    try {
      if (process.platform === 'darwin') {
        await macosNotify(opts, cfg.notificationSound);
        return;
      }
      if (process.platform === 'linux') {
        await linuxNotify(opts);
        return;
      }
      // Windows/other: no native backend wired; fall through to toast.
    } catch (e) {
      console.error('[terminal-sessions] native notify failed, falling back to toast:', e);
    }
  }
  showToast(opts);
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
  const body = opts.subtitle ? `${opts.subtitle}\n${opts.body}` : opts.body;
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

async function macosNotify(opts: NotifyOptions, defaultSound: string): Promise<void> {
  // Error notifications override the configured sound to the "error" tone.
  const effectiveSound =
    opts.sound ||
    (opts.level === 'error' ? 'Basso' : opts.level === 'warning' ? 'Funk' : defaultSound) ||
    'Glass';
  const sound = VALID_SOUNDS.has(effectiveSound) ? effectiveSound : 'Glass';

  // Prefer terminal-notifier when installed: clicks activate Cursor directly
  // instead of bouncing through Script Editor (osascript's implicit owner).
  const tn = await detectTerminalNotifier();
  const bundleId = tn ? await detectBundleId() : undefined;
  if (tn && bundleId) {
    const args = [
      '-title', opts.title,
      '-message', opts.body,
      '-activate', bundleId,
      '-sound', sound,
    ];
    if (opts.subtitle) args.push('-subtitle', opts.subtitle);
    await execFileP(tn, args);
    return;
  }

  // Fallback: osascript. Click will open Script Editor (macOS attributes
  // the notification to the posting process). Users who care about click-
  // to-focus should `brew install terminal-notifier` or switch waiting
  // alerts to the `alert` style (modal dialog that we handle directly).
  const title = escapeOsa(opts.title);
  const body = escapeOsa(opts.body);
  const subtitle = opts.subtitle ? escapeOsa(opts.subtitle) : undefined;
  let script = `display notification "${body}" with title "${title}"`;
  if (subtitle) script += ` subtitle "${subtitle}"`;
  script += ` sound name "${sound}"`;
  await execFileP('/usr/bin/osascript', ['-e', script]);
}

function escapeOsa(s: string): string {
  // AppleScript string literals need backslash and quote escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function showToast(opts: NotifyOptions): void {
  const parts = [opts.title];
  if (opts.subtitle) parts.push(opts.subtitle);
  parts.push(opts.body);
  const msg = parts.join(' — ');
  const level = opts.level || 'info';
  // For warning-level toasts (Claude waiting), show a "Show terminal" action
  // the user can click to jump to the matching terminal tab. The caller
  // registers a one-shot listener via `onToastAction` below to handle clicks.
  if (level === 'error') {
    void vscode.window.showErrorMessage(msg);
  } else if (level === 'warning') {
    const action = pendingToastAction;
    if (action) {
      pendingToastAction = undefined;
      void vscode.window.showWarningMessage(msg, action.label).then((clicked) => {
        if (clicked === action.label) action.callback();
      });
    } else {
      void vscode.window.showWarningMessage(msg);
    }
  } else {
    void vscode.window.showInformationMessage(msg);
  }
}

/** One-shot callback attached to the next warning-level showToast call. Used
 *  by the Claude waiting path to add a clickable action button to the toast
 *  (on remote workspaces where we can't use macOS/Linux native notifications
 *  with click handlers). */
let pendingToastAction: { label: string; callback: () => void } | undefined;
export function armToastAction(label: string, callback: () => void): void {
  pendingToastAction = { label, callback };
}
