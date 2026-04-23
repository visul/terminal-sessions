# Terminal Sessions — Design Spec

Date: 2026-04-22
Status: MVP implemented (v0.1.0)

## Goal

A VS Code / Cursor extension that keeps terminal sessions alive across full editor quit/restart, scoped per workspace, with zero manual tmux knowledge required from the user.

## Problem

VS Code's built-in `terminal.integrated.persistentSessionReviveProcess` survives only window reload, not full app quit. When you `Cmd+Q` the editor, ptyHost dies and every child process (Claude Code CLI, `npm run dev`, any REPL) dies with it. This extension solves that by routing every terminal through tmux, whose server daemon lives outside the editor process tree.

## Architecture

```
Cursor (main proc)                 tmux server (daemon, launchd child)
    │                                     │
    └── ptyHost                            ├── session ts-a3f2c71d-1 (Claude Code)
         └── tmux CLIENT ─── socket ─────►│
              (dies on editor restart)    ├── session ts-a3f2c71d-2 (npm run dev)
                                          └── session ts-b1e4f8a9-1 (shopilo project)
```

When Cursor quits, only the client dies. Server and sessions survive. When Cursor reopens, the extension offers to re-attach clients to existing sessions for the current workspace.

## Session naming

```
{prefix}-{hash8}-{tabId}
```

- `prefix` — `ts` by default, configurable
- `hash8` — first 8 hex chars of SHA-256(absolute workspace path)
- `tabId` — monotonic counter per workspace, tracked in `~/.terminal-sessions/index.json`

Properties:
- Deterministic per workspace path — same project always maps to same namespace
- Git worktrees automatically separated (different paths → different hashes)
- Collision-free enough for personal use (2^32 combinations)
- Prefix + hash namespace keeps our sessions distinguishable from other tmux sessions the user might have

## Index file

`~/.terminal-sessions/index.json`:
```json
{
  "version": 1,
  "workspaces": {
    "a3f2c71d": {
      "path": "/Users/you/work/my-project",
      "label": "my-project",
      "lastSeen": "2026-04-22T14:30:00Z",
      "sessions": {
        "ts-a3f2c71d-1": { "label": "claude-main", "createdAt": "..." },
        "ts-a3f2c71d-2": { "createdAt": "..." }
      }
    }
  }
}
```

This file is advisory. tmux is the source of truth; if the index disagrees it is reconciled on next scan.

## Components

- `extension.ts` — activate/deactivate entry point
- `config.ts` — settings + command/view IDs
- `types.ts` — shared interfaces
- `workspace-id.ts` — hash workspace path, derive session names
- `tmux.ts` — thin wrapper over `tmux` CLI via `execFile`: detect, list, kill, has-session, capture-pane
- `session-manager.ts` — index persistence + session enrichment (tmux rows × index metadata)
- `profile-provider.ts` — registers the `terminalSessions.persistent` TerminalProfileProvider so the `+` button can create wrapped terminals
- `commands.ts` — all command palette handlers
- `sidebar/tree-provider.ts` + `sidebar/items.ts` — activity bar view
- `status-bar.ts` — right-side badge with live counts
- `toast.ts` — workspace-open resume prompt
- `util.ts` — small shared helpers

## Key behaviors

### New terminal
User clicks `+` (with Persistent Session as default profile) or runs the command:
1. Detect tmux; if missing, show install toast
2. Derive current workspace hash
3. Allocate next `tabId`
4. Spawn `tmux new-session -A -s {name} -c {cwd}` — `-A` attaches if exists, else creates
5. Record in index

### Tab close
Default: do nothing. The tmux client dies; server and session survive. User sees no change.

Configurable to `kill` (invokes `tmux kill-session`) or `ask` per close.

### Workspace open
`maybePromptResume` (1.5s after activate):
1. List tmux sessions matching current workspace hash
2. Filter to detached + within `autoRestoreMaxAgeHours`
3. If `autoRestore = auto` → open one terminal per session
4. If `autoRestore = ask` → toast "Resume N?" with [Resume All / Pick / Ignore]
5. If `autoRestore = off` → do nothing

### Kill
Explicit via:
- Command palette → `Kill Session` → picker
- Right-click sidebar item → `Kill`
- Inline trash icon on sidebar row
- `exit` or Ctrl+D inside terminal → tmux natural exit

All call `tmux kill-session -t {name}` + remove from index.

## Scope cuts (MVP)

Not yet implemented but scaffolded via config:
- Claude Code cost tracker — requires parsing `~/.claude/projects/*/*.jsonl` and mapping token counts × rate cards
- Long-running command notifications — needs `Terminal.shellIntegration` event wiring
- Mirror split — requires a second TerminalProfile that accepts a session name arg
- Zellij backend — would add `backend.ts` abstraction layer; swap `tmux.ts` impl

## Platforms

- **macOS**: primary target
- **Linux**: should work (tmux paths covered)
- **Windows**: untested, requires WSL tmux

## Tests

Not yet written. VS Code extension tests require `@vscode/test-electron` and mocking `vscode` module. Priority after first real-use validation.

## Reference extensions studied

Located in `_other_extensions/`:
- `terminal-workspaces/` — cybersader — tmux/Zellij sidebar GUI, attach-or-create, good patterns for multi-profile support
- `terminal-session-recall/` — orange-creatives — Claude-specific, uses `claude --resume` instead of tmux (different architecture)
- `claude-terminal-manager/` — jakub-musik — hook-based session tracking, IPC multi-window sidebar, useful for future cost/monitoring layer
