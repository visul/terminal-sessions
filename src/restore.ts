import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionIndex } from './session-manager';
import * as tmux from './tmux';
import { getConfig } from './config';
import { currentWorkspace, parseSessionName } from './workspace-id';
import { refreshSidebar } from './sidebar/tree-provider';
import { openTerminalForSession } from './profile-provider';
import { sleep } from './util';
import { SessionLabel } from './types';
import { ClaudeTracker } from './claude-tracker';

interface Candidate {
  sessionName: string;
  label: string;
  meta: SessionLabel;
}

export interface RestoreResult {
  ran: boolean;       // did we show a toast / take any user-visible action
  recreated: number;  // how many tmux sessions we created
  attached: number;   // how many terminals we opened attached
}

const EMPTY: RestoreResult = { ran: false, recreated: 0, attached: 0 };

/**
 * After a reboot (or any situation where tmux server died), tmux has no
 * sessions but our index still remembers them. Offer to recreate the sessions
 * AND immediately open attached terminals so the user's layout is restored
 * in one click.
 */
export async function maybeOfferRestore(
  index: SessionIndex,
  _claudeTracker?: ClaudeTracker,
): Promise<RestoreResult> {
  const cfg = getConfig();
  if (cfg.autoRestore === 'off') return EMPTY;
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!tmuxPath) return EMPTY;
  const ws = currentWorkspace();
  if (!ws) return EMPTY;

  // Any live tmux sessions for this workspace? If yes, normal resume handles it.
  const allRows = await tmux.listSessions(tmuxPath, cfg.sessionPrefix);
  const liveForWs = allRows.filter(r => {
    const parsed = parseSessionName(r.name, cfg.sessionPrefix);
    return parsed?.hash === ws.hash;
  });
  if (liveForWs.length > 0) return EMPTY;

  // Does the index remember any sessions for this workspace?
  const wsEntry = index.getWorkspace(ws.hash);
  if (!wsEntry) return EMPTY;
  const candidates: Candidate[] = Object.entries(wsEntry.sessions)
    .map(([sessionName, meta]) => ({
      sessionName,
      label: meta.label || sessionName,
      meta,
    }));
  if (candidates.length === 0) return EMPTY;

  const message = `Found ${candidates.length} session${candidates.length === 1 ? '' : 's'} from before restart in "${ws.label}". Recreate and attach?`;

  const choice = cfg.autoRestore === 'auto'
    ? 'Recreate & Attach'
    : await vscode.window.showInformationMessage(
        message,
        'Recreate & Attach',
        'Pick...',
        'Ignore',
      );

  if (!choice || choice === 'Ignore') return { ran: true, recreated: 0, attached: 0 };

  let toRecreate: Candidate[] = candidates;
  if (choice === 'Pick...') {
    interface Pick extends vscode.QuickPickItem { cand: Candidate }
    const items: Pick[] = candidates.map(c => ({
      label: c.meta.icon ? `$(${c.meta.icon}) ${c.label}` : c.label,
      description: c.sessionName,
      picked: true,
      cand: c,
    }));
    const picks = await vscode.window.showQuickPick<Pick>(items, {
      canPickMany: true,
      placeHolder: 'Select sessions to recreate (they will be attached immediately)',
    });
    if (!picks || picks.length === 0) return { ran: true, recreated: 0, attached: 0 };
    toRecreate = picks.map(p => p.cand);
  }

  let recreated = 0;
  let attached = 0;
  let failed = 0;

  for (const c of toRecreate) {
    try {
      await tmux.createDetachedSession(tmuxPath, c.sessionName, wsEntry.path);
      recreated++;
      const term = await openTerminalForSession(c.sessionName, wsEntry.path, index);
      if (term) attached++;
      await sleep(150);
    } catch (e) {
      console.error('[terminal-sessions] recreate failed:', c.sessionName, e);
      failed++;
    }
  }

  // Never inject commands into the terminal automatically. Show a hint so the
  // user can run `claude --resume <id>` themselves if they want.
  const hint = claudeResumeHint(wsEntry.path);
  const summary = `Restored ${attached}/${recreated} session${recreated === 1 ? '' : 's'}` +
    (failed > 0 ? ` (${failed} failed)` : '') +
    (hint ? `\n\n${hint}` : '');
  vscode.window.showInformationMessage(summary);
  refreshSidebar();
  return { ran: true, recreated, attached };
}

/**
 * If Claude Code wrote a JSONL file for this workspace, suggest a resume command
 * with the most recent session id.
 */
function claudeResumeHint(wsPath: string): string | undefined {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects', wsPath.replace(/\//g, '-'));
    if (!fs.existsSync(claudeDir)) return undefined;
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(claudeDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return undefined;
    const latest = files[0];
    const sessionId = latest.name.replace(/\.jsonl$/, '');
    const age = Math.floor((Date.now() - latest.mtime) / 60000);
    return `Last Claude session: \`claude --resume ${sessionId}\` (${age}m ago)`;
  } catch {
    return undefined;
  }
}
