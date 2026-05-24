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
import { transcriptPathFor } from './claude-transcript';

const SHELL_INIT_DELAY_MS = 1500;

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
  claudeTracker?: ClaudeTracker,
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
    .filter(([, meta]) => !meta.stopped)
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
  // Collect resume commands so we can fire them in a single batch after the
  // 1.5s shell-init wait. Doing it per-session would be 16 * 1.5s = 24s on a
  // big workspace; batching keeps it to ~1.5s total.
  const resumes: Array<{ term: vscode.Terminal; sessionId: string; label: string }> = [];

  for (const c of toRecreate) {
    try {
      // Honor per-session folderPath when set (subfolder sessions). Fall back
      // to the workspace root for plain workspace-level sessions.
      const cwd = c.meta.folderPath || wsEntry.path;
      await tmux.createDetachedSession(tmuxPath, c.sessionName, cwd);
      recreated++;
      const term = await openTerminalForSession(c.sessionName, cwd, index);
      if (term) attached++;
      // Pre-pull the Claude resume id, mirroring cmdStart's logic so reboot
      // recovery and Stop->Start behave the same. Prefer live tracker (rare
      // post-reboot since the in-memory map is empty), then the persisted
      // index. Transcript existence check uses the session's folder path —
      // subfolder sessions write to a different Claude project directory.
      let claudeSessionId: string | undefined;
      if (term) {
        claudeSessionId = claudeTracker?.getSessionId(c.sessionName)
          || c.meta.lastClaudeSessionId;
        if (claudeSessionId && !fs.existsSync(transcriptPathFor(cwd, claudeSessionId))) {
          claudeSessionId = undefined;
        }
        if (claudeSessionId) {
          resumes.push({ term, sessionId: claudeSessionId, label: c.label });
        }
      }
      await sleep(150);
    } catch (e) {
      console.error('[terminal-sessions] recreate failed:', c.sessionName, e);
      failed++;
    }
  }

  // Auto-fire `claude --resume <id>` per recreated session. Batched after one
  // shell-init wait so heavy zsh rc files have time to finish before sendText
  // lands in a prompt that actually reads it.
  let resumed = 0;
  if (resumes.length > 0) {
    await sleep(SHELL_INIT_DELAY_MS);
    for (const r of resumes) {
      if (!vscode.window.terminals.includes(r.term)) continue;
      try {
        r.term.sendText(`claude --resume ${r.sessionId}`);
        resumed++;
      } catch (e) {
        console.error('[terminal-sessions] resume sendText failed:', r.label, e);
      }
    }
  }

  const summary = `Restored ${attached}/${recreated} session${recreated === 1 ? '' : 's'}` +
    (failed > 0 ? ` (${failed} failed)` : '') +
    (resumed > 0 ? ` · auto-resumed Claude in ${resumed}` : '');
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
