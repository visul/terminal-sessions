# Stop / Start sessions + filter views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit Stop/Start commands so a tmux session can be killed without losing its sidebar entry, and a filter dropdown so users can switch between viewing All / Running only / Stopped only.

**Architecture:** Add a `stopped?: boolean` flag on the JSON-persisted `SessionLabel`. `enrichSessions` merges live tmux rows with stopped index entries to produce a unified `SessionInfo[]`. The sidebar renders stopped sessions with a muted `debug-stop` icon and a custom `resourceUri` that a `FileDecorationProvider` colors with `disabledForeground` (the only way to grey the label of a `TreeItem`). Three new commands — `stop`, `start`, `pickFilterMode` — plus a new `sidebarFilterMode` config string drive the UX.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.TreeView`, `FileDecorationProvider`, `window.createTreeView`), tmux CLI wrapper (`src/tmux.ts`), JSON file persistence (`~/.terminal-sessions/index.json`).

**Spec:** `docs/superpowers/specs/2026-05-24-stop-start-sessions-design.md`

**Note on TDD:** This project has no test suite (no `npm test` script, no `tests/` directory). The verification gate after each task is `npm run compile` (TypeScript build must succeed with zero errors) plus an optional manual reload-and-eyeball check in the Extension Development Host. The plan adapts the usual TDD shape accordingly — each task ends with a build check + commit.

---

## Task 1: Add `stopped` flag to data model + merge in `enrichSessions`

**Files:**
- Modify: `src/types.ts:30-43` (add `stopped` to `SessionLabel`)
- Modify: `src/types.ts:1-16` (add `stopped` to `SessionInfo`)
- Modify: `src/session-manager.ts` (new `setSessionStopped`, modify `enrichSessions`)

- [ ] **Step 1: Add `stopped?: boolean` to `SessionInfo` and `SessionLabel`**

Edit `src/types.ts` and add the field to both interfaces:

```typescript
export interface SessionInfo {
  name: string;
  workspaceHash: string;
  workspacePath: string;
  workspaceLabel: string;
  tabId: number;
  label?: string;
  icon?: string;
  color?: string;
  createdAt: Date;
  lastAttached: Date;
  lastActiveAt?: Date;
  sortOrder?: number;
  attached: boolean;
  muted?: boolean;
  stopped?: boolean;  // true when user clicked Stop; the tmux session is dead but the entry is kept
}
```

And:

```typescript
export interface SessionLabel {
  label?: string;
  icon?: string;
  color?: string;
  createdAt: string;
  lastActiveAt?: string;
  sortOrder?: number;
  muted?: boolean;
  folderPath?: string;
  stopped?: boolean;  // persisted: tmux session is intentionally killed but entry kept
}
```

- [ ] **Step 2: Add `setSessionStopped` helper on `SessionIndex`**

In `src/session-manager.ts`, add right after `setSessionMuted` (around line 104):

```typescript
  setSessionStopped(hash: string, sessionName: string, stopped: boolean): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (stopped) ws.sessions[sessionName].stopped = true;
    else delete ws.sessions[sessionName].stopped;
    this.save();
  }

  isSessionStopped(hash: string, sessionName: string): boolean {
    return this.data.workspaces[hash]?.sessions[sessionName]?.stopped === true;
  }
```

- [ ] **Step 3: Modify `enrichSessions` to merge stopped index entries**

Replace the `enrichSessions` function in `src/session-manager.ts` (around lines 162-196) with this version that walks both live tmux rows AND index entries with `stopped: true`:

```typescript
export async function enrichSessions(
  tmuxPath: string,
  prefix: string,
  index: SessionIndex,
): Promise<SessionInfo[]> {
  const rows = await tmux.listSessions(tmuxPath, prefix);
  const out: SessionInfo[] = [];
  const liveNames = new Set<string>();

  // 1. Live tmux rows
  for (const row of rows) {
    const parsed = parseSessionName(row.name, prefix);
    if (!parsed) continue;
    liveNames.add(row.name);
    const ws = index.getWorkspace(parsed.hash);
    const meta = index.getSessionMeta(parsed.hash, row.name);
    out.push({
      name: row.name,
      workspaceHash: parsed.hash,
      workspacePath: ws?.path || '',
      workspaceLabel: ws?.label || `(${parsed.hash})`,
      tabId: parsed.tabId,
      label: meta?.label,
      icon: meta?.icon,
      color: meta?.color,
      createdAt: new Date(row.created * 1000),
      lastAttached: new Date((row.lastAttached || row.created) * 1000),
      lastActiveAt: meta?.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
      sortOrder: meta?.sortOrder,
      attached: row.attached,
      muted: meta?.muted,
      stopped: false,
    });
  }

  // 2. Stopped index entries that have no live tmux row
  for (const [hash, ws] of Object.entries(index.getAllWorkspaces())) {
    for (const [sessionName, meta] of Object.entries(ws.sessions)) {
      if (!meta.stopped) continue;
      if (liveNames.has(sessionName)) continue;
      const parsed = parseSessionName(sessionName, prefix);
      if (!parsed) continue;
      const created = meta.createdAt ? new Date(meta.createdAt) : new Date(0);
      const lastActive = meta.lastActiveAt ? new Date(meta.lastActiveAt) : created;
      out.push({
        name: sessionName,
        workspaceHash: hash,
        workspacePath: ws.path,
        workspaceLabel: ws.label,
        tabId: parsed.tabId,
        label: meta.label,
        icon: meta.icon,
        color: meta.color,
        createdAt: created,
        lastAttached: lastActive,
        lastActiveAt: meta.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
        sortOrder: meta.sortOrder,
        attached: false,
        muted: meta.muted,
        stopped: true,
      });
    }
  }

  out.sort((a, b) => {
    if (a.workspaceLabel !== b.workspaceLabel) return a.workspaceLabel.localeCompare(b.workspaceLabel);
    return a.tabId - b.tabId;
  });
  return out;
}
```

- [ ] **Step 4: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors. (Stopped sessions don't render specially yet — that's Task 2.)

- [ ] **Step 5: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/types.ts src/session-manager.ts
git commit -m "feat(types): add stopped flag + merge stopped index entries in enrichSessions"
```

---

## Task 2: Render stopped sessions with muted icon + greyed-out label

**Files:**
- Modify: `src/sidebar/items.ts` (new render branch in `SessionTreeItem` for stopped state)
- Modify: `src/sidebar/tree-provider.ts` (register `FileDecorationProvider` for the custom URI scheme)
- Modify: `src/extension.ts` (wire up the decoration provider registration, or do it in `registerSidebar`)
- Reference: `src/sidebar/items.ts:88-194` (current `SessionTreeItem` ctor)

- [ ] **Step 1: Branch `SessionTreeItem` constructor for stopped state**

In `src/sidebar/items.ts`, replace the `SessionTreeItem` constructor body. The stopped branch returns early; the live branch is unchanged. Insert at the top of the constructor body, right after `super(label, collapsible)`:

```typescript
    // Stopped session: muted icon + greyed label via FileDecorationProvider,
    // single-click row to start, no Claude details (process is dead).
    if (session.stopped) {
      this.contextValue = 'session.stopped';
      this.iconPath = new vscode.ThemeIcon(
        'debug-stop',
        new vscode.ThemeColor('disabledForeground'),
      );
      const ageHint = humanAge(session.lastAttached);
      this.description = `stopped · idle ${ageHint}`;
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
      this.resourceUri = vscode.Uri.parse(
        `terminal-sessions-stopped:${encodeURIComponent(session.name)}`,
      );
      const displayHeader = session.label || `Session #${session.tabId}`;
      const parts = [
        `**${displayHeader}** _(stopped)_`,
        `ID: \`${session.name}\``,
        `Workspace: \`${session.workspacePath || session.workspaceLabel}\``,
        `Created: ${session.createdAt.toLocaleString()}`,
      ];
      if (claude?.sessionId) {
        parts.push(`Last Claude session: \`${claude.sessionId.slice(0, 8)}…\` (will auto-resume on Start)`);
      }
      parts.push(`Click to start.`);
      this.tooltip = new vscode.MarkdownString(parts.join('\n\n'));
      this.command = {
        command: 'terminalSessions.start',
        title: 'Start',
        arguments: [this],
      };
      return;
    }
```

This `return` short-circuits the existing live-session render logic. The existing logic below is unchanged.

- [ ] **Step 2: Register the `FileDecorationProvider`**

The decoration provider lives in `src/sidebar/tree-provider.ts` so it can be registered alongside the sidebar. Add this at the top of the file after the imports:

```typescript
const STOPPED_URI_SCHEME = 'terminal-sessions-stopped';

class StoppedSessionDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== STOPPED_URI_SCHEME) return undefined;
    return {
      color: new vscode.ThemeColor('disabledForeground'),
      tooltip: 'Stopped',
    };
  }
}
```

- [ ] **Step 3: Wire the provider into `registerSidebar`**

In `src/sidebar/tree-provider.ts`, inside `registerSidebar()`, right after `ctx.subscriptions.push(treeView)` and before `treeViewRef = treeView`:

```typescript
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new StoppedSessionDecorationProvider()),
  );
```

- [ ] **Step 4: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/sidebar/items.ts src/sidebar/tree-provider.ts
git commit -m "feat(sidebar): render stopped sessions with muted icon + greyed label"
```

---

## Task 3: `Stop` command — kill tmux but keep the entry

**Files:**
- Modify: `src/commands.ts` (new `cmdStop`, register it)
- Modify: `src/config.ts` (add `stop` to `COMMAND` map)
- Modify: `package.json` (declare command, add menu placements, tighten existing `=~ /^session/` to exclude stopped)
- Reference: `src/commands.ts:371-464` (existing `cmdRestart` for the kill+close pattern)

- [ ] **Step 1: Add `COMMAND.stop` constant**

In `src/config.ts`, add to the `COMMAND` object:

```typescript
  stop: 'terminalSessions.stop',
```

Place it adjacent to `restart` so related commands cluster together.

- [ ] **Step 2: Implement `cmdStop` in `src/commands.ts`**

Add this function at the end of `src/commands.ts` (or near `cmdRestart` for proximity). The function follows the kill-and-close pattern from `cmdRestart` but does NOT recreate the session:

```typescript
async function cmdStop(
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
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const live = all.filter(s => !s.stopped);
    const picks: Pick[] = live.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · ${humanAge(s.lastAttached)}`,
      sessionName: s.name,
    }));
    if (picks.length === 0) {
      vscode.window.showInformationMessage('No running sessions to stop.');
      return;
    }
    const pick = await vscode.window.showQuickPick<Pick>(picks, {
      placeHolder: 'Stop which session? (entry stays in sidebar, can be started again)',
    });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const label = index.getSessionLabel(parsed.hash, name);
  const labelDisplay = label ? `"${label}"` : name;

  // Confirm only if Claude is actively working/tool — silent otherwise.
  const snap = claudeTracker.getSnapshot(name);
  if (snap && (snap.state === 'working' || snap.state === 'tool')) {
    const confirm = await vscode.window.showWarningMessage(
      `Stop session ${labelDisplay}? Claude is currently working — its turn will be interrupted.`,
      { modal: true }, 'Stop',
    );
    if (confirm !== 'Stop') return;
  }

  try {
    await tmux.killSession(tmuxPath, name);
    const dead = findTerminalForSession(name);
    if (dead) await disposeAndWait(dead, 500);
    index.setSessionStopped(parsed.hash, name, true);
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Stop failed: ${String(e).slice(0, 200)}`);
  }
}
```

The `disposeAndWait` helper is already defined in `commands.ts` at line ~472 — reuse it directly.

- [ ] **Step 3: Register the command**

In `src/commands.ts → registerCommands`, add right after the `restart` line:

```typescript
    vscode.commands.registerCommand(COMMAND.stop, (item?: SessionTreeItem) => cmdStop(index, claudeTracker, item)),
```

- [ ] **Step 4: Declare the command + menu placements in `package.json`**

Add to `contributes.commands`:

```json
      {
        "command": "terminalSessions.stop",
        "title": "Stop Session (keep in sidebar)",
        "icon": "$(debug-pause)"
      },
```

Tighten the existing `=~ /^session/` regexes in `view/item/context` so live-only commands don't appear on `session.stopped` rows. The existing file has 10 entries with `=~ /^session/` (read the current `package.json` around lines 396-451 to confirm). Process them as follows:

**TIGHTEN to `=~ /^session($|\\.muted$)/`** (live-only — these actions don't make sense on a dead session):

| command                       | group       |
|-------------------------------|-------------|
| `terminalSessions.preview`    | `inline@1`  |
| `terminalSessions.mirror`     | `inline@2`  |
| `terminalSessions.restart`    | `inline@3`  |
| `terminalSessions.kill`       | `inline@4`  ← *also renumber to `inline@5` (see below)* |
| `terminalSessions.restart`    | `danger@0`  |
| `terminalSessions.mirror`     | `open@1`    |
| `terminalSessions.preview`    | `open@2`    |

**LEAVE as `=~ /^session/`** (still meaningful on stopped sessions):

| command                       | group       | rationale                              |
|-------------------------------|-------------|----------------------------------------|
| `terminalSessions.rename`     | `edit@1`    | user may rename while stopped           |
| `terminalSessions.setIcon`    | `edit@2`    | user may re-skin while stopped          |
| `terminalSessions.setColor`   | `edit@3`    | user may re-skin while stopped          |
| `terminalSessions.kill`       | `danger@1`  | Kill = full removal, valid in any state |

Replace each "TIGHTEN" entry's `"when"` value from:

```
"view == terminalSessions.sessions && viewItem =~ /^session/"
```

to:

```
"view == terminalSessions.sessions && viewItem =~ /^session($|\\.muted$)/"
```

Then add the new Stop entries. In `view/item/context`, after the existing restart entries:

```json
        {
          "command": "terminalSessions.stop",
          "when": "view == terminalSessions.sessions && viewItem =~ /^session($|\\.muted$)/",
          "group": "inline@4"
        },
        {
          "command": "terminalSessions.stop",
          "when": "view == terminalSessions.sessions && viewItem =~ /^session($|\\.muted$)/",
          "group": "danger@0"
        },
```

Renumber the existing `kill` inline group from `inline@4` to `inline@5` so Stop slots between Restart and Kill.

- [ ] **Step 5: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/commands.ts src/config.ts package.json
git commit -m "feat(commands): add Stop command — kill tmux but keep sidebar entry"
```

---

## Task 4: `Start` command — recreate tmux + auto-resume Claude

**Files:**
- Modify: `src/commands.ts` (new `cmdStart`, register it)
- Modify: `src/config.ts` (add `start` to `COMMAND`)
- Modify: `package.json` (declare command, menu placements for `session.stopped`)
- Reference: `src/commands.ts:436-459` (existing Claude `--resume` block in `cmdRestart`)

- [ ] **Step 1: Add `COMMAND.start` constant**

In `src/config.ts`, add to `COMMAND`:

```typescript
  start: 'terminalSessions.start',
```

- [ ] **Step 2: Implement `cmdStart`**

Add to `src/commands.ts`:

```typescript
async function cmdStart(
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
    interface Pick extends vscode.QuickPickItem { sessionName: string }
    const stopped = all.filter(s => s.stopped);
    const picks: Pick[] = stopped.map(s => ({
      label: s.label || s.name,
      description: `${s.workspaceLabel} · stopped`,
      sessionName: s.name,
    }));
    if (picks.length === 0) {
      vscode.window.showInformationMessage('No stopped sessions to start.');
      return;
    }
    const pick = await vscode.window.showQuickPick<Pick>(picks, {
      placeHolder: 'Start which session?',
    });
    if (!pick) return;
    name = pick.sessionName;
  }
  const parsed = parseSessionName(name, cfg.sessionPrefix);
  if (!parsed) return;
  const ws = index.getWorkspace(parsed.hash);
  if (!ws) return;
  const meta = index.getSessionMeta(parsed.hash, name);

  // Resolve cwd the same way cmdRestart does.
  let startCwd = meta?.folderPath || '';
  if (!startCwd) startCwd = ws.path;

  // Claude session id — same staleness check as cmdRestart.
  let claudeSessionId = claudeTracker.getSessionId(name);
  if (claudeSessionId) {
    if (!fs.existsSync(transcriptPathFor(ws.path, claudeSessionId))) {
      claudeSessionId = undefined;
    }
  }

  try {
    // If the tmux session somehow already exists (rare race), skip create and just attach.
    const exists = await tmux.hasSession(tmuxPath, name);
    if (!exists) await tmux.createDetachedSession(tmuxPath, name, startCwd);
    index.setSessionStopped(parsed.hash, name, false);
    const term = await openTerminalForSession(name, startCwd, index, true);
    if (term && claudeSessionId) {
      await sleep(1500);
      if (vscode.window.terminals.includes(term)) {
        try { term.sendText(`claude --resume ${claudeSessionId}`); }
        catch (e) { console.error('[terminal-sessions] sendText failed:', e); }
      }
    }
    refreshSidebar();
  } catch (e) {
    vscode.window.showErrorMessage(`Start failed: ${String(e).slice(0, 200)}`);
  }
}
```

- [ ] **Step 3: Register the command**

In `registerCommands`, after `stop`:

```typescript
    vscode.commands.registerCommand(COMMAND.start, (item?: SessionTreeItem) => cmdStart(index, claudeTracker, item)),
```

- [ ] **Step 4: Declare command + menus in `package.json`**

Add to `contributes.commands`:

```json
      {
        "command": "terminalSessions.start",
        "title": "Start Session",
        "icon": "$(play)"
      },
```

Add to `contributes.menus.view/item/context`:

```json
        {
          "command": "terminalSessions.start",
          "when": "view == terminalSessions.sessions && viewItem == session.stopped",
          "group": "inline@1"
        },
        {
          "command": "terminalSessions.start",
          "when": "view == terminalSessions.sessions && viewItem == session.stopped",
          "group": "open@0"
        },
```

Also add a Kill entry for stopped rows (it doesn't match the existing tightened regex anymore):

```json
        {
          "command": "terminalSessions.kill",
          "when": "view == terminalSessions.sessions && viewItem == session.stopped",
          "group": "inline@2"
        },
```

- [ ] **Step 5: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/commands.ts src/config.ts package.json
git commit -m "feat(commands): add Start command — recreate tmux + auto-resume Claude"
```

---

## Task 5: Filter config + apply in tree + workspace count update

**Files:**
- Modify: `src/config.ts` (new `SidebarFilterMode` type, add to `Config` + `getConfig` + setter)
- Modify: `package.json` (declare `sidebarFilterMode` config property)
- Modify: `src/sidebar/tree-provider.ts` (apply filter, set `treeView.description`, empty-state under filter)
- Modify: `src/sidebar/items.ts` (update `WorkspaceTreeItem` description to include stopped count)

- [ ] **Step 1: Add the filter mode type + config getter/setter**

In `src/config.ts`, add the type near the existing `SidebarSortMode`:

```typescript
export type SidebarFilterMode = 'all' | 'running' | 'stopped';
export const FILTER_MODES: SidebarFilterMode[] = ['all', 'running', 'stopped'];
```

Add the field to the `Config` interface:

```typescript
  sidebarFilterMode: SidebarFilterMode;
```

In `getConfig()`, add the parsing block (sibling to `sortMode`):

```typescript
  const rawFilter = c.get<string>('sidebarFilterMode', 'all');
  const filterMode = (FILTER_MODES as string[]).includes(rawFilter)
    ? (rawFilter as SidebarFilterMode) : 'all';
```

And include `sidebarFilterMode: filterMode,` in the returned object.

Add a setter at the bottom of `config.ts` (mirror of `setSortMode`):

```typescript
export async function setFilterMode(mode: SidebarFilterMode): Promise<void> {
  const c = vscode.workspace.getConfiguration('terminalSessions');
  await c.update('sidebarFilterMode', mode, vscode.ConfigurationTarget.Global);
}
```

- [ ] **Step 2: Declare the config schema in `package.json`**

Add to `contributes.configuration.properties` (next to `sidebarSortMode`):

```json
        "terminalSessions.sidebarFilterMode": {
          "type": "string",
          "enum": ["all", "running", "stopped"],
          "enumDescriptions": [
            "Show every session (running + stopped).",
            "Hide stopped sessions.",
            "Show only stopped sessions."
          ],
          "default": "all",
          "description": "Filter the sidebar by session state. Click the filter icon in the sidebar title bar to switch interactively."
        },
```

- [ ] **Step 3: Apply the filter in `tree-provider.ts → getChildren`**

In `src/sidebar/tree-provider.ts`, modify `getChildren()` around lines 87-117. Right after `const sessions = await enrichSessions(...)` and before `if (!el)`, insert the filter:

```typescript
    let filtered = sessions;
    if (cfg.sidebarFilterMode === 'running') filtered = sessions.filter(s => !s.stopped);
    else if (cfg.sidebarFilterMode === 'stopped') filtered = sessions.filter(s => s.stopped);
```

Replace the entire `if (!el)` block in `getChildren()` (current lines ~97-117) with this version. It uses `filtered` for both the empty-state check and the grouping, distinguishes the filter-induced empty state from the truly-empty state, and preserves the existing workspace-item construction loop:

```typescript
    if (!el) {
      if (filtered.length === 0) {
        this.lastWorkspaceItems.clear();
        this.lastSessionItems.clear();
        if (sessions.length > 0) {
          // Filter-induced empty state — distinguish from truly-empty
          const label = cfg.sidebarFilterMode === 'stopped'
            ? 'No stopped sessions.'
            : 'No running sessions.';
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.description = `${sessions.length} hidden by filter`;
          item.iconPath = new vscode.ThemeIcon('filter');
          return [item];
        }
        const item = new vscode.TreeItem('No persistent sessions yet.',
          vscode.TreeItemCollapsibleState.None);
        item.description = 'Click + to create one';
        return [item];
      }
      const grouped = groupByWorkspace(filtered);
      const out: vscode.TreeItem[] = [];
      this.lastWorkspaceItems.clear();
      for (const [hash, group] of grouped) {
        const ordered = sortSessions(group, cfg.sidebarSortMode);
        const wsPath = ordered[0].workspacePath;
        const wsItem = new WorkspaceTreeItem(ordered[0].workspaceLabel, hash, ordered, wsPath);
        this.lastWorkspaceItems.set(hash, wsItem);
        out.push(wsItem);
      }
      return out;
    }
```

Leave the rest of `getChildren()` (the `if (el instanceof WorkspaceTreeItem)`, `if (el instanceof SessionTreeItem)`, etc.) unchanged — those branches don't need filter awareness because the filter only affects which sessions reach the root.

- [ ] **Step 4: Set `treeView.description` to indicate the active filter**

Make `treeViewRef` accessible to a small helper (it's already module-scoped at line ~335). Add a helper at the bottom of `tree-provider.ts`:

```typescript
function updateTreeViewDescription(): void {
  if (!treeViewRef) return;
  const cfg = getConfig();
  if (cfg.sidebarFilterMode === 'running') treeViewRef.description = 'Running only';
  else if (cfg.sidebarFilterMode === 'stopped') treeViewRef.description = 'Stopped only';
  else treeViewRef.description = undefined;
}
```

Call it inside `registerSidebar`, after `treeViewRef = treeView`:

```typescript
  updateTreeViewDescription();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('terminalSessions.sidebarFilterMode')) {
        updateTreeViewDescription();
        provider?.refresh();
      }
    }),
  );
```

- [ ] **Step 5: Update `WorkspaceTreeItem.description` to include stopped count**

In `src/sidebar/items.ts`, modify the `WorkspaceTreeItem` constructor (lines ~7-29). Replace the description-building block:

```typescript
    const stopped = sessions.filter(s => s.stopped).length;
    const active = sessions.filter(s => !s.stopped && s.attached).length;
    const detached = sessions.filter(s => !s.stopped && !s.attached).length;
    const stoppedSuffix = stopped > 0 ? ` · ${stopped}⏸` : '';
    this.description = `${active}▶ ${detached}⇄${stoppedSuffix}`;
```

Update the tooltip the same way:

```typescript
    this.tooltip = new vscode.MarkdownString(
      [
        `**${label}**`,
        `\`${workspacePath || label}\``,
        '',
        `Active: ${active}  ·  Detached: ${detached}${stopped > 0 ? `  ·  Stopped: ${stopped}` : ''}`,
      ].join('\n\n'),
    );
```

These counts always reflect ALL sessions (pre-filter) so the user sees stopped totals even when the filter hides them.

- [ ] **Step 6: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 7: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/config.ts src/sidebar/tree-provider.ts src/sidebar/items.ts package.json
git commit -m "feat(sidebar): add sidebarFilterMode + workspace stopped count + filter empty state"
```

---

## Task 6: Filter picker command + title-bar button

**Files:**
- Modify: `src/commands.ts` (new `cmdPickFilterMode`, register it)
- Modify: `src/config.ts` (add `pickFilterMode` to `COMMAND`)
- Modify: `package.json` (declare command, add to `view/title`)

- [ ] **Step 1: Add `COMMAND.pickFilterMode`**

In `src/config.ts`, add to `COMMAND`:

```typescript
  pickFilterMode: 'terminalSessions.pickFilterMode',
```

- [ ] **Step 2: Implement `cmdPickFilterMode`**

Add to `src/commands.ts`. Import `setFilterMode` and `SidebarFilterMode` from `./config`:

```typescript
async function cmdPickFilterMode(): Promise<void> {
  interface Pick extends vscode.QuickPickItem { mode: SidebarFilterMode }
  const current = getConfig().sidebarFilterMode;
  const items: Pick[] = [
    { mode: 'all',      label: '$(list-flat) Show All Sessions',     description: current === 'all'      ? '(current)' : '' },
    { mode: 'running',  label: '$(pass-filled) Show Running Only',   description: current === 'running'  ? '(current)' : '' },
    { mode: 'stopped',  label: '$(debug-stop) Show Stopped Only',    description: current === 'stopped'  ? '(current)' : '' },
  ];
  const pick = await vscode.window.showQuickPick<Pick>(items, {
    placeHolder: 'Filter sidebar by session state',
  });
  if (!pick) return;
  await setFilterMode(pick.mode);
  refreshSidebar();
}
```

Make sure `setFilterMode` and `SidebarFilterMode` are added to the existing import line at the top:

```typescript
import { COMMAND, getConfig, setSortMode, setFilterMode, SidebarSortMode, SidebarFilterMode, SORT_MODES } from './config';
```

- [ ] **Step 3: Register the command**

In `registerCommands`, after `pickSortMode`:

```typescript
    vscode.commands.registerCommand(COMMAND.pickFilterMode, () => cmdPickFilterMode()),
```

- [ ] **Step 4: Declare the command + view/title placement**

Add to `contributes.commands` in `package.json`:

```json
      {
        "command": "terminalSessions.pickFilterMode",
        "title": "Terminal Sessions: Change Sidebar Filter",
        "icon": "$(filter)"
      },
```

Add to `contributes.menus.view/title`:

```json
        {
          "command": "terminalSessions.pickFilterMode",
          "when": "view == terminalSessions.sessions",
          "group": "navigation@1.5"
        },
```

Position `navigation@1.5` places the icon between `pickSortMode` (1) and `newPersistent` (2).

- [ ] **Step 5: Compile**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/commands.ts src/config.ts package.json
git commit -m "feat(sidebar): add filter picker command + title-bar button"
```

---

## Task 7: Restore-skip + version bump + CHANGELOG

**Files:**
- Modify: `src/restore.ts` (skip stopped entries in `maybeOfferRestore`)
- Modify: `package.json` (version: `0.12.5` → `0.13.0`)
- Modify: `CHANGELOG.md` (new entry)

- [ ] **Step 1: Skip stopped entries in `maybeOfferRestore`**

In `src/restore.ts`, modify the `candidates` builder around lines 57-62:

```typescript
  const candidates: Candidate[] = Object.entries(wsEntry.sessions)
    .filter(([, meta]) => !meta.stopped)
    .map(([sessionName, meta]) => ({
      sessionName,
      label: meta.label || sessionName,
      meta,
    }));
```

This single `.filter` step keeps Stopped sessions from being auto-recreated when the workspace opens.

- [ ] **Step 2: Bump version in `package.json`**

Change `"version": "0.12.5"` to `"version": "0.13.0"`.

- [ ] **Step 3: Add CHANGELOG entry**

Open `CHANGELOG.md` and prepend (under the existing format, above the `0.12.5` entry):

```markdown
## 0.13.0 — 2026-05-24

### Added
- **Stop / Start sessions.** New "Stop" command kills the tmux session but keeps the entry in the sidebar (marked with a muted ■ icon and greyed label). New "Start" command recreates the tmux session and — if a Claude conversation was tracked — auto-runs `claude --resume <id>` to restore the exact conversation. Reachable via the inline action row, right-click menu, or clicking a stopped row directly.
- **Filter dropdown in the title bar.** A new $(filter) icon lets you switch the sidebar between **All / Running only / Stopped only**. Active filter shown next to the "SESSIONS" header. Workspace counts always show running ▶ / detached ⇄ / stopped ⏸ totals regardless of the active filter.
- Confirmation modal when stopping a session whose Claude is actively `working` or `tool` (silent otherwise).

### Changed
- `WorkspaceTreeItem` description now includes a `· N⏸` suffix when any session in that workspace is stopped.
- `maybeOfferRestore` (workspace-open recovery) now skips sessions explicitly marked `stopped: true` — they stay stopped across VS Code restarts and surface in the sidebar via the merged tree.
- Tightened existing `viewItem =~ /^session/` `when` clauses to `=~ /^session($|\.muted$)/` so live-only actions (preview, mirror, restart, stop) don't appear on stopped rows.
```

- [ ] **Step 4: Compile + final sanity check**

Run: `cd "Terminal Sessions - Source" && npm run compile`
Expected: zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd "Terminal Sessions - Source"
git add src/restore.ts package.json CHANGELOG.md
git commit -m "chore(release): v0.13.0 — Stop/Start sessions + filter views"
```

---

## Manual verification checklist (after Task 7)

Run this AFTER all tasks compile. Reload VS Code Extension Development Host (F5 or `Cmd+R` in the dev host window) and:

- [ ] Right-click a live session → see "Stop Session" in the menu, click → session disappears from VS Code editor tab, sidebar entry stays with muted ■ icon
- [ ] Click the stopped row → terminal opens, tmux session restored
- [ ] Stop a session with Claude `working` → modal asks for confirmation; click Cancel, session stays alive
- [ ] Stop session that had Claude conversation, then Start it → terminal opens AND `claude --resume <id>` is typed/run automatically
- [ ] Click the $(filter) icon in title bar → quick-pick shows All/Running/Stopped → pick "Stopped only" → only stopped rows shown, "Stopped only" shown next to SESSIONS title
- [ ] With filter="Stopped only" and no stopped sessions: tree shows "No stopped sessions · N hidden by filter"
- [ ] Workspace row description shows e.g. `14▶ 0⇄ · 2⏸` when 2 sessions are stopped
- [ ] Kill a stopped session → entry disappears from index entirely (Kill = full removal regardless of state)
- [ ] Reload VS Code with stopped sessions in the index → `maybeOfferRestore` does NOT recreate them; they appear in the sidebar in stopped state

---

## File-touched summary

| File | Tasks |
|------|-------|
| `src/types.ts` | 1 |
| `src/session-manager.ts` | 1 |
| `src/sidebar/items.ts` | 2, 5 |
| `src/sidebar/tree-provider.ts` | 2, 5 |
| `src/commands.ts` | 3, 4, 6 |
| `src/config.ts` | 3, 4, 5, 6 |
| `src/restore.ts` | 7 |
| `package.json` | 3, 4, 5, 6, 7 |
| `CHANGELOG.md` | 7 |
