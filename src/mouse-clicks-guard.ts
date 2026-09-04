import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileP = promisify(execFile);

/**
 * Guard against CLAUDE_CODE_DISABLE_MOUSE_CLICKS (and the older CLAUDE_CODE_DISABLE_MOUSE).
 *
 * In Claude Code's fullscreen view the mouse belongs to Claude: drag-select, copy on
 * release, button clicks and wheel scroll. DISABLE_MOUSE_CLICKS=1 makes Claude ignore
 * every click and drag (only the wheel survives), so drag-select and buttons silently
 * die; DISABLE_MOUSE=1 drops the wheel too. Terminal Sessions v0.10–v0.20.13 told users
 * to set the first one — the "Fix Claude Code Rendering in Shell" command appended it
 * to their rc file and the managed tmux.conf set it with `set-environment -g`. The conf
 * stopped in v0.20.14 (and v17 unsets it on the server), but an rc export lives forever
 * and a tmux server started under the old conf keeps it until restart. This module finds
 * the leftovers (rc files, tmux global env, ~/.claude/settings.json "env", this process)
 * and removes them on request.
 */
export const MOUSE_VARS = ['CLAUDE_CODE_DISABLE_MOUSE_CLICKS', 'CLAUDE_CODE_DISABLE_MOUSE'] as const;

const RC_FILES = [
  '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile',
  path.join('.config', 'fish', 'config.fish'),
];

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/** An ACTIVE (uncommented) sh/zsh/bash `export VAR=…`, a standalone `export VAR`
 *  (the split `VAR=1` + `export VAR` form), or fish `set -gx VAR …` line. */
const ACTIVE_LINE = /^\s*(?:export\s+CLAUDE_CODE_DISABLE_MOUSE(?:_CLICKS)?(?:=|\s*(?:#.*)?$)|set\s+(?:-\w+\s+)+CLAUDE_CODE_DISABLE_MOUSE(?:_CLICKS)?\b)/;

export interface MouseEnvFinding {
  /** rc files with active lines setting one of MOUSE_VARS (absolute path + 1-based lines). */
  rcFiles: { file: string; lines: number[] }[];
  /** Vars present in the tmux server's global environment (`show-environment -g`). */
  tmuxGlobal: string[];
  /** Vars present in ~/.claude/settings.json "env". */
  settingsEnv: string[];
  /** Vars set in this extension host's own environment. */
  processEnv: string[];
}

export function hasFindings(f: MouseEnvFinding): boolean {
  return f.rcFiles.length > 0 || f.tmuxGlobal.length > 0 || f.settingsEnv.length > 0 || f.processEnv.length > 0;
}

/** 1-based line numbers of active lines that set a mouse var. */
export function findMouseEnvLines(content: string): number[] {
  const out: number[] = [];
  content.split('\n').forEach((line, i) => { if (ACTIVE_LINE.test(line)) out.push(i + 1); });
  return out;
}

export async function scanMouseEnv(tmuxPath?: string): Promise<MouseEnvFinding> {
  const home = os.homedir();
  const rcFiles: MouseEnvFinding['rcFiles'] = [];
  for (const rel of RC_FILES) {
    const file = path.join(home, rel);
    try {
      const lines = findMouseEnvLines(fs.readFileSync(file, 'utf8'));
      if (lines.length) rcFiles.push({ file, lines });
    } catch { /* missing rc file */ }
  }

  const tmuxGlobal: string[] = [];
  if (tmuxPath) {
    for (const v of MOUSE_VARS) {
      try {
        // Prints "VAR=value" when set; "-VAR" means "remove for new processes" (not set);
        // exits non-zero with "unknown variable" when absent or when no server runs.
        const { stdout } = await execFileP(tmuxPath, ['show-environment', '-g', v]);
        if (stdout.startsWith(`${v}=`)) tmuxGlobal.push(v);
      } catch { /* no server, or not set */ }
    }
  }

  const settingsEnv: string[] = [];
  try {
    const env = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))?.env;
    if (env && typeof env === 'object') {
      for (const v of MOUSE_VARS) if (v in env) settingsEnv.push(v);
    }
  } catch { /* no settings file or unparsable */ }

  const processEnv = MOUSE_VARS.filter(v => process.env[v] !== undefined && process.env[v] !== '');

  return { rcFiles, tmuxGlobal, settingsEnv, processEnv };
}

const DISABLED_MARK = '# disabled by Terminal Sessions: makes Claude Code ignore mouse clicks/drags';

/** Comment out every active mouse-var line in an rc file, in place, after backing the
 *  file up next to itself. Returns the number of lines changed and the backup path. */
export function commentOutMouseEnv(rcPath: string): { changed: number; backup: string } {
  const content = fs.readFileSync(rcPath, 'utf8');
  let changed = 0;
  const updated = content.split('\n').map(line => {
    if (!ACTIVE_LINE.test(line)) return line;
    changed++;
    return `# ${line}  ${DISABLED_MARK}`;
  }).join('\n');
  if (changed === 0) return { changed, backup: '' };
  const backup = `${rcPath}.bak-terminal-sessions-${Date.now()}`;
  fs.copyFileSync(rcPath, backup);
  fs.writeFileSync(rcPath, updated);
  return { changed, backup };
}

function home(p: string): string {
  const h = os.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

export function describeFindings(f: MouseEnvFinding): string {
  const where: string[] = [];
  for (const r of f.rcFiles) where.push(`${home(r.file)} (line ${r.lines.join(', ')})`);
  if (f.tmuxGlobal.length) where.push('the tmux server environment');
  if (f.settingsEnv.length) where.push('~/.claude/settings.json "env"');
  if (f.processEnv.length && !f.rcFiles.length && !f.settingsEnv.length) where.push('this editor process environment');
  return where.join(', ');
}

/** Remove every finding we can act on. Returns human-readable result lines. */
export async function fixMouseEnv(f: MouseEnvFinding, tmuxPath?: string): Promise<string[]> {
  const done: string[] = [];
  for (const r of f.rcFiles) {
    try {
      const { changed, backup } = commentOutMouseEnv(r.file);
      if (changed) done.push(`commented out ${changed} line(s) in ${home(r.file)} (backup: ${home(backup)})`);
    } catch (e) {
      done.push(`could not edit ${home(r.file)}: ${String(e).slice(0, 80)}`);
    }
  }
  if (tmuxPath && f.tmuxGlobal.length) {
    for (const v of f.tmuxGlobal) {
      try { await execFileP(tmuxPath, ['set-environment', '-gu', v]); } catch { /* server gone */ }
    }
    done.push('cleared it from the tmux server environment');
  }
  if (f.settingsEnv.length) {
    try {
      const obj = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      for (const v of f.settingsEnv) delete obj.env[v];
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2) + '\n');
      done.push('removed it from ~/.claude/settings.json "env"');
    } catch (e) {
      done.push(`could not edit ~/.claude/settings.json: ${String(e).slice(0, 80)}`);
    }
  }
  if (f.processEnv.length && !f.rcFiles.length && !f.settingsEnv.length) {
    done.push('it is also set in this editor process (from a launcher or a profile file we do not scan) — find and remove that export, then restart the editor');
  }
  return done;
}

const DISMISS_KEY = 'mouseEnvGuardDismissed-v1';

/** Startup check (silent when clean, once-dismissable) or on-demand command (force). */
export async function maybeWarnMouseEnv(
  ctx: vscode.ExtensionContext,
  tmuxPath: string | undefined,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!opts.force && ctx.globalState.get(DISMISS_KEY)) return;
  const f = await scanMouseEnv(tmuxPath);
  if (!hasFindings(f)) {
    if (opts.force) {
      vscode.window.showInformationMessage(
        'No CLAUDE_CODE_DISABLE_MOUSE_CLICKS / CLAUDE_CODE_DISABLE_MOUSE found in your rc files, '
        + 'the tmux server environment, ~/.claude/settings.json or this editor process. '
        + 'If drag-select still does nothing inside Claude, restart that session '
        + '(sidebar → Restart Session): the environment is read when Claude launches.',
      );
    }
    return;
  }
  const buttons = opts.force ? ['Fix', 'Not now'] : ['Fix', 'Not now', "Don't show again"];
  const choice = await vscode.window.showWarningMessage(
    `CLAUDE_CODE_DISABLE_MOUSE_CLICKS is set (${describeFindings(f)}). It makes Claude Code `
    + 'ignore every mouse click and drag, so drag-select, copy on release and buttons do '
    + 'nothing inside Claude. Older Terminal Sessions versions recommended it; it is now '
    + 'harmful. Fix it? (comments the rc line out with a backup, clears the tmux server '
    + 'environment — then Restart Session on running Claude sessions.)',
    ...buttons,
  );
  if (choice === 'Fix') {
    const done = await fixMouseEnv(f, tmuxPath);
    vscode.window.showInformationMessage(
      `Done: ${done.join('; ')}. Restart running Claude sessions (sidebar → Restart Session) `
      + 'so they start without the variable.',
    );
  } else if (choice === "Don't show again") {
    await ctx.globalState.update(DISMISS_KEY, true);
  }
}
