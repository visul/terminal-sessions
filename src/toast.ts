import * as vscode from 'vscode';
import { getConfig } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';
import { currentWorkspace } from './workspace-id';
import { openTerminalForSession } from './profile-provider';
import { refreshSidebar } from './sidebar/tree-provider';
import { humanAge, sleep } from './util';

export async function maybePromptResume(index: SessionIndex): Promise<void> {
  const cfg = getConfig();
  if (cfg.autoRestore === 'off') return;
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!tmuxPath) return;
  const ws = currentWorkspace();
  if (!ws) return;

  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  const cutoff = Date.now() - cfg.autoRestoreMaxAgeHours * 3600_000;
  const mine = all.filter(s =>
    s.workspaceHash === ws.hash &&
    !s.attached &&
    s.lastAttached.getTime() >= cutoff,
  );
  if (mine.length === 0) return;

  if (cfg.autoRestore === 'auto') {
    await resumeMany(mine, ws.path, index);
    return;
  }

  const summary = mine.slice(0, 3).map(s => s.label || `#${s.tabId}`).join(', ')
    + (mine.length > 3 ? `, +${mine.length - 3} more` : '');
  const choice = await vscode.window.showInformationMessage(
    `Found ${mine.length} persistent session${mine.length === 1 ? '' : 's'} from last time in "${ws.label}": ${summary}`,
    'Resume All', 'Pick...', 'Ignore',
  );

  if (choice === 'Resume All') {
    await resumeMany(mine, ws.path, index);
  } else if (choice === 'Pick...') {
    const items = mine.map(s => ({
      label: s.label || `#${s.tabId}`,
      description: s.name,
      detail: `${humanAge(s.lastAttached)}`,
      picked: true,
      name: s.name,
    }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select sessions to resume',
    });
    if (!picks) return;
    for (const p of picks) {
      await openTerminalForSession(p.name, ws.path, index);
      await sleep(150);
    }
    refreshSidebar();
  }
}

async function resumeMany(sessions: { name: string }[], cwd: string, index: SessionIndex): Promise<void> {
  for (const s of sessions) {
    await openTerminalForSession(s.name, cwd, index);
    await sleep(150);
  }
  refreshSidebar();
}
