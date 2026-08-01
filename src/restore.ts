import * as vscode from 'vscode';
import * as fs from 'fs';
import { SessionIndex } from './session-manager';
import * as tmux from './tmux';
import { getConfig } from './config';
import { currentWorkspace, parseSessionName } from './workspace-id';
import { refreshSidebar } from './sidebar/tree-provider';
import { openTerminalForSession } from './profile-provider';
import { sleep } from './util';
import { SessionLabel } from './types';
import { ClaudeTracker } from './claude-tracker';
import { findTranscriptBySessionId, readTranscriptCwd } from './claude-transcript';
import { AgentRegistry } from './agents/registry';
import type { AgentProvider } from './agents/types';

const SHELL_INIT_DELAY_MS = 1500;

/** True when `child` is `parent` or a descendant of it. Both must be absolute and
 *  normalized. Mirrors the helper in commands.ts; kept local to avoid a cross-module
 *  import cycle. Used so reboot-restore's auto-resume stays strictly per-session-scope
 *  and never resumes a foreign workspace's conversation into a recreated pane. */
function isCwdUnder(parent: string, child: string | undefined): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const p = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(p);
}

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
  registry: AgentRegistry,
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
  const resumes: Array<{
    term: vscode.Terminal;
    provider: AgentProvider;
    sessionName: string;
    sessionId: string;
    label: string;
    transcriptPath?: string;
    cwd: string;
    flags: string[];
  }> = [];

  // Decide up front which conversation each pane resumes. A conversation runs in
  // ONE pane at a time — two panes resuming one id append to a single transcript
  // — and the cwd guard below cannot catch that, since sibling tabs on the same
  // folder both pass it. Two passes: every pane first takes only a conversation
  // it actually owns (held as its resume head, most recently recorded), then any
  // pane still empty takes whatever is left. Owner-first stops a tab that merely
  // glanced at a conversation from outranking the tab it belongs to; the second
  // pass stops a conversation nobody claimed from going unused.
  const plan = planResumes(index, registry, claudeTracker, toRecreate, ws.hash, wsEntry.path, cfg.sessionPrefix);

  for (const c of toRecreate) {
    try {
      // Honor per-session folderPath when set (subfolder sessions). Fall back
      // to the workspace root for plain workspace-level sessions.
      const cwd = c.meta.folderPath || wsEntry.path;
      try {
        await tmux.createDetachedSession(tmuxPath, c.sessionName, cwd);
      } catch (createErr) {
        // Reboot-restore race: a second window of the same workspace may have
        // recreated this session between our listSessions check above and now.
        // If it exists we adopt and attach it rather than reporting a spurious
        // failure and attaching nothing.
        if (!(await tmux.hasSession(tmuxPath, c.sessionName))) throw createErr;
      }
      recreated++;
      const term = await openTerminalForSession(c.sessionName, cwd, index);
      if (term) attached++;
      // Pre-pull the Claude resume id, mirroring cmdStart's logic so reboot
      // recovery and Stop->Start behave the same. Walk the full history so a
      // dead head sessionId (Claude prunes 0-turn ghosts) doesn't shadow the
      // real conversation sitting one or two slots deeper.
      if (term) {
        const parsed = parseSessionName(c.sessionName, cfg.sessionPrefix);
        const agent = parsed ? index.getLastAgent(parsed.hash, c.sessionName) : 'claude';
        const provider = registry.providerForAgent(agent);
        // Which conversation this pane gets was decided before any terminal was
        // created (see planResumes) so ownership can be weighed across the whole
        // batch rather than by whoever this loop reaches first.
        const planned = plan.get(c.sessionName);
        const resolvedSid = planned?.sessionId;
        const resolvedTp = planned?.transcriptPath;
        if (resolvedSid) {
          const flags = parsed ? index.getResumeFlags(parsed.hash, c.sessionName, agent) : [];
          resumes.push({ term, provider, sessionName: c.sessionName, sessionId: resolvedSid, label: c.label, transcriptPath: resolvedTp, cwd, flags });
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
        // The provider builds its own resume command and handles cd-to-recorded
        // -cwd when it's cwd-sensitive (Claude is; Codex restores cwd itself).
        // Hold each conversation for its pane until the agent boots, so a manual
        // Restart/Start moments after a restore can't resolve the same id.
        claudeTracker?.reserveResume(r.sessionId, r.sessionName);
        r.term.sendText(r.provider.buildResumeCommand(r.sessionId, r.cwd, r.transcriptPath, r.flags));
        resumed++;
      } catch (e) {
        console.error('[terminal-sessions] resume sendText failed:', r.label, e);
      }
    }
  }

  const summary = `Restored ${attached}/${recreated} session${recreated === 1 ? '' : 's'}` +
    (failed > 0 ? ` (${failed} failed)` : '') +
    (resumed > 0 ? ` · auto-resumed ${resumed}` : '');
  vscode.window.showInformationMessage(summary);
  refreshSidebar();
  return { ran: true, recreated, attached };
}

interface PlannedResume { sessionId: string; transcriptPath?: string }

/** Assign each candidate pane a distinct conversation. Owner-preferred first
 *  pass, then a free-for-all over what remains. Pure: reads the index and the
 *  filesystem, creates nothing. */
function planResumes(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker | undefined,
  candidates: readonly Candidate[],
  wsHash: string,
  wsPath: string,
  prefix: string,
): Map<string, PlannedResume> {
  const owners = index.conversationOwners(wsHash, candidates.map(c => c.sessionName));
  // Per pane: its ordered candidate ids and the transcript each resolves to.
  const viable = new Map<string, Array<{ sid: string; tp?: string; inScope: boolean; agent: string }>>();
  for (const c of candidates) {
    const cwd = c.meta.folderPath || wsPath;
    const parsed = parseSessionName(c.sessionName, prefix);
    const agent = parsed ? index.getLastAgent(parsed.hash, c.sessionName) : 'claude';
    const provider = registry.providerForAgent(agent);
    const liveSid = claudeTracker?.getSessionId(c.sessionName);
    const recorded = parsed ? index.getAgentSessionHistory(parsed.hash, c.sessionName, agent) : [];
    const seen = new Set<string>();
    const list: Array<{ sid: string; tp?: string; inScope: boolean; agent: string }> = [];
    for (const sid of [liveSid, ...recorded]) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const tp = provider.resolveTranscriptPath(sid, cwd, undefined);
      if (!tp || !fs.existsSync(tp)) continue;
      const tcwd = readTranscriptCwd(tp);
      // In-scope (transcript cwd under this pane's folder) is the real match; an
      // unreadable cwd is a last resort; a known-foreign cwd is never restored.
      if (tcwd && isCwdUnder(cwd, tcwd)) list.push({ sid, tp, inScope: true, agent });
      else if (!tcwd) list.push({ sid, tp, inScope: false, agent });
    }
    viable.set(c.sessionName, list);
  }

  const plan = new Map<string, PlannedResume>();
  const claimed = new Set<string>();
  const take = (name: string, ownedOnly: boolean): void => {
    if (plan.has(name)) return;
    const list = viable.get(name) ?? [];
    for (const pass of [true, false]) {           // in-scope first, then cwd-unknown
      for (const cand of list) {
        if (cand.inScope !== pass) continue;
        if (claimed.has(cand.sid)) continue;
        if (ownedOnly) {
          const owner = owners.get(`${cand.agent} ${cand.sid}`);
          if (owner && owner !== name) continue;
        }
        claimed.add(cand.sid);
        plan.set(name, { sessionId: cand.sid, transcriptPath: cand.tp });
        return;
      }
    }
  };
  for (const c of candidates) take(c.sessionName, true);
  for (const c of candidates) take(c.sessionName, false);
  return plan;
}
