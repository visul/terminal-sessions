import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileP = promisify(execFile);

/** No build step may hang: `macosNotify` awaits this, and every caller fires
 *  notify() with `void`, so a stuck `cp`/`codesign` would mean no notification
 *  and no error, forever. */
const STEP_TIMEOUT_MS = 20_000;

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
 *  moves — otherwise a stale copy would outlive both.
 *
 *  Kept OUTSIDE the bundle: a file added inside it after `codesign` breaks the
 *  seal (`codesign --verify` then reports "a sealed resource is missing or
 *  invalid"), which is exactly the state that gets an app refused on launch or
 *  re-prompted for notification permission. */
function stampPath(): string {
  return path.join(appDir(), '.notifier-stamp');
}

function stampValue(source: string, iconSrc: string, version: string): string {
  const iconMtime = (() => {
    try { return fs.statSync(iconSrc).mtimeMs.toFixed(0); } catch { return '0'; }
  })();
  return `${version}|${source}|${iconMtime}`;
}

/** Cached per extension host: building is a few processes, and a failure is
 *  almost always permanent (no codesign on the machine). The *promise* is
 *  cached, not its result, so notifications arriving in a burst share one build
 *  instead of the later ones seeing a half-set flag and falling back. */
let cached: Promise<string | undefined> | null = null;

/** Builds run one at a time. Two of them interleaving `rm -rf` → `cp -R` →
 *  `codesign` on the same bundle can leave a corrupt .app that outlives both,
 *  and the settings toggle can drop the cache while one is still running. */
let buildChain: Promise<unknown> = Promise.resolve();

/**
 * Path to our own notifier binary, building it on first use.
 *
 * @param source  the `terminal-notifier` binary we were going to use anyway
 * @param iconSrc `media/notifier.icns` inside the extension
 * @param version extension version, part of the rebuild stamp
 * @returns the branded binary, or undefined when anything at all went wrong —
 *          every caller must fall back to `source`.
 */
export function brandedNotifier(
  source: string,
  iconSrc: string,
  version: string,
): Promise<string | undefined> {
  if (cached) return cached;
  // Queue behind any build already running, so a cache reset mid-build cannot
  // start a second one over the same directory.
  const run = buildChain.then(() => ensureBuilt(source, iconSrc, version));
  buildChain = run.catch(() => undefined);
  cached = run;
  return run;
}

async function ensureBuilt(
  source: string,
  iconSrc: string,
  version: string,
): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;

  const sourceApp = sourceBundleOf(source);
  if (!sourceApp) return undefined;

  const want = stampValue(sourceApp, iconSrc, version);
  try {
    if (fs.readFileSync(stampPath(), 'utf8') === want && fs.existsSync(binPath())) return binPath();
  } catch { /* not built yet, or unreadable — build it */ }

  try {
    await build(sourceApp, iconSrc, want);
    return binPath();
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
  await execFileP('/bin/cp', ['-R', sourceApp, appPath()], { timeout: STEP_TIMEOUT_MS });

  const plist = path.join(appPath(), 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleName', 'Terminal Sessions'],
    ['CFBundleIconFile', ICON_NAME],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await execFileP('/usr/bin/plutil', ['-replace', key, '-string', value, plist], { timeout: STEP_TIMEOUT_MS });
  }
  const resources = path.join(appPath(), 'Contents', 'Resources');
  fs.copyFileSync(iconSrc, path.join(resources, `${ICON_NAME}.icns`));
  // The icon we replaced is dead weight inside the bundle, and upstream's own
  // rebranding target removes it too.
  try { fs.rmSync(path.join(resources, 'Terminal.icns'), { force: true }); } catch { /* fine */ }

  // Editing the bundle invalidates its signature, and macOS refuses to run an
  // arm64 binary whose signature does not match. Ad-hoc is enough: we are not
  // distributing this copy, only running it locally.
  await execFileP('/usr/bin/codesign', ['--force', '--deep', '-s', '-', appPath()], { timeout: STEP_TIMEOUT_MS });

  if (!fs.existsSync(binPath())) throw new Error(`no executable at ${binPath()}`);
  // Verify the seal we just applied rather than assuming it: a bundle that
  // fails this would fail to launch later, silently, with no notification.
  await execFileP('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath()], { timeout: STEP_TIMEOUT_MS });
  fs.writeFileSync(stampPath(), stamp);
}

/** Drop the memoised result so a settings change takes effect without a reload. */
export function resetBrandedNotifierCache(): void {
  cached = null;
}
