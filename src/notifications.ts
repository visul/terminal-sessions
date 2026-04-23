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

export async function notify(opts: NotifyOptions): Promise<void> {
  const cfg = getConfig();
  const mode = cfg.nativeNotifications;

  if (mode === 'never') {
    showToast(opts);
    return;
  }

  const focused = vscode.window.state.focused;
  const useNative = process.platform === 'darwin' && (mode === 'always' || !focused);

  if (useNative) {
    try {
      await macosNotify(opts, cfg.notificationSound);
      return;
    } catch (e) {
      console.error('[terminal-sessions] osascript failed, falling back to toast:', e);
    }
  }
  showToast(opts);
}

async function macosNotify(opts: NotifyOptions, defaultSound: string): Promise<void> {
  const title = escapeOsa(opts.title);
  const body = escapeOsa(opts.body);
  const subtitle = opts.subtitle ? escapeOsa(opts.subtitle) : undefined;

  // Error notifications override the configured sound to the "error" tone.
  const effectiveSound =
    opts.sound ||
    (opts.level === 'error' ? 'Basso' : opts.level === 'warning' ? 'Funk' : defaultSound) ||
    'Glass';
  const sound = VALID_SOUNDS.has(effectiveSound) ? effectiveSound : 'Glass';

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
  if (level === 'error') vscode.window.showErrorMessage(msg);
  else if (level === 'warning') vscode.window.showWarningMessage(msg);
  else vscode.window.showInformationMessage(msg);
}
