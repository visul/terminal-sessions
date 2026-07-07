import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const ROOT = path.join(os.homedir(), '.terminal-sessions');
const CLIP_FILE = path.join(ROOT, 'clipboard.txt');
const WRITER_DEST = path.join(ROOT, 'ts-clipboard-write.sh');

/**
 * Remote clipboard bridge.
 *
 * Over Remote-SSH the only automatic tmux→local-clipboard channel is OSC 52, which
 * Cursor's xterm.js mis-decodes as Latin-1 (diacritics → mojibake); a clipboard tool on
 * the remote (pbcopy/xclip) writes the remote machine, not the user's local UI. So the
 * generated tmux.conf (remote branch of clipboardConf) pipes every copy to
 * ts-clipboard-write.sh, which writes the selection as correct UTF-8 to
 * `~/.terminal-sessions/clipboard.txt`. This watcher mirrors that file to the LOCAL
 * clipboard via `vscode.env.clipboard.writeText()` — VS Code forwards a remote-host
 * clipboard write to the local UI, preserving UTF-8 and bypassing OSC 52 entirely.
 *
 * Local hosts are unaffected: tmux copies straight to the system clipboard via
 * pbcopy/xclip and this bridge returns immediately (no script install, no watcher).
 */
export function registerClipboardBridge(ctx: vscode.ExtensionContext): void {
  // Only remote extension hosts (Remote-SSH / WSL / Container / Codespaces) need the
  // bridge. On a local host the tmux.conf never references the writer and the pbcopy/
  // xclip path already reaches the user's clipboard directly.
  if (!vscode.env.remoteName) return;

  try {
    fs.mkdirSync(ROOT, { recursive: true });
    // Install the writer script that tmux copy-pipe invokes (mirrors the media/*.sh
    // install pattern used for the agent hook forwarder).
    const src = path.join(ctx.extensionPath, 'media', 'ts-clipboard-write.sh');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, WRITER_DEST);
      fs.chmodSync(WRITER_DEST, 0o755);
    }
    if (!fs.existsSync(CLIP_FILE)) fs.writeFileSync(CLIP_FILE, '');
  } catch (e) {
    console.error('[terminal-sessions] clipboard-bridge install:', e);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const sync = (): void => {
    try {
      const text = fs.readFileSync(CLIP_FILE, 'utf8');
      if (text.length > 0) void vscode.env.clipboard.writeText(text);
    } catch { /* transient read during the writer's truncate+write; next event retries */ }
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    // The writer truncates in place (same inode), so a single fs.watch on the file
    // survives every copy. Debounce so a burst of change events collapses to one read.
    watcher = fs.watch(CLIP_FILE, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(sync, 50);
    });
  } catch (e) {
    console.error('[terminal-sessions] clipboard-bridge watch:', e);
  }

  ctx.subscriptions.push({
    dispose: () => { if (timer) clearTimeout(timer); watcher?.close(); },
  });
}
