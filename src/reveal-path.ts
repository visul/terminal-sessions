import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CMD_FINDER = 'terminalSessions.revealSelectionInFinder';
const CMD_EXPLORER = 'terminalSessions.revealSelectionInExplorer';

/**
 * Right-click in the integrated terminal -> Reveal in Finder / Reveal in Explorer.
 * Workflow:
 *   1. User selects a path in the terminal (double-click, drag, or triple-click for whole line)
 *   2. Right-click -> menu shows 2 entries from this provider
 *   3. We read the live selection via the built-in "copy selection" command,
 *      restore the previous clipboard, resolve the path, and dispatch
 *      either revealFileInOS or revealInExplorer.
 *
 * Cmd+click behaviour is untouched: we don't register a TerminalLinkProvider.
 */
export function registerRevealPath(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(CMD_FINDER, () => revealUsingSelection('finder')),
    vscode.commands.registerCommand(CMD_EXPLORER, () => revealUsingSelection('explorer')),
  );
}

type RevealTarget = 'finder' | 'explorer';

async function revealUsingSelection(target: RevealTarget): Promise<void> {
  const term = vscode.window.activeTerminal;
  if (!term) {
    vscode.window.showWarningMessage('No active terminal.');
    return;
  }

  const raw = await readTerminalSelection();
  if (!raw) {
    vscode.window.showWarningMessage(
      'Select a file or folder path in the terminal first (double-click on the path, then right-click).',
    );
    return;
  }

  const fullPath = resolveSelectionToPath(raw, term);
  if (!fullPath) {
    vscode.window.showWarningMessage(
      `"${truncate(raw, 60)}" is not a valid path on disk.`,
    );
    return;
  }

  const uri = vscode.Uri.file(fullPath);
  if (target === 'finder') {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  } else {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }
}

/**
 * Read the current terminal selection by routing it through the clipboard.
 * VS Code does not expose terminal selection directly in stable API, so we:
 *   - back up the clipboard
 *   - run copySelection
 *   - read the new clipboard contents
 *   - restore the original clipboard
 * Returns undefined when nothing is selected (clipboard unchanged).
 */
async function readTerminalSelection(): Promise<string | undefined> {
  const backup = await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
  // Give VS Code a tick to populate the clipboard. Empirically <5ms is enough,
  // but we use a microtask + small timeout to be safe across machines.
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await vscode.env.clipboard.readText();
  // Restore previous clipboard so we don't trash whatever the user had copied.
  await vscode.env.clipboard.writeText(backup);
  if (after === backup) return undefined;
  const trimmed = after.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Turn a piece of selected text into an absolute path on disk, or null when
 * the result doesn't point at an existing file/folder.
 */
function resolveSelectionToPath(raw: string, term: vscode.Terminal): string | null {
  const cleaned = cleanCandidate(raw);
  if (!cleaned) return null;

  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) {
    candidates.push(cleaned);
  } else {
    const cwd = terminalCwd(term);
    if (cwd) candidates.push(path.resolve(cwd, cleaned));
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.resolve(wf.uri.fsPath, cleaned));
    }
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* permission errors etc. — fall through */ }
  }
  return null;
}

function cleanCandidate(raw: string): string | null {
  let s = raw;
  // Drop a single line of context if user selected multiple lines (rare).
  const nl = s.indexOf('\n');
  if (nl >= 0) s = s.slice(0, nl);
  // Strip leading emoji / list bullets / quotes / spaces.
  s = s.replace(/^[^\w./~-]+/, '');
  // Strip trailing punctuation that often clings to paths in prose.
  s = s.replace(/[)\],.;:]+$/, '');
  // Strip wrapping quotes/backticks.
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  // Strip trailing :line or :line:col suffix (e.g. file.py:42:10).
  s = s.replace(/:\d+(?::\d+)?$/, '');
  // Expand ~ to home directory.
  if (s.startsWith('~/') || s === '~') {
    const home = process.env.HOME ?? '';
    s = s === '~' ? home : path.join(home, s.slice(2));
  }
  s = s.trim();
  return s.length > 0 ? s : null;
}

/**
 * Best-effort terminal cwd. Uses VS Code shell integration when available,
 * falls back to the first workspace folder.
 */
function terminalCwd(term: vscode.Terminal): string | undefined {
  // shellIntegration is supported in recent VS Code / Cursor versions.
  // Cast to any to keep compatibility with older @types/vscode in the repo.
  const integration = (term as any).shellIntegration;
  const cwdUri: vscode.Uri | undefined = integration?.cwd;
  if (cwdUri && cwdUri.scheme === 'file') return cwdUri.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
