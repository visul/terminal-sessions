import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileP = promisify(execFile);

/**
 * A notification carries the icon of the app that posted it, and macOS decides
 * that from the bundle — `terminal-notifier -appIcon` is ignored on current
 * releases (verified), so out of the box every notification we send wears the
 * Terminal icon and files itself under `terminal-notifier` in System Settings,
 * where the user cannot even find it (macOS never registers it there).
 *
 * The fix is to post from our own bundle: a copy of the installed
 * terminal-notifier, re-identified as Terminal Sessions, carrying our icon, and
 * re-signed ad-hoc so macOS will run it. Same binary, so click actions, groups
 * and removal all behave identically.
 *
 * The cost is a one-time macOS permission prompt for a new app, which is why
 * this is opt-in (`terminalSessions.brandedNotifier`): a user who dismisses
 * that prompt gets no notifications at all, and would have no idea why.
 */

const BUNDLE_ID = 'eu.visul.terminal-sessions.notifier';
const APP_NAME = 'TerminalSessionsNotifier.app';
const ICON_NAME = 'TerminalSessions';

function appDir(): string {
  return path.join(os.homedir(), '.terminal-sessions');
}

function appPath(): string {
  return path.join(appDir(), APP_NAME);
}

function binPath(): string {
  return path.join(appPath(), 'Contents', 'MacOS', 'terminal-notifier');
}

/** Rebuild when the extension ships a new icon or the user's terminal-notifier
 *  moves — otherwise a stale copy would outlive both. */
function stampPath(): string {
  return path.join(appPath(), 'Contents', '.ts-stamp');
}

function stampValue(source: string, iconSrc: string, version: string): string {
  const iconMtime = (() => {
    try { return fs.statSync(iconSrc).mtimeMs.toFixed(0); } catch { return '0'; }
  })();
  return `${version}|${source}|${iconMtime}`;
}

/** Cached per extension host: building is a few processes, and a failure is
 *  almost always permanent (no codesign on the machine). */
let cached: string | undefined | null = null;

/**
 * Path to our own notifier binary, building it on first use.
 *
 * @param source  the `terminal-notifier` binary we were going to use anyway
 * @param iconSrc `media/notifier.icns` inside the extension
 * @param version extension version, part of the rebuild stamp
 * @returns the branded binary, or undefined when anything at all went wrong —
 *          every caller must fall back to `source`.
 */
export async function brandedNotifier(
  source: string,
  iconSrc: string,
  version: string,
): Promise<string | undefined> {
  if (cached !== null) return cached;
  cached = undefined;                       // pessimistic until it is built
  if (process.platform !== 'darwin') return undefined;

  const sourceApp = sourceBundleOf(source);
  if (!sourceApp) return undefined;

  const want = stampValue(sourceApp, iconSrc, version);
  try {
    if (fs.readFileSync(stampPath(), 'utf8') === want && fs.existsSync(binPath())) {
      cached = binPath();
      return cached;
    }
  } catch { /* not built yet, or unreadable — build it */ }

  try {
    await build(sourceApp, iconSrc, want);
    cached = binPath();
    return cached;
  } catch (e) {
    console.error('[terminal-sessions] branded notifier build failed, using terminal-notifier as-is:', e);
    try { fs.rmSync(appPath(), { recursive: true, force: true }); } catch { /* best effort */ }
    return undefined;
  }
}

/** `/opt/homebrew/Cellar/terminal-notifier/2.0.0/bin/terminal-notifier` is a
 *  shim; the bundle we need sits next to it. Resolve the symlink first, since
 *  `/opt/homebrew/bin/terminal-notifier` is one. */
function sourceBundleOf(source: string): string | undefined {
  let real: string;
  try { real = fs.realpathSync(source); } catch { return undefined; }
  // .../<prefix>/bin/terminal-notifier → .../<prefix>/terminal-notifier.app
  const candidates = [
    path.join(path.dirname(path.dirname(real)), 'terminal-notifier.app'),
    // …/terminal-notifier.app/Contents/MacOS/terminal-notifier (already inside one)
    path.resolve(path.dirname(real), '..', '..'),
  ];
  for (const c of candidates) {
    if (c.endsWith('.app') && fs.existsSync(path.join(c, 'Contents', 'Info.plist'))) return c;
  }
  return undefined;
}

async function build(sourceApp: string, iconSrc: string, stamp: string): Promise<void> {
  fs.mkdirSync(appDir(), { recursive: true });
  fs.rmSync(appPath(), { recursive: true, force: true });
  // cp -R keeps the executable bit and the bundle layout; Node's recursive copy
  // would too, but this also survives the symlinks inside a Homebrew cellar.
  await execFileP('/bin/cp', ['-R', sourceApp, appPath()]);

  const plist = path.join(appPath(), 'Contents', 'Info.plist');
  await execFileP('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plist]);
  await execFileP('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'Terminal Sessions', plist]);
  await execFileP('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', ICON_NAME, plist]);
  fs.copyFileSync(iconSrc, path.join(appPath(), 'Contents', 'Resources', `${ICON_NAME}.icns`));

  // Editing the bundle invalidates its signature, and macOS refuses to run an
  // arm64 binary whose signature does not match. Ad-hoc is enough: we are not
  // distributing this copy, only running it locally.
  await execFileP('/usr/bin/codesign', ['--force', '--deep', '-s', '-', appPath()]);

  if (!fs.existsSync(binPath())) throw new Error(`no executable at ${binPath()}`);
  fs.writeFileSync(stampPath(), stamp);
}

/** Drop the memoised result so a settings change takes effect without a reload. */
export function resetBrandedNotifierCache(): void {
  cached = null;
}
