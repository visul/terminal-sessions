# Terminal Sessions

Persistent terminal sessions for Cursor and VS Code. Sessions survive editor restarts, scoped per workspace. Works locally on macOS/Linux and over Remote-SSH.

Wraps every terminal in tmux automatically so the underlying shell and any running processes (Claude Code, dev servers, REPLs) keep running when you quit or restart the editor. Reopen the workspace and everything is right where you left it.

## Why

VS Code's built-in `terminal.integrated.persistentSessionReviveProcess` only survives window reloads, not full app quits. Child processes always die when the editor fully restarts. This extension solves it by wrapping each terminal in a tmux session whose server daemon is independent of the editor process.

## Features

### Session lifecycle
- **Persistent sessions** across full editor quit/restart via tmux
- **Workspace-scoped naming** — each project gets its own namespace (8-char path hash), no cross-project collisions
- **Git-worktree aware** — different paths = different hashes, so worktrees automatically get separate sessions
- **Auto-resume toast** on workspace open — "Found N sessions from last time — [Resume All / Pick... / Ignore]"
- **Configurable auto-restore** — `auto` resumes all, `ask` prompts, `off` disables
- **Max age filter** — skip auto-restore for sessions older than N hours (default 72h)
- **Safe tab close** — closing a terminal tab detaches; session keeps running in the background
- **Explicit kill** via command palette, right-click on sidebar item, or "Kill all for this workspace"
- **Auto-prune** stale sessions after configurable days (default 14)

### UI integration
- **Terminal Profile "Persistent Session"** — available in the `+ ∨` dropdown; can be set as default so every new terminal auto-wraps in tmux
- **Activity bar sidebar** — tree view grouped by workspace, with status indicators (attached vs detached) and relative timestamps
- **Status bar badge** — `⚡ ts: 2▶ 4⇄` (attached · detached), click to open the attach picker
- **Auto-refresh** every 5 seconds
- **Preview scrollback** — peek at a session's last 200 lines in an editor tab without attaching
- **Rename sessions** with custom labels (persisted in index)
- **Custom icon & color per session** — pick from codicons (robot, rocket, flame, database, server, bug, etc.) and ANSI colors; applied to the terminal tab icon and sidebar
- **Restart session** — kill the current tmux session (any program in it, incl. Claude Code) and respawn a fresh shell; keeps the label, icon, color, and workspace
- **Smart click behavior** — clicking a session that's already attached focuses its existing terminal tab instead of opening a duplicate
- **Terminal tab name tracking** — renaming a tab in Cursor saves the label so it survives restart
- **Right-click context menu** on sidebar items — Preview, Mirror, Restart, Rename, Icon, Color, Kill
- **Explorer right-click** — "Open in Integrated Terminal - Persistent" on any folder opens a persistent tmux session with that folder as CWD, auto-labeled with the folder name

### Notifications & Claude Code integration
- **Long-running command alerts** — notification when a command takes longer than a configurable threshold (default 30s); useful for builds, migrations, deploys
- **Claude Code Stop hook** — opt-in hook that installs into `~/.claude/settings.json` and fires a notification each time Claude finishes a response (with a min-duration filter to avoid notif-storms on short turns)
- **Native macOS Notification Center** — mode-switchable (`auto`: native when Cursor is unfocused / toast when focused; `always`; `never`)
- **Sound picker** — 14 macOS built-in sounds (Glass, Ping, Hero, Pop, …); errors override with Basso
- **Post-reboot recovery** — "Recreate Sessions from Index" rebuilds your sessions after a macOS reboot wiped the tmux server; optional `claude --resume <id>` hint toast so you can reattach Claude Code sessions by ID

### tmux integration (managed config)
The extension generates and manages `~/.terminal-sessions/tmux.conf` with sensible defaults tuned for Cursor. Your default `~/.tmux.conf` is **not** touched — this file only loads when the extension starts a session.

Defaults include:
- **Mouse on**, 50 000 line scrollback, 10ms escape time, focus events, `exit-empty off`
- **True color** support (`xterm-256color` + `Tc` override)
- **OSC 52 clipboard** (`set-clipboard on`) — selections copy to macOS clipboard through Cursor automatically
- **Drag-select stays in copy-mode** (tmux default exits copy-mode and jumps to prompt — override uses `copy-selection-no-clear`)
- **Trackpad-friendly scroll** — 1 line per tick (default 5 is too fast on macOS trackpad)
- **Right-click menu disabled** — Cursor shows its own context menu without overlap
- **Custom prefix `Ctrl+A`** (screen-style, easier than default Ctrl+B). `Ctrl+A Ctrl+A` sends a literal Ctrl+A.
- **Menu on `Ctrl+A q`** — copy mode, paste, splits, zoom, rename, kill, respawn, reload config
- **Status bar off** — Cursor has its own UI, saves a row
- **Inherit** `~/.tmux.conf` if present (append your theme/keybinds)

Two commands let you tweak it:
- `Terminal Sessions: Open tmux.conf` — opens the file in an editor
- `Terminal Sessions: Reload tmux Config` — applies changes to all running sessions

### Portability / recovery
- **Remote-SSH support** — runs on whichever side hosts the workspace (remote when connected over SSH, local otherwise). Install on both, the right copy activates per window. One VSIX works both local and remote.
- **No lock-in** — everything is plain tmux. If the extension breaks you can `tmux ls` and `tmux attach -t ts-xxx` from any system terminal.
- **Index file** at `~/.terminal-sessions/index.json` maps workspace hashes to readable paths and labels (for debugging or external tools).

## Requirements

- **tmux** on your `PATH`: `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu) or `sudo dnf install tmux` (RHEL/Fedora).
- **Node.js 20+** only if you're building from source.
- macOS or Linux. Windows support requires WSL (not yet tested).

## Install

### From VSIX (recommended for distribution)
```bash
cursor --install-extension terminal-sessions-0.1.6.vsix --force
```
Or in Cursor: Extensions panel → `⋯` → **Install from VSIX...**

### From source (development)
```bash
cd path/to/terminal-sessions
npm install
npm run compile
# Press F5 in Cursor to launch an Extension Development Host
```

### Build your own VSIX
```bash
cd path/to/terminal-sessions
npm install
npm run package   # produces terminal-sessions-<ver>.vsix
```

### On SSH Remote
The extension runs on the workspace side (remote when connected over SSH, local otherwise). Install it on both so the right copy picks up per window.

1. Install tmux on the remote server.
2. In a Remote-SSH window: Cmd+Shift+P → "Extensions: Install from VSIX..." → pick your local `.vsix`. Cursor uploads and installs on the remote automatically.
3. Reload the remote window. Sidebar and commands operate against the remote tmux.

## First-time setup

1. `brew install tmux`
2. Install the extension and reload Cursor (full quit + reopen if you see stale state).
3. Run `Terminal Sessions: Set as Default Terminal Profile` so every `+` button creates a tmux-wrapped terminal.
4. Open the **Terminal Sessions** activity bar icon to see the sidebar.

## Commands

| Command | What it does |
|---|---|
| `Terminal Sessions: New Persistent Terminal` | Creates a new tmux-wrapped terminal for the current workspace |
| `Terminal Sessions: Attach to Session...` | Quick-pick across all sessions (any workspace) |
| `Terminal Sessions: Resume All For Workspace` | Open terminals for every detached session of the current project |
| `Terminal Sessions: Reveal Sidebar` | Focus the sidebar tree view |
| `Terminal Sessions: Kill Session` | Pick a session to kill |
| `Terminal Sessions: Kill All Sessions for This Workspace` | Clean up this project |
| `Terminal Sessions: Kill All Stale Sessions` | Prune sessions older than `pruneAfterDays` |
| `Terminal Sessions: Set as Default Terminal Profile` | Write the VSCode setting so `+` auto-wraps |
| `Terminal Sessions: Open tmux.conf` | Edit `~/.terminal-sessions/tmux.conf` |
| `Terminal Sessions: Reload tmux Config` | Apply config changes to running sessions |
| Right-click on sidebar item → `Preview Scrollback` | Last 200 lines in an editor tab |
| Right-click on sidebar item → `Rename` | Set a friendly label |
| Right-click on sidebar item → `Kill` | Terminate that session |

## Keyboard (tmux prefix `Ctrl+A`)

| Key | Action |
|---|---|
| `Ctrl+A q` | Menu: copy mode, paste, splits, zoom, rename, kill, respawn, reload config |
| `Ctrl+A Ctrl+A` | Send a literal `Ctrl+A` (for shell "beginning of line") |
| Mouse drag-select | Copy to clipboard, stay in copy-mode |
| Mouse wheel in pane | Enter copy-mode, scroll 1 line/tick |
| `q` or `Esc` or `Enter` | Exit copy-mode |
| Right-click | Cursor context menu (Copy/Paste/Kill Terminal/etc.) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `terminalSessions.tmuxPath` | `""` | Absolute path to tmux binary. Empty = autodetect from PATH and common locations. |
| `terminalSessions.sessionPrefix` | `"ts"` | Prefix for session names, e.g. `ts-a3f2c71d-1`. |
| `terminalSessions.autoRestore` | `"ask"` | On workspace open: `auto`, `ask`, or `off`. |
| `terminalSessions.autoRestoreMaxAgeHours` | `72` | Skip auto-restore for sessions older than this. |
| `terminalSessions.pruneAfterDays` | `14` | Offer to prune sessions idle longer than this (`0` to disable). |
| `terminalSessions.enableCostTracker` | `true` | (Reserved) Claude Code cost estimates from `~/.claude/projects/`. |
| `terminalSessions.enableLongRunNotifications` | `true` | (Reserved) Notify when a command takes >N seconds. |
| `terminalSessions.longRunThresholdSeconds` | `30` | Threshold for long-run notifications. |

## Session naming scheme

```
{prefix}-{8-char SHA-256 hash of workspace path}-{tab number}
```

Example: `ts-a3f2c71d-1` is the first persistent terminal opened in whatever workspace hashes to `a3f2c71d`. The index at `~/.terminal-sessions/index.json` maps hashes to human-readable paths and labels.

Git worktrees automatically get separate namespaces (different absolute paths → different hashes).

## Recovering without the extension

Plain tmux under the hood:
```bash
tmux ls                         # list all sessions on the default socket
tmux attach -t ts-a3f2c71d-1    # attach from any system terminal
tmux kill-session -t ts-...     # kill from CLI if extension won't
```

## Roadmap

- Zellij backend as a tmux alternative
- Multi-window cross-session view (like `claude-terminal-manager`)
- Windows / WSL testing and support

## License

MIT
