# Stop / Start sessions + filter views

**Date:** 2026-05-24
**Target version:** 0.13.0
**Status:** Design approved, implementation pending

## Goal

Today a tmux session is either **alive** (visible in the sidebar) or **killed** (removed from the index, disappears). There is no middle state. Users who want to free resources but keep a session as an entry to return to later have no option except Kill + manually recreate.

Add an explicit **Stopped** state:

- **Stop** kills the tmux session but keeps the index entry, marked with `stopped: true`. The session stays visible in the sidebar with a distinct visual treatment.
- **Start** recreates the tmux session, attaches a terminal, and — for sessions that had a Claude conversation — auto-runs `claude --resume <id>` to restore the exact conversation.
- A filter dropdown in the title bar lets the user switch between **All / Running only / Stopped only**.

## Non-goals

- Bulk start/stop (single session at a time).
- Preserving the running process state across stop (impossible — tmux server kills the process; only the metadata survives).
- New views in separate sidebar sections. One tree, one filter dropdown.

## Data model

### `SessionLabel` (in `~/.terminal-sessions/index.json`)

Add one optional field:

```ts
interface SessionLabel {
  // ... existing fields
  stopped?: boolean;  // set when user clicks Stop; cleared on Start or Kill
}
```

Entries lacking the field are treated as `stopped === false`. No migration step required.

### `SessionInfo` (runtime type emitted by `enrichSessions`)

Mirror the flag:

```ts
interface SessionInfo {
  // ... existing fields
  stopped?: boolean;
}
```

### `SessionIndex` helper

```ts
setSessionStopped(hash: string, sessionName: string, stopped: boolean): void
```

Sets/clears the flag and persists. Matches the shape of `setSessionMuted`.

## Sidebar enumeration: merging live + stopped

`enrichSessions(tmuxPath, prefix, index)` today only walks live `tmux list-sessions` output. New behavior:

1. Walk live tmux rows → `SessionInfo[]` (existing logic, plus `stopped: false`).
2. Collect the set of live names.
3. For each workspace entry in the index, iterate its sessions:
   - If `meta.stopped === true` AND the session name is not in the live set → emit a "virtual" `SessionInfo`:
     - `attached: false`, `stopped: true`
     - `createdAt = new Date(meta.createdAt)`
     - `lastAttached = new Date(meta.lastActiveAt || meta.createdAt)`
     - `tabId` parsed from the session name
     - Workspace fields from the index entry
     - No live tmux data → `lastActiveAt` from the index if present
4. Sort the merged list with the same sort that already runs.

Index entries without `stopped: true` and without a live row are NOT surfaced — those are dangling ghosts (e.g. tmux server died externally) and remain the responsibility of `maybeOfferRestore`.

## Render: how a stopped session looks

In `SessionTreeItem` constructor, branch when `session.stopped`:

- `contextValue = 'session.stopped'`
- `iconPath = new ThemeIcon('debug-stop', new ThemeColor('disabledForeground'))`
- `description = 'stopped · idle ' + humanAge(session.lastAttached)` (no `attached`, no Claude state — the process is dead)
- `collapsibleState = None` (no Claude details to expand)
- `command = { command: 'terminalSessions.start', title: 'Start', arguments: [this] }`
- `tooltip`: re-uses existing builder but adds a "Click to start. Last Claude session: `<id>`" line when `claudeTracker.getSessionId(name)` exists.

### Greying the whole row (label + description)

VS Code's `TreeItem.label` cannot be colored directly via the API. To grey the label, use the `FileDecorationProvider` trick:

- Register a `FileDecorationProvider` keyed on a custom URI scheme: `terminal-sessions-stopped:`.
- On stopped items, set `resourceUri = vscode.Uri.parse('terminal-sessions-stopped:' + encodeURIComponent(session.name))`.
- The provider returns:
  ```ts
  { color: new ThemeColor('disabledForeground'), tooltip: 'Stopped' }
  ```
- VS Code applies the decoration to both the label and the description.

The icon already carries its own `ThemeColor('disabledForeground')` from `iconPath` so the whole row reads as muted.

## Commands

### `terminalSessions.stop`

**Icon:** `debug-pause`
**Title:** "Stop Session"

**Behavior:**

1. Resolve `name` from the `SessionTreeItem` argument (or QuickPick if invoked from command palette).
2. Read the current Claude snapshot via `claudeTracker.getSnapshot(name)`.
3. If `snap?.state === 'working' || snap?.state === 'tool'`:
   - Show modal `showWarningMessage("Stop session <label>? Claude is currently working — its turn will be interrupted.", { modal: true }, 'Stop')`.
   - Abort if user dismisses.
4. `await tmux.killSession(tmuxPath, name)` (try/catch already inside).
5. Close the VS Code terminal hosting that session: `findTerminalForSession(name)` + `disposeAndWait(term, 500)`.
6. `index.setSessionStopped(parsed.hash, name, true)`.
7. `refreshSidebar()`.

No notification on success — silent and reversible.

### `terminalSessions.start`

**Icon:** `play`
**Title:** "Start Session"

**Behavior:**

1. Resolve `name` and parsed hash. Read `meta = index.getSessionMeta(hash, name)`.
2. `cwd = meta?.folderPath || ws.path` (workspace root fallback).
3. If `await tmux.hasSession(tmuxPath, name)` → skip step 4 (attach to the existing one — handles the rare case where tmux name still exists).
4. Else → `await tmux.createDetachedSession(tmuxPath, name, cwd)`.
5. `index.setSessionStopped(hash, name, false)`.
6. `const term = await openTerminalForSession(name, cwd, index, true)`.
7. Claude auto-resume:
   - `let claudeSessionId = claudeTracker.getSessionId(name)`
   - If it exists AND `fs.existsSync(transcriptPathFor(ws.path, claudeSessionId))`:
     - `await sleep(1500)` (let shell rc finish)
     - If `vscode.window.terminals.includes(term)`:
       - `term.sendText('claude --resume ' + claudeSessionId)`
8. `refreshSidebar()`.

This is the same auto-resume flow used by `cmdRestart` today — extract into a shared helper if duplication grows. For v0.13.0 keep it inline.

### `terminalSessions.pickFilterMode`

**Icon:** `filter`
**Title:** "Terminal Sessions: Change Sidebar Filter"

**Behavior:**

QuickPick with three items (label + codicon prefix):

- `$(list-flat) Show All Sessions` → `'all'`
- `$(pass-filled) Show Running Only` → `'running'`
- `$(debug-stop) Show Stopped Only` → `'stopped'`

Persist via `vscode.workspace.getConfiguration('terminalSessions').update('sidebarFilterMode', value, ConfigurationTarget.Global)` and `refreshSidebar()`.

## Filter dropdown in the title bar

### New config

`package.json` contribution:

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
}
```

Add to `config.ts` getter (`getConfig()`).

### Apply the filter

In `tree-provider.ts → getChildren()`, after `await enrichSessions(...)`:

```ts
let filtered = sessions;
if (cfg.sidebarFilterMode === 'running') filtered = sessions.filter(s => !s.stopped);
else if (cfg.sidebarFilterMode === 'stopped') filtered = sessions.filter(s => s.stopped);
```

Pass `filtered` instead of `sessions` to the grouping/rendering logic.

### Indicator: active filter

After the tree refreshes, set `treeViewRef.description`:

- `'all'` → `undefined`
- `'running'` → `'Running only'`
- `'stopped'` → `'Stopped only'`

This appears as muted text in the view's title bar next to "SESSIONS".

### Workspace count

`WorkspaceTreeItem.description` today: `${active}▶ ${detached}⇄`.

Extend (independent of filter — counts always reflect ALL sessions in the workspace, so the user can see at a glance how many are stopped even with the running-only filter on):

```ts
const stopped = sessions.filter(s => s.stopped).length;
const active = sessions.filter(s => !s.stopped && s.attached).length;
const detached = sessions.filter(s => !s.stopped && !s.attached).length;
const stoppedSuffix = stopped > 0 ? ` · ${stopped}⏸` : '';
this.description = `${active}▶ ${detached}⇄${stoppedSuffix}`;
```

### Empty state under active filter

When `sidebarFilterMode === 'stopped'` and no session has `stopped: true`, the tree should render a helpful placeholder instead of the existing "No persistent sessions yet" copy (which would mislead — there may be plenty of running sessions hidden by the filter).

In `getChildren()` for root, after applying the filter:

```ts
if (filtered.length === 0 && sessions.length > 0) {
  const item = new vscode.TreeItem(
    cfg.sidebarFilterMode === 'stopped'
      ? 'No stopped sessions.'
      : 'No running sessions.',
    vscode.TreeItemCollapsibleState.None,
  );
  item.description = `${sessions.length} hidden by filter`;
  item.iconPath = new vscode.ThemeIcon('filter');
  return [item];
}
```

The existing "No persistent sessions yet" path stays for the truly-empty case (`sessions.length === 0`).

### Title bar placement

In `package.json → contributes.menus.view/title`:

```json
{
  "command": "terminalSessions.pickFilterMode",
  "when": "view == terminalSessions.sessions",
  "group": "navigation@1.5"
}
```

Order in the title bar: find · sort · **filter** · new · refresh · alerts.

## Menu placements (per session contextValue)

### Inline (`view/item/context`, `group: "inline@N"`)

For LIVE sessions (`session` or `session.muted`), inline order (re-numbered to slot Stop in):

| order | command                       |
|-------|-------------------------------|
| `inline@1` | `terminalSessions.preview`  |
| `inline@2` | `terminalSessions.mirror`   |
| `inline@3` | `terminalSessions.restart`  |
| `inline@4` | `terminalSessions.stop`     |
| `inline@5` | `terminalSessions.kill`     |

For STOPPED sessions (`session.stopped`):

| order | command                       |
|-------|-------------------------------|
| `inline@1` | `terminalSessions.start`    |
| `inline@2` | `terminalSessions.kill`     |

The existing `when` clauses use `viewItem =~ /^session/` which matches both `session.stopped` and `session.muted`. Tighten them so live-only actions don't appear on stopped rows:

- preview / mirror / restart / stop: `viewItem =~ /^session($|\.muted$)/` (live only)
- start: `viewItem == session.stopped`
- kill: `viewItem =~ /^session/` (unchanged — Kill works in any state)

### Right-click (`view/item/context`, named groups)

For `session.stopped`: Start, Rename, Set Icon, Set Color, Kill. Skip Restart/Stop/Preview/Mirror — none apply to a dead session.

## Adjustments to existing flows

### `maybeOfferRestore` (restore.ts)

Filter out stopped candidates:

```ts
const candidates: Candidate[] = Object.entries(wsEntry.sessions)
  .filter(([, meta]) => !meta.stopped)
  .map(([sessionName, meta]) => ({ sessionName, label: meta.label || sessionName, meta }));
```

Stopped entries persist across VS Code restart but stay stopped — they appear in the sidebar via the merge in `enrichSessions`, and the user starts them manually.

### `cmdKill`

No change. Kill on a stopped session is a no-op on tmux (session already gone — `killSession` swallows the error) and `index.removeSession(hash, name)` clears everything including the `stopped` flag.

### Claude tracker map persistence

Already handled. `claude-tracker.ts` persists its `tmuxSession → claudeSessionId` map to disk on every update (`MAP_PATH`). The mapping survives across VS Code restart, so a stopped session can be started days later and still auto-resume the right Claude conversation.

## Files touched

| File | Change |
|------|--------|
| `src/types.ts` | Add `stopped?: boolean` to `SessionLabel` and `SessionInfo` |
| `src/session-manager.ts` | `setSessionStopped` helper; merge stopped index entries in `enrichSessions` |
| `src/sidebar/items.ts` | Render stopped branch (icon, description, resourceUri, command, contextValue) |
| `src/sidebar/tree-provider.ts` | Register `FileDecorationProvider`; apply filter; update workspace counts; set view description |
| `src/commands.ts` | `cmdStop`, `cmdStart`, `cmdPickFilterMode`; register in `activate` |
| `src/config.ts` | `sidebarFilterMode` getter; existing config object |
| `src/restore.ts` | Filter stopped candidates in `maybeOfferRestore` |
| `package.json` | 3 commands, 1 config property, menu updates, version bump |
| `CHANGELOG.md` | 0.13.0 entry |

## Version

`0.12.5 → 0.13.0` (minor feature bump).

## Open questions

None. All UX questions resolved during brainstorming:

- Click on stopped row → Start direct + attach.
- Stop on Claude `working`/`tool` → modal confirm; else silent.
- Visual: stop icon `■` + greyed entire row via `FileDecorationProvider`.
- Layout: single tree + title-bar filter dropdown (not separate views, not nested groups).
