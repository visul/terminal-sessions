import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND, getConfig, setSortMode, SidebarSortMode, SORT_MODES } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';
import { openTerminalForSession, findTerminalForSession, metaIconAndColor } from './profile-provider';
import { currentWorkspace, hashPath, sessionName as buildSessionName, parseSessionName } from './workspace-id';
import { SessionTreeItem } from './sidebar/items';
import { refreshSidebar } from './sidebar/tree-provider';
import { humanAge, sleep } from './util';
import { maybeOfferRestore } from './restore';
import { notify } from './notifications';
import { ClaudeTracker, installClaudeHook, uninstallClaudeHook, isClaudeHookInstalled } from './claude-tracker';
import { ClaudeSearchIndex, SessionIndexEntry } from './claude-search';
import { transcriptPathFor } from './claude-transcript';

async function requireTmux(): Promise<string | undefined> {
  const cfg = getConfig();
  const p = await tmux.detectTmuxPath(cfg.tmuxPath);
  if (!p) {
    vscode.window.showErrorMessage('tmux is not installed. Run: brew install tmux');
    return undefined;
  }
  return p;
}

export function registerCommands(
  ctx: vscode.ExtensionContext,
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  searchIndex: ClaudeSearchIndex,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.newPersistent, () => cmdNewPersistent(index)),
    vscode.commands.registerCommand(COMMAND.newPersistentInFolder, (uri?: vscode.Uri) => cmdNewPersistent(index, uri)),
    vscode.commands.registerCommand(COMMAND.attachTo, (item?: SessionTreeItem) => cmdAttachTo(index, item)),
    vscode.commands.registerCommand(COMMAND.kill, (item?: SessionTreeItem) => cmdKill(index, item)),
    vscode.commands.registerCommand(COMMAND.killWorkspace, () => cmdKillWorkspace(index)),
    vscode.commands.registerCommand(COMMAND.killAllStale, () => cmdKillStale(index)),
    vscode.commands.registerCommand(COMMAND.preview, (item?: SessionTreeItem) => cmdPreview(item)),
    vscode.commands.registerCommand(COMMAND.rename, (item?: SessionTreeItem) => cmdRename(index, item)),
    vscode.commands.registerCommand(COMMAND.refreshSidebar, () => refreshSidebar()),
    vscode.commands.registerCommand(COMMAND.revealSidebar,
      () => vscode.commands.executeCommand('workbench.view.extension.terminalSessionsContainer')),
    vscode.commands.registerCommand(COMMAND.resumeAll, () => cmdResumeAll(index)),
    vscode.commands.registerCommand(COMMAND.setAsDefaultProfile, () => cmdSetDefaultProfile()),
    vscode.commands.registerCommand(COMMAND.openTmuxConfig, () => cmdOpenTmuxConfig()),
    vscode.commands.registerCommand(COMMAND.reloadTmuxConfig, () => cmdReloadTmuxConfig()),
    vscode.commands.registerCommand(COMMAND.setIcon, (item?: SessionTreeItem) => cmdSetIcon(index, item)),
    vscode.commands.registerCommand(COMMAND.setColor, (item?: SessionTreeItem) => cmdSetColor(index, item)),
    vscode.commands.registerCommand(COMMAND.mirror, (item?: SessionTreeItem) => cmdMirror(index, item)),
    vscode.commands.registerCommand(COMMAND.restoreFromIndex, () => cmdRestoreFromIndex(index, claudeTracker)),
    vscode.commands.registerCommand(COMMAND.testNotification, () => cmdTestNotification()),
    vscode.commands.registerCommand(COMMAND.installClaudeHook, () => cmdInstallClaudeHook(claudeTracker)),
    vscode.commands.registerCommand(COMMAND.uninstallClaudeHook, () => cmdUninstallClaudeHook()),
    vscode.commands.registerCommand(COMMAND.restart, (item?: SessionTreeItem) => cmdRestart(index, claudeTracker, item)),
    vscode.commands.registerCommand(COMMAND.pickSortMode, () => cmdPickSortMode(index)),
    vscode.commands.registerCommand(COMMAND.findSession, () => cmdFindSession(searchIndex)),
    vscode.commands.registerCommand(COMMAND.fixClaudeRendering, () => cmdFixClaudeRendering()),
    vscode.commands.registerCommand(COMMAND.toggleAllAlerts, () => cmdSetAllAlerts()),
    vscode.commands.registerCommand(COMMAND.alertsEnable, () => cmdSetAllAlerts(true)),
    vscode.commands.registerCommand(COMMAND.alertsDisable, () => cmdSetAllAlerts(false)),
    vscode.commands.registerCommand(COMMAND.muteSession, (item?: SessionTreeItem) => cmdSetSessionMuted(index, item, true)),
    vscode.commands.registerCommand(COMMAND.unmuteSession, (item?: SessionTreeItem) => cmdSetSessionMuted(index, item, false)),
  );

  // Keep a VS Code context var in sync with the global alert setting so the
  // view-title icon can toggle its appearance via "when" clauses.
  const syncAlertsContext = () => {
    const on = vscode.workspace.getConfiguration('terminalSessions').get<boolean>('notifyOnClaudeWaiting', true);
    void vscode.commands.executeCommand('setContext', 'terminalSessions.alertsEnabled', on);
  };
  syncAlertsContext();
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('terminalSessions.notifyOnClaudeWaiting')) syncAlertsContext();
  }));
}

async function cmdSetAllAlerts(value?: boolean): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  const current = c.get<boolean>('notifyOnClaudeWaiting', true);
  const next = value === undefined ? !current : value;
  if (next === current) return;
  await c.update('notifyOnClaudeWaiting', next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Claude waiting alerts ${next ? 'enabled' : 'disabled'} globally.`,
  );
}

async function cmdSetSessionMuted(
  index: SessionIndex,
  item: SessionTreeItem | undefined,
  muted: boolean,
): Promise<void> {
  if (!item) {
    vscode.window.showErrorMessage('Use the sidebar context menu on a session.');
    return;
  }
  const name = item.session.name;
  const parsed = parseSessionName(name, getConfig().sessionPrefix);
  if (!parsed) return;
  index.setSessionMuted(parsed.hash, name, muted);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `${item.session.label || name}: notifications ${muted ? 'muted' : 'unmuted'}.`,
  );
}

async function cmdFixClaudeRendering(): Promise<void> {
  const shell = process.env.SHELL || '';
  const home = process.env.HOME || os.homedir();
  const rcFile = shell.includes('zsh') ? '.zshrc'
    : shell.includes('bash') ? '.bashrc'
    : shell.includes('fish') ? '.config/fish/config.fish'
    : '.profile';
  const rcPath = path.join(home, rcFile);
  const isFish = rcFile.endsWith('config.fish');

  // DISABLE_MOUSE_CLICKS (not DISABLE_MOUSE): clicks go to tmux so you can
  // select panes natively, but scroll events still reach Claude Code so the
  // trackpad scrolls the conversation view. DISABLE_MOUSE=1 would break
  // trackpad scroll inside Claude.
  const EXPORTS = [
    'export CLAUDE_CODE_NO_FLICKER=1',
    'export CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
  ];
  const FISH_SET = [
    'set -gx CLAUDE_CODE_NO_FLICKER 1',
    'set -gx CLAUDE_CODE_DISABLE_MOUSE_CLICKS 1',
  ];
  const lines = isFish ? FISH_SET : EXPORTS;
  const block = '\n# Terminal Sessions — Claude Code rendering fix\n' + lines.join('\n') + '\n';

  // Match the old DISABLE_MOUSE var (without _CLICKS) so we can migrate users
  // who ran an earlier iteration of this command.
  const oldMouseLine = isFish
    ? /^set -gx CLAUDE_CODE_DISABLE_MOUSE 1\s*$/m
    : /^export CLAUDE_CODE_DISABLE_MOUSE=1\s*$/m;
  const newMouseLine = lines[1];

  let existing = '';
  try { existing = fs.readFileSync(rcPath, 'utf8'); } catch { /* file may not exist yet */ }

  const alreadyFullyPresent = lines.every((l: string) => existing.includes(l));
  if (alreadyFullyPresent) {
    const action = await vscode.window.showInformationMessage(
      `The Claude Code rendering env vars are already in ~/${rcFile}. `
      + 'Open a new shell (or restart the tmux pane) to pick them up in a running Claude session.',
      'Open rc file',
    );
    if (action === 'Open rc file') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rcPath));
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  // Migration path: user has the old DISABLE_MOUSE=1 line (broke trackpad
  // scroll in Claude). Replace it in place.
  if (oldMouseLine.test(existing)) {
    const choice = await vscode.window.showInformationMessage(
      `Your ~/${rcFile} has an older variant (CLAUDE_CODE_DISABLE_MOUSE=1) that blocks `
      + 'trackpad scroll inside Claude Code. Replace with CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 '
      + '(clicks still go to tmux, wheel reaches Claude)?',
      { modal: true },
      'Replace', 'Cancel',
    );
    if (choice !== 'Replace') return;
    let updated = existing.replace(oldMouseLine, newMouseLine);
    // Ensure NO_FLICKER also present (it was paired with the old var).
    if (!updated.includes(lines[0])) updated += '\n' + lines[0] + '\n';
    try {
      fs.writeFileSync(rcPath, updated);
      vscode.window.showInformationMessage(
        `Updated ~/${rcFile}. Open a new shell (or restart the tmux pane) to activate.`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Could not write to ${rcPath}: ${String(e).slice(0, 120)}`);
    }
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Append Claude Code rendering env vars to ~/${rcFile}?\n\n`
    + lines.join('\n') + '\n\n'
    + 'These put Claude Code into fullscreen (alt-screen) mode so the scrollback '
    + 'stays clean, and route trackpad scroll to Claude (clicks still go to tmux '
    + 'for pane select). Copy text from Claude: press Ctrl+O then [ to dump the '
    + 'conversation into tmux scrollback, then drag-select normally.\n\n'
    + 'Requires Claude Code ≥ 2.1.110. Running tmux panes pick up the change only '
    + 'after Restart Session + relaunch of claude.',
    { modal: true },
    'Append', 'Show only (I paste manually)',
  );
  if (!choice) return;
  if (choice === 'Show only (I paste manually)') {
    const doc = await vscode.workspace.openTextDocument({
      content: block,
      language: isFish ? 'fish' : 'shellscript',
    });
    await vscode.window.showTextDocument(doc);
    return;
  }
  try {
    fs.appendFileSync(rcPath, block);
    vscode.window.showInformationMessage(
      `Appended env vars to ~/${rcFile}. Open a new terminal (or reload shell) to activate. `
      + 'Note: running tmux panes need to be restarted to pick up the new environment.',
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Could not write to ${rcPath}: ${String(e).slice(0, 120)}`);
  }
}

async function cmdFindSession(searchIndex: ClaudeSearchIndex): Promise<void> {
  // Best-effort refresh in the background while the picker is open
  void searchIndex.refresh();
  interface Pick extends vscode.QuickPickItem { entry: SessionIndexEntry }
  const qp = vscode.window.createQuickPick<Pick>();
  qp.placeholder = 'Search Claude sessions by prompt, cwd, or session id…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const render = (q: string): void => {
    const entries = q ? searchIndex.search(q) : searchIndex.list();
    qp.items = entries.slice(0, 100).map(e => ({
      label: e.title || '(no prompt)',
      description: `${path.basename(e.cwd || '')} · ${e.turns} turns · ${humanAge(new Date(e.lastModified))}`,
      detail: e.lastPrompt !== e.firstPrompt ? `last: ${e.lastPrompt}` : undefined,
      entry: e,
    }));
  };
  qp.onDidChangeValue(render);
  render('');
  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (!sel) return;
    await openSessionActions(sel.entry);
  });
  qp.show();
}

async function openSessionActions(entry: SessionIndexEntry): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(file-code) Open transcript file', action: 'open' as const },
      { label: '$(copy) Copy session ID', action: 'copyId' as const },
      { label: '$(folder-opened) Reveal cwd in OS', action: 'revealCwd' as const },
    ],
    { placeHolder: entry.title || entry.sessionId },
  );
  if (!pick) return;
  switch (pick.action) {
    case 'open': {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.transcriptPath));
      await vscode.window.showTextDocument(doc, { preview: true });
      break;
    }
    case 'copyId':
      await vscode.env.clipboard.writeText(entry.sessionId);
      vscode.window.setStatusBarMessage(`Copied session ID ${entry.sessionId}`, 2500);
      break;
    case 'revealCwd':
      if (entry.cwd) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.cwd));
      }
      break;
  }
}

const SORT_MODE_LABELS: Record<SidebarSortMode, { label: string; detail: string }> = {
  custom: {
    label: 'Custom',
    detail: 'Drag sessions in the sidebar to set your own order',
  },
  mru: {
    label: 'Recently used',
    detail: 'Most recently focused session first',
  },
  created: {
    label: 'Creation order',
    detail: 'Oldest session first (default)',
  },
  alphabetical: {
    label: 'Alphabetical',
    detail: 'By session label (A to Z)',
  },
};

async function cmdPickSortMode(index: SessionIndex): Promise<void> {
  const current = getConfig().sidebarSortMode;
  interface Pick extends vscode.QuickPickItem { mode: SidebarSortMode }
  const items: Pick[] = SORT_MODES.map(m => {
    const meta = SORT_MODE_LABELS[m];
    return {
      label: m === current ? `$(check) ${meta.label}` : `     ${meta.label}`,
      detail: meta.detail,
      mode: m,
    };
  });
  items.push({
    label: '     Reset custom order',
    detail: 'Clear drag-reorder memory for every workspace (sort mode unchanged)',
    mode: current,
    description: 'reset',
  } as Pick & { description: string });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Sidebar sort (current: ${SORT_MODE_LABELS[current].label})`,
  });
  if (!pick) return;
  if ((pick as Pick & { description?: string }).description === 'reset') {
    for (const hash of Object.keys(index.getAllWorkspaces())) {
      index.clearWorkspaceSortOrder(hash);
    }
    refreshSidebar();
    vscode.window.setStatusBarMessage('Terminal Sessions: custom order cleared', 2500);
    return;
  }
  if (pick.mode === current) return;
  await setSortMode(pick.mode);
  refreshSidebar();
  vscode.window.setStatusBarMessage(
    `Terminal Sessions: sort → ${SORT_MODE_LABELS[pick.mode].label}`,
    2500,
  );
}

async function cmdRestart(
  index: SessionIndex,
  claudeTracker: ClaudeTracker,
  item?: SessionTreeItem,
): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name = item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string; wsHash: string; wsPath: string }
    const picks: Pick[] = all.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      sessionName: s.name,
      wsHash: s.workspaceHash,
      wsPath: s.workspacePath,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, {
      placeHolder: 'Restart which session? (kills any running process, keeps label/icon/color)',
    });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const ws = index.getWorkspace(parsed.hash);
  if (!ws) return;
  const meta = index.getSessionMeta(parsed.hash, name);
  const labelDisplay = meta?.label ? `"${meta.label}"` : `#${parsed.tabId}`;

  // Detect Claude session so we can auto-resume the conversation after restart.
  // Also verify the transcript file is still on disk — Claude prunes old
  // transcripts and the tracker's map can hold stale entries.
  let claudeSessionId = claudeTracker.getSessionId(name);
  if (claudeSessionId) {
    if (!fs.existsSync(transcriptPathFor(ws.path, claudeSessionId))) {
      claudeSessionId = undefined; // stale — transcript was deleted
    }
  }
  const claudeLine = claudeSessionId
    ? `\n\nDetected Claude session ${claudeSessionId.slice(0, 8)}… — will auto-run "claude --resume" after restart.`
    : '';

  const confirm = await vscode.window.showWarningMessage(
    `Restart session ${labelDisplay}?\n\nKills the current tmux session (any running program in it, including Claude Code) and creates a fresh empty shell with the same name, workspace, icon, and color.${claudeLine}`,
    { modal: true }, 'Restart',
  );
  if (confirm !== 'Restart') return;

  try {
    await tmux.killSession(tmuxPath, name);
    // Close the now-orphaned VS Code tab (the shell inside it sees its tmux
    // session die and hangs on "process exited"). Without this, the next open
    // finds the dead tab and any sendText goes nowhere. dispose() is sync on
    // our side but the actual close fires onDidCloseTerminal async — wait for
    // it (with a 500 ms ceiling) before creating the replacement.
    const dead = findTerminalForSession(name);
    if (dead) await disposeAndWait(dead, 500);
    // recordSession keeps existing label/icon/color; just ensures entry exists.
    index.recordSession(parsed.hash, name);
    await tmux.createDetachedSession(tmuxPath, name, ws.path);
    const term = await openTerminalForSession(name, ws.path, index, true);
    if (term && claudeSessionId) {
      // Give the shell a moment to init (rc files, prompt) before sending
      // the resume command. Heavy zshrc / oh-my-zsh setups need > 1 s.
      await sleep(1500);
      // Between openTerminalForSession() returning and now, the user may have
      // closed the tab manually. Verify liveness before firing into the void.
      if (vscode.window.terminals.includes(term)) {
        try { term.sendText(`claude --resume ${claudeSessionId}`); }
        catch (e) { console.error('[terminal-sessions] sendText failed:', e); }
      }
    }
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Restart failed: ${String(e).slice(0, 200)}`);
  }
}

/**
 * Dispose a terminal and wait for its onDidCloseTerminal event (or timeout).
 * VS Code's dispose() is synchronous on our side but the teardown + close
 * event fire on a later tick; a subsequent createTerminal with the same name
 * can race the tear-down if we don't wait.
 */
function disposeAndWait(term: vscode.Terminal, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; sub.dispose(); clearTimeout(timer); resolve(); };
    const sub = vscode.window.onDidCloseTerminal((t) => { if (t === term) finish(); });
    const timer = setTimeout(finish, timeoutMs);
    try { term.dispose(); } catch { finish(); }
  });
}

async function cmdInstallClaudeHook(tracker: ClaudeTracker): Promise<void> {
  if (isClaudeHookInstalled()) {
    const redo = await vscode.window.showInformationMessage(
      'Claude hook already installed. Reinstall to refresh script path?',
      'Reinstall', 'Cancel',
    );
    if (redo !== 'Reinstall') return;
  }
  const ok = await installClaudeHook(tracker.hookScriptPath);
  if (ok) {
    vscode.window.showInformationMessage(
      'Claude hook installed. Next time you run `claude` in a tmux session, it will be tracked.',
    );
  }
}

async function cmdUninstallClaudeHook(): Promise<void> {
  const ok = await uninstallClaudeHook();
  if (ok) {
    vscode.window.showInformationMessage('Claude hook removed from ~/.claude/settings.json.');
  } else {
    vscode.window.showWarningMessage('Could not uninstall — check ~/.claude/settings.json manually.');
  }
}

async function cmdTestNotification(): Promise<void> {
  await notify({
    title: '✓ Test notification',
    subtitle: 'Terminal Sessions',
    body: 'macOS Notification Center works. Adjust sound & mode in settings.',
  });
}

async function cmdRestoreFromIndex(index: SessionIndex, claudeTracker: ClaudeTracker): Promise<void> {
  const result = await maybeOfferRestore(index, claudeTracker);
  if (!result.ran) {
    vscode.window.showInformationMessage(
      'Nothing to restore — either live sessions already exist, or the index has no entries for this workspace.',
    );
  }
}

// ── Terminal name helpers ────────────────────────────────────────────────

function defaultTermName(wsLabel: string, tabId: number, label?: string): string {
  const trimmed = (label || '').trim();
  if (trimmed.length > 0) return `${trimmed} #${tabId}`;
  return `${wsLabel}#${tabId}`;
}

// ── Tmux config commands ─────────────────────────────────────────────────

async function cmdOpenTmuxConfig(): Promise<void> {
  const uri = vscode.Uri.file(tmux.CONF_PATH);
  try {
    await vscode.window.showTextDocument(uri);
  } catch {
    vscode.window.showErrorMessage(`tmux.conf not found at ${tmux.CONF_PATH}. Reload the extension to regenerate it.`);
  }
}

async function cmdReloadTmuxConfig(): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  try {
    await tmux.reloadConfig(tmuxPath);
    vscode.window.showInformationMessage('tmux config reloaded. Existing sessions use the new settings.');
  } catch (e) {
    vscode.window.showWarningMessage(`Could not reload — is a persistent terminal open? (${String(e).slice(0, 100)})`);
  }
}

// ── Session lifecycle commands ───────────────────────────────────────────

async function cmdNewPersistent(index: SessionIndex, targetUri?: vscode.Uri): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();

  let wsPath: string;
  let wsHash: string;
  let wsLabel: string;
  let cwd: string;
  let folderLabel: string | undefined;

  if (targetUri) {
    let folderPath = targetUri.fsPath;
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      if (stat.type !== vscode.FileType.Directory) folderPath = path.dirname(folderPath);
    } catch { /* assume directory */ }
    cwd = folderPath;
    const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath));
    if (wsFolder) {
      wsPath = wsFolder.uri.fsPath;
      wsHash = hashPath(wsPath);
      wsLabel = wsFolder.name || path.basename(wsPath);
    } else {
      wsPath = folderPath;
      wsHash = hashPath(folderPath);
      wsLabel = path.basename(folderPath);
    }
    const sub = path.basename(folderPath);
    if (folderPath !== wsPath) folderLabel = sub;
  } else {
    const ws = currentWorkspace();
    if (!ws) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
    wsPath = ws.path;
    wsHash = ws.hash;
    wsLabel = ws.label;
    cwd = ws.path;
  }

  index.recordWorkspace(wsHash, wsPath, wsLabel);
  const tabId = index.getNextTabId(wsHash, cfg.sessionPrefix);
  const name = buildSessionName(cfg.sessionPrefix, wsHash, tabId);
  index.recordSession(wsHash, name, folderLabel);
  const meta = index.getSessionMeta(wsHash, name);
  const { icon, color } = metaIconAndColor(meta);
  const termName = defaultTermName(wsLabel, tabId, meta?.label);
  const term = vscode.window.createTerminal({
    name: termName,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachOrCreateArgs(name, cwd),
    cwd,
    iconPath: icon,
    color,
  });
  term.show();
  refreshSidebar();
}

async function cmdAttachTo(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name: string | undefined = item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    if (all.length === 0) {
      vscode.window.showInformationMessage('No persistent sessions found.');
      return;
    }
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const picks: Pick[] = all.map(s => ({
      label: `$(${s.icon || (s.attached ? 'pass-filled' : 'circle-outline')}) ${s.label || `#${s.tabId}`}`,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      detail: s.workspacePath,
      sessionName: s.name,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Select a session to attach to' });
    if (!pick) return;
    name = pick.sessionName;
  }
  await openTerminalForSession(name, undefined, index);
  refreshSidebar();
}

async function cmdKill(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name = item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const picks: Pick[] = all.map(s => ({
      label: s.label || s.name,
      description: s.workspaceLabel,
      sessionName: s.name,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Kill which session?' });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsedForLabel = parseSessionName(name, cfg.sessionPrefix);
  const label = parsedForLabel ? index.getSessionLabel(parsedForLabel.hash, name) : undefined;
  const displayName = label ? `"${label}" (${name})` : name;
  const confirm = await vscode.window.showWarningMessage(
    `Kill session ${displayName}? All processes inside will terminate.`,
    { modal: true }, 'Kill',
  );
  if (confirm !== 'Kill') return;
  await tmux.killSession(tmuxPath, name);
  if (parsedForLabel) index.removeSession(parsedForLabel.hash, name);
  refreshSidebar();
}

async function cmdKillWorkspace(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const ws = currentWorkspace();
  if (!ws) return;
  const cfg = getConfig();
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  const mine = all.filter(s => s.workspaceHash === ws.hash);
  if (mine.length === 0) {
    vscode.window.showInformationMessage('No sessions to kill in this workspace.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Kill all ${mine.length} sessions for "${ws.label}"?`,
    { modal: true }, 'Kill All',
  );
  if (confirm !== 'Kill All') return;
  for (const s of mine) {
    await tmux.killSession(tmuxPath, s.name);
    index.removeSession(s.workspaceHash, s.name);
  }
  refreshSidebar();
}

async function cmdKillStale(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  if (cfg.pruneAfterDays <= 0) {
    vscode.window.showInformationMessage('Stale pruning is disabled (pruneAfterDays = 0).');
    return;
  }
  const cutoff = Date.now() - cfg.pruneAfterDays * 86400_000;
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  const stale = all.filter(s => !s.attached && s.lastAttached.getTime() < cutoff);
  if (stale.length === 0) {
    vscode.window.showInformationMessage('No stale sessions.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Prune ${stale.length} session(s) older than ${cfg.pruneAfterDays} days?`,
    { modal: true }, 'Prune',
  );
  if (confirm !== 'Prune') return;
  for (const s of stale) {
    await tmux.killSession(tmuxPath, s.name);
    index.removeSession(s.workspaceHash, s.name);
  }
  refreshSidebar();
}

async function cmdPreview(item?: SessionTreeItem): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath || !item) return;
  const content = await tmux.capturePane(tmuxPath, item.session.name, 200);
  const header = item.session.label
    ? `# Preview — ${item.session.label} (${item.session.name})\n# Workspace: ${item.session.workspaceLabel}\n# Last attached: ${item.session.lastAttached.toLocaleString()}\n\n`
    : `# Preview — ${item.session.name}\n# Workspace: ${item.session.workspaceLabel}\n\n`;
  const doc = await vscode.workspace.openTextDocument({ content: header + content, language: 'log' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function cmdRename(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  if (!item) return;
  const current = item.session.label ? `"${item.session.label}"` : `#${item.session.tabId}`;
  const newLabel = await vscode.window.showInputBox({
    prompt: `Rename session ${current}`,
    value: item.session.label || '',
    placeHolder: 'e.g. claude-main, dev-server',
    validateInput: (v) => v.length > 60 ? 'Label too long (max 60 chars)' : null,
  });
  if (newLabel === undefined) return;
  index.setSessionLabel(item.session.workspaceHash, item.session.name, newLabel.trim());
  refreshSidebar();
}

async function cmdResumeAll(index: SessionIndex): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const ws = currentWorkspace();
  if (!ws) return;
  const cfg = getConfig();
  const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
  const mine = all.filter(s => s.workspaceHash === ws.hash && !s.attached);
  if (mine.length === 0) {
    vscode.window.showInformationMessage('No detached sessions to resume.');
    return;
  }
  for (const s of mine) {
    await openTerminalForSession(s.name, ws.path, index);
    await sleep(150);
  }
  refreshSidebar();
}

async function cmdSetDefaultProfile(): Promise<void> {
  const platformKey = process.platform === 'darwin' ? 'osx'
    : process.platform === 'linux' ? 'linux' : 'windows';
  const settingKey = `terminal.integrated.defaultProfile.${platformKey}`;
  await vscode.workspace.getConfiguration().update(
    settingKey, 'Persistent Session', vscode.ConfigurationTarget.Global,
  );
  vscode.window.showInformationMessage(
    `Set "${settingKey}" = "Persistent Session". New terminals will auto-wrap in tmux.`,
  );
}

// ── Icon / color / mirror commands ───────────────────────────────────────

const ICON_CHOICES: { label: string; id: string; desc: string }[] = [
  { label: '$(terminal-bash) terminal', id: 'terminal-bash', desc: 'Default' },
  { label: '$(robot) robot',            id: 'robot',         desc: 'AI agent / Claude Code' },
  { label: '$(rocket) rocket',          id: 'rocket',        desc: 'Deploy / production' },
  { label: '$(flame) flame',            id: 'flame',         desc: 'Dev server / hot reload' },
  { label: '$(bug) bug',                id: 'bug',           desc: 'Debug' },
  { label: '$(beaker) beaker',          id: 'beaker',        desc: 'Experiment / test' },
  { label: '$(database) database',      id: 'database',      desc: 'Database / SQL' },
  { label: '$(globe) globe',            id: 'globe',         desc: 'Web / HTTP' },
  { label: '$(server) server',          id: 'server',        desc: 'Server / backend' },
  { label: '$(tools) tools',            id: 'tools',         desc: 'Build / compile' },
  { label: '$(package) package',        id: 'package',       desc: 'Package manager' },
  { label: '$(eye) eye',                id: 'eye',           desc: 'Watch / monitor' },
  { label: '$(symbol-event) event',     id: 'symbol-event',  desc: 'Event / listener' },
  { label: '$(repo) repo',              id: 'repo',          desc: 'Git / version control' },
  { label: '$(tag) tag',                id: 'tag',           desc: 'Release / tag' },
  { label: '$(dashboard) dashboard',    id: 'dashboard',     desc: 'Metrics / status' },
  { label: '$(lightbulb) lightbulb',    id: 'lightbulb',     desc: 'Prototype' },
  { label: '$(zap) zap',                id: 'zap',           desc: 'Quick / ad-hoc' },
  { label: '$(close) Reset to default', id: '',              desc: 'Remove custom icon' },
];

const COLOR_CHOICES: { label: string; id: string }[] = [
  { label: '$(close) Default (no color)',     id: '' },
  { label: '$(circle-filled) Red',            id: 'terminal.ansiRed' },
  { label: '$(circle-filled) Green',          id: 'terminal.ansiGreen' },
  { label: '$(circle-filled) Yellow',         id: 'terminal.ansiYellow' },
  { label: '$(circle-filled) Blue',           id: 'terminal.ansiBlue' },
  { label: '$(circle-filled) Magenta',        id: 'terminal.ansiMagenta' },
  { label: '$(circle-filled) Cyan',           id: 'terminal.ansiCyan' },
  { label: '$(circle-filled) Bright Red',     id: 'terminal.ansiBrightRed' },
  { label: '$(circle-filled) Bright Green',   id: 'terminal.ansiBrightGreen' },
  { label: '$(circle-filled) Bright Yellow',  id: 'terminal.ansiBrightYellow' },
  { label: '$(circle-filled) Bright Blue',    id: 'terminal.ansiBrightBlue' },
  { label: '$(circle-filled) Bright Magenta', id: 'terminal.ansiBrightMagenta' },
  { label: '$(circle-filled) Bright Cyan',    id: 'terminal.ansiBrightCyan' },
];

async function cmdSetIcon(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar to set its icon.');
    return;
  }
  interface IconPick extends vscode.QuickPickItem { iconId: string }
  const picks: IconPick[] = ICON_CHOICES.map(c => ({ label: c.label, description: c.desc, iconId: c.id }));
  const pick = await vscode.window.showQuickPick<IconPick>(picks, { placeHolder: 'Pick an icon for this session' });
  if (!pick) return;
  index.setSessionIcon(item.session.workspaceHash, item.session.name, pick.iconId || undefined);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Icon ${pick.iconId ? `set to "${pick.iconId}"` : 'cleared'}. Will apply on next attach/create.`,
  );
}

async function cmdSetColor(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  if (!item) {
    vscode.window.showInformationMessage('Right-click a session in the sidebar to set its color.');
    return;
  }
  interface ColorPick extends vscode.QuickPickItem { colorId: string }
  const picks: ColorPick[] = COLOR_CHOICES.map(c => ({ label: c.label, colorId: c.id }));
  const pick = await vscode.window.showQuickPick<ColorPick>(picks, { placeHolder: 'Pick a color for this session' });
  if (!pick) return;
  index.setSessionColor(item.session.workspaceHash, item.session.name, pick.colorId || undefined);
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Color ${pick.colorId ? `set to "${pick.colorId}"` : 'cleared'}. Will apply on next attach/create.`,
  );
}

async function cmdMirror(index: SessionIndex, item?: SessionTreeItem): Promise<void> {
  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();
  let name = item?.session.name;
  if (!name) {
    const all = await enrichSessions(tmuxPath, cfg.sessionPrefix, index);
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const picks: Pick[] = all.map(s => ({
      label: s.label || `#${s.tabId}`,
      description: `${s.workspaceLabel} · ${s.attached ? 'attached' : 'detached'}`,
      sessionName: s.name,
    }));
    const pick = await vscode.window.showQuickPick<Pick>(picks, { placeHolder: 'Mirror which session in a new tab?' });
    if (!pick) return;
    name = pick.sessionName;
  }
  await openTerminalForSession(name, undefined, index, true);
  vscode.window.showInformationMessage('Mirror opened. Drag the new terminal tab to split side-by-side.');
  refreshSidebar();
}
