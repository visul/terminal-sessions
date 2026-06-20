# Terminal Sessions

Persistent terminal sessions for Cursor and VS Code, with first-class awareness of your AI coding agents — **Claude Code, Codex, and Antigravity (`agy`)**. Terminals survive full editor restart, organized per workspace, and the sidebar shows live agent state: working/tool/waiting, context usage, cost, last user and assistant messages. Browse, read, name, resume, and clean up every past conversation on your machine, across all three agents.

Every terminal is wrapped in a tmux session whose server runs independent of the editor. Quit Cursor, reboot the window, crash the renderer: Claude Code, dev servers, REPLs, migrations, SSH sessions keep running. Reopen the workspace and everything is where you left it.

## Platform support

| Platform | tmux backend | Notifications | Click-to-focus on notif | Status |
|---|---|---|---|---|
| **macOS (local)** | Native | macOS Notification Center + modal alert | Yes (osascript / terminal-notifier) | Full support |
| **Linux (local)** | Native | `notify-send` (libnotify) + optional `zenity` modal | Yes (zenity) | Full support |
| **Remote-SSH / Remote-WSL** | Native (tmux on the remote) | IPC-forwarded VS Code toast or modal in the local Cursor window | Yes (via VS Code API) | Full support |
| **Windows (native)** | Not supported — needs WSL or Remote-SSH | Falls back to VS Code toast | No | Requires WSL or SSH |

> **Windows users:** tmux does not run natively on Windows. The extension works normally on:
> - **WSL** — install the extension in the WSL-Remote window, install tmux in WSL (`sudo apt install tmux`)
> - **Remote-SSH** — connect to a Linux/macOS host, install the extension on the remote side
>
> Native Windows (PowerShell, cmd, Git Bash) is not supported.

> **Remote-SSH / Remote-WSL users:** you do NOT need to install `terminal-notifier` or `libnotify` on the remote machine. The extension detects the remote extension host via `vscode.env.remoteName` and routes notifications through the VS Code API, which forwards them to your local Cursor UI automatically. The `Show terminal` button on waiting alerts still works across the IPC bridge.

## Why

VS Code's built-in `terminal.integrated.persistentSessionReviveProcess` only survives window reloads, not full app quits. Child processes always die when the editor fully restarts. This extension solves it by wrapping each terminal in a tmux session whose server daemon is independent of the editor process.

## How it works

Three moving pieces, each independent, composed to give you a persistent and observable terminal layer.

**1. tmux as the process keeper.** Every persistent terminal you open is actually `tmux attach-session` against a named session on a tmux server that runs outside of Cursor. Quit Cursor, reboot the window, crash the renderer: the shells and anything they spawned (Claude Code, `npm run dev`, a migration, a long SSH) keep running in the tmux server. When you reopen the workspace, the extension offers to re-attach. Sessions are named `ts-<workspace-hash>-<tabId>`, so two projects or two git worktrees of the same repo never collide.

**2. A managed `~/.terminal-sessions/tmux.conf`.** The extension writes its own tmux config with defaults tuned for Cursor: mouse on, large scrollback, OSC 52 clipboard, modern CSI-u keys, DECSET 2026 synchronized output, and since v0.11 the `CLAUDE_CODE_NO_FLICKER` and `CLAUDE_CODE_DISABLE_MOUSE_CLICKS` env vars baked in so Claude Code renders cleanly in alt-screen and trackpad scroll stays inside the conversation view. Your own `~/.tmux.conf` is never touched; the managed file loads it at the end if it exists, so your personal theme or keybindings still apply.

**3. AI-agent awareness via hooks + transcript tailing.** If you opt in, the extension installs lifecycle hooks for each agent you use — `SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Notification | Stop | SessionEnd` for Claude (`~/.claude/settings.json`), the equivalent events for Codex (`~/.codex/hooks.json`) and Antigravity (`~/.gemini/antigravity-cli/settings.json`, plus a `statusLine` for live context). A single shared forwarder normalizes each agent's differing event payload and writes a JSON line to `~/.terminal-sessions/agent-events.log`, tagged with the agent id and the tmux session the agent is running in. A file watcher feeds those events into an in-memory map and sets the per-session state (working, tool, waiting, idle). In parallel, a transcript tailer follows the agent's on-disk conversation file and, through that agent's provider, extracts model, token counts, context-window usage, and cost. The sidebar reads both streams and renders the merged snapshot. A conversation can only belong to one tmux session at a time; starting the same conversation in a different tab transfers ownership so the sidebar never shows duplicate live states. Everything below works the same way for Claude, Codex, and Antigravity — Claude is simply the most battle-tested provider.

**What persists across what**

| Event | tmux session | Shell process | Claude process | Conversation (`.jsonl`) |
| --- | --- | --- | --- | --- |
| Close a tab | kept | kept | kept | kept |
| Reload window (`Cmd+R`) | kept | kept | kept | kept |
| Quit Cursor (`Cmd+Q`) | kept | kept | kept | kept |
| Restart Session command | killed | killed | killed | kept (auto-resumed in v0.11+) |
| Mac reboot | killed | killed | killed | kept (recreate from index) |

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
- **Activity bar badge** (v0.11+) — a red numeric badge appears on the Terminal Sessions icon when Claude sessions need attention. `waiting` count takes priority (user permission pending), falls back to `working` count. Tooltip explains which is which
- **Click terminal tab → reveal sidebar session** (v0.11+) — clicking any `Terminal Sessions #N` tab in the VS Code terminal panel selects and highlights the matching row in the Terminal Sessions sidebar, auto-expanding its workspace group
- **Status bar badge** — `⚡ ts: 2▶ 4⇄` (attached · detached), click to open the attach picker
- **Preview scrollback** — peek at a session's last 200 lines in an editor tab without attaching
- **Rename sessions** with custom labels (persisted in index)
- **Custom icon & color per session** — pick from codicons (robot, rocket, flame, database, server, bug, etc.) and ANSI colors; applied to the terminal tab icon and sidebar
- **Restart session** (v0.11+: with Claude auto-resume) — kill the current tmux session (any program in it, incl. Claude Code) and respawn a fresh shell; keeps the label, icon, color, and workspace. If Claude was running, the extension auto-detects its session ID, verifies the transcript is still on disk, and runs `claude --resume <id>` in the new shell. Conversation context survives, Ink renderer state is clean
- **Smart click behavior** — clicking a session that's already attached focuses its existing terminal tab instead of opening a duplicate
- **Right-click context menu** on sidebar items — Preview, Mirror, Restart, Rename, Icon, Color, Mute notifications, Kill
- **Explorer right-click → "Open in Integrated Terminal - Persistent"** — on any folder, opens a persistent tmux session rooted at that folder. The VS Code tab description reflects the actual folder name (v0.11+; earlier versions always showed the workspace root)

### Sidebar sort modes
- **Custom** — drag sessions in the sidebar to rearrange; order persisted across restarts (stored per-session in `~/.terminal-sessions/index.json`)
- **Recently used** — most recently focused session floats to top
- **Creation order** — oldest first (default, backward-compatible)
- **Alphabetical** — by session label
- Toggle via the `$(list-ordered)` icon in the sidebar title bar; dragging automatically switches to Custom

### Filter, groups & navigation
- **Filter modes** — show `all`, only `running`, or only `stopped` sessions via the `$(filter)` icon in the title bar (`terminalSessions.sidebarFilterMode`)
- **Stop / Start a session** — pause a session (kills the tmux session but keeps the row, with its label, icon, color, and agent history) and start it again later, instead of killing it outright. Stopped rows get an inline `$(play)`
- **Groups & master groups** — organize sessions under named groups, and groups under master groups, via right-click `New Group…` / `New Master Group…` / `Move to Group…`, with drag-and-drop and per-group rename/delete. Purely organizational; the underlying tmux sessions are untouched
- **Re-attach All Ghost Terminals** — one click (`$(debug-restart)` in the title bar) revives the orange/disconnected tabs you get after a Cursor restart, in sidebar order
- **Reveal Session Folder** — right-click → open the session's working directory in the OS file manager (Finder/Explorer), or jump to its row from the terminal tab via `Reveal Session in Sidebar`
- **Copy Last Session ID / Path** — right-click → put the most recent agent conversation's UUID, or the full path to its transcript `.jsonl`, on the clipboard (works for Claude, Codex, and Antigravity)

### Subagents in the sidebar (v0.12+)
- **`🤖 Agents (N running · M done)` folder per session** — one collapsible row groups every subagent a Claude session spawned, so sessions with lots of agents stay tidy. Auto-expanded while anything is live; collapsed when everything finishes. Tooltip previews the first five agents with their state
- **Live per-subagent rows** — state icon (spinner / tools / check), elapsed time, current tool with input preview, last streamed message. Nests recursively for agents that spawn sub-subagents
- **Inline subagent counter in the session description** — `Terminal Sessions waiting input · 69% ctx · 🤖 2 running` (falls back to `🤖 N done` after completion). See live agent activity without expanding
- **Agent label** — `<subagent_type> — <description>` pulled from the `Agent` / `Task` tool input (e.g. `researcher — MCP servers for note apps`). Tooltip shows depth, parent agent id, and timestamps
- **Background-agent support** — Claude Code ≥ 2.1.119 spawns subagents via the `Agent` tool with `run_in_background: true`; their activity is written to per-agent transcripts in `<main-jsonl>/subagents/agent-<id>.jsonl` (not as sidechain messages). The tailer scans that sibling directory on a 3-second poll, so live state surfaces within ~3 s even without the main jsonl being written. The classic synchronous `Task` tool path keeps working too
- **`terminalSessions.showCompletedSubagents`** (default `true`) — keeps completed agents visible so short runs don't flicker in and out. Flip to `false` (or run `Terminal Sessions: Toggle Show Completed Subagents`) to focus only on live work
- **`Open Subagent Transcript` command** — right-click a subagent row → opens its transcript jsonl in an editor tab jumped to the first line where that agent was registered. For background agents this is the small per-agent file, much easier to read than the main conversation transcript
- **Auto-done on parent idle** — when the parent session has been idle for 2+ minutes, stragglers flagged `working` are marked done in the rendered snapshot so the sidebar doesn't spin forever on interrupted agents

### Multi-agent support (Claude · Codex · Antigravity)
- **One sidebar, three agents** — the same live status, context %, cost, history, and auto-resume work for **Claude Code**, **Codex**, and **Antigravity** (`agy`). Each tracked session shows which agent it's running, so a row reads `Codex working 12s` vs `Claude working 12s`
- **Auto-detection** — Claude is always on; Codex and Antigravity turn on automatically when their CLI (`codex` / `agy`) is found on your `PATH`. Override explicitly with `terminalSessions.enabledAgents` (e.g. `["claude", "codex"]`)
- **Per-agent hooks, one forwarder** — `Terminal Sessions: Install AI Agent Hooks` writes the right hook into each agent's own settings file (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/antigravity-cli/settings.json`); a single shared script normalizes their differing event payloads. Your model and MCP config are never disturbed
- **Agent-correct resume** — restart/resume runs the right command per agent: `claude --resume <id>` (cwd-sensitive), `codex resume <id>` (restores its own recorded cwd), or `agy --conversation <id>`. The extension picks it from the session's recorded agent automatically
- **Provider abstraction** — adding more agents later is a new provider file, no core changes; all three share one tracker, state machine, and notification path

### Live agent status in the sidebar
- **Per-session state indicator** — icon + description reflect whether the agent is `working`, running a `tool` (with tool name), `waiting` for user permission, or `idle` (with time-since). State is derived from the transcript directly so it stays correct even when hooks are out of date
- **API-equivalent cost in USD** — real cost per session computed from the transcript using the live Anthropic rate card, per-model (Opus 4.7 at $5/$25 in/out, Opus 4.1 at $15/$75, Sonnet at $3/$15, Haiku at $1/$5, plus separate cache-read and 5-min/1-hour cache-write tiers). Retried turns are de-duplicated by `message.id`; subagents on different models are counted automatically with their own rate. Sidebar shows `opus · $55.25 · 364 turns`; tooltip shows per-model breakdown and the raw token totals
- **Context-window gauge** (v0.11 fix) — the `31% ctx` suffix appears next to every Claude-active session. Crosses `terminalSessions.contextWarnPct` (default 0.8) → `⚠ 87% ctx`. Limit is auto-detected per session: Opus/Sonnet 4.5+ default to 1M-context, older models to 200k; if any single turn exceeds 200k we pin the limit to 1M. Subagent turns are excluded because they have their own context
- **Nested detail rows** — under each active session, rows show last user message, last Claude reply, model/cost/turns, current tool with its input (e.g. `Bash: "npm run build"`); configurable `auto | always | off`
- **Search past sessions** — `$(search)` button in the sidebar (or `Terminal Sessions: Find Session by Prompt…` command) opens a fuzzy picker over every transcript on your machine. Jump to transcript, copy session ID, or reveal the cwd
- **Deduplicated live state** (v0.11+) — if you ran `claude --resume <id>` in multiple tabs over time, the tracker now transfers ownership on each new hook event, so only the tab currently running that conversation shows live state. Others snap back to idle

### Archive, conversation viewer & cleanup (v0.15)
- **Resume Session from Archive** — the `$(history)` button on the sidebar toolbar (or `Terminal Sessions: Resume Session from Archive…`) opens a picker of **every** past conversation on disk, across all three agents, even when nothing is live in tmux for it. Defaults to the current workspace with a one-click toggle to show all projects. Accepting a row resumes it into your active session or a fresh persistent one
- **View Conversation** — right-click a session (or the eye button in the archive picker) to open a readable Markdown rendering of the conversation in VS Code's preview: user and assistant turns, with thinking blocks and tool calls in collapsible sections. No more squinting at raw `.jsonl`
- **Name Conversation** — give any session a friendly name; it shows in the archive picker and the viewer title. Names live in the extension's sidecar index, so the agent's transcript files are never modified
- **Clean Up Empty / Invalid Sessions** — a maintenance action (sidebar overflow `⋯` menu) that finds empty or "Invalid API key" conversations and soft-deletes them into `~/.claude/projects/.bak`, with a preview and confirmation. The agent's own database and session index are never touched; moved files can be restored manually

### Notifications
- **Claude Stop notification** — fires when Claude finishes a response. Distinct from the waiting variant so you can glance at the sound/icon and know whether you need to act. Min-duration filter prevents notif-storms on short turns
- **Claude Waiting notification** (v0.11+) — fires when Claude blocks for user permission (tool approval, risky command, URL access). Distinct sound (default `Sosumi` vs `Glass` for Stop), `⚠ Claude needs approval` title, subtitle is the session label. Two styles via `terminalSessions.waitingAlertStyle`:
  - `banner` — standard macOS/Linux notification, auto-dismisses
  - `alert` — **persistent modal dialog** with a `Show terminal` button that activates Cursor and focuses the matching tab. macOS uses `osascript display alert`; Linux uses `zenity --question` (if installed)
- **Click-to-focus** (v0.11+, macOS) — if `terminal-notifier` is installed (`brew install terminal-notifier`), clicking any notification banner or alert brings Cursor to the foreground instead of Script Editor. Without `terminal-notifier` notifications still work, but click lands in Script Editor — see the Requirements section for the exact trade-off
- **Works over Remote-SSH / Remote-WSL** (v0.11+) — when the extension host runs on a remote machine (the tmux session lives on the server, Cursor runs on your laptop), OS native notifications posted from the remote can't reach your desktop. The extension auto-detects this via `vscode.env.remoteName` and routes through the VS Code API instead: waiting events become an IPC-forwarded warning toast (banner style) or a blocking modal dialog (`alert` style) that pops up in your local Cursor window. The `Show terminal` button still works the same way — click it and the extension iterates `vscode.window.terminals` on the remote extension host and focuses the matching tab in your local UI. No extra setup on the remote; libnotify/terminal-notifier are not used in remote mode because they would be useless
- **Global on/off toggle** (v0.11+) — bell icon in the Terminal Sessions sidebar title bar toggles `notifyOnClaudeWaiting`. When off, the icon switches to `$(bell-slash)`. Command Palette also has `Terminal Sessions: Toggle Claude Waiting Alerts (Global)`
- **Per-session mute** (v0.11+) — right-click a session → `Mute Notifications`. Stop and Waiting notifications for that session are silenced until you unmute. Muted sessions display a `🔕` in the sidebar description. Useful for long-running experiments where you don't want beeps
- **Native macOS Notification Center** — mode-switchable (`auto`: native when Cursor is unfocused / toast when focused; `always`; `never`)
- **Native Linux** (v0.11+) — uses `notify-send` with urgency `critical` for warnings (sticky until dismissed on most desktop environments); falls back to VS Code toast if libnotify is missing
- **Sound picker** — 14 macOS built-in sounds (Glass, Ping, Hero, Pop, Sosumi, …). Separate settings for Stop (`notificationSound`) and Waiting (`notificationSoundWaiting`). Linux sound mapping is not implemented; sound is macOS-only
- **Long-running command alerts** — notification when a command takes longer than a configurable threshold (default 30s)
- **Post-reboot recovery** — "Recreate Sessions from Index" rebuilds your sessions after a reboot wiped the tmux server; optional `claude --resume <id>` hint toast so you can reattach Claude Code sessions by ID

### Making macOS notifications persistent

macOS decides whether notifications show as auto-dismissing **banners** or sticky **alerts** at the OS level, not from the app. To make every notification stay on screen until you dismiss it:

1. Open **System Settings → Notifications**
2. Find **Script Editor** (that is the app that posts our notifications via osascript)
3. Change **Notification style** from `Banners` to `Alerts`

Alerts get a `Show` button and stay in the top-right corner until you click it or Close. The `terminalSessions.waitingAlertStyle: "alert"` setting is an alternative that works without changing System Settings — it produces a modal dialog instead of a banner.

### tmux integration (managed config)
The extension generates and manages `~/.terminal-sessions/tmux.conf` with sensible defaults tuned for Cursor. Your default `~/.tmux.conf` is **not** touched — this file only loads when the extension starts a session.

Defaults include:
- **Mouse on**, 50 000 line scrollback, 10ms escape time, focus events, `exit-empty off`
- **True color** support (`tmux-256color` + `xterm-256color:RGB`)
- **OSC 52 clipboard** (`set-clipboard on`) — selections copy to the system clipboard through Cursor automatically
- **DECSET 2026 synchronized output** passthrough (`terminal-features xterm*:sync`) — apps like Claude Code that emit the sequence stop producing flicker through tmux
- **`allow-passthrough on`** — TUIs can send OSC/kitty-graphics/clipboard sequences through unfiltered
- **`extended-keys on`** — modern CSI-u encoding so Ctrl+Shift combos reach Claude Code correctly
- **`CLAUDE_CODE_NO_FLICKER=1`** and **`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`** baked in via `set-environment -g` (v0.11+) — every new tmux window inherits these, so Claude renders in alt-screen and trackpad scroll stays inside the conversation view. No shell rc edit required
- **Drag-select stays in copy-mode** (tmux default exits copy-mode and jumps to prompt — override uses `copy-selection-no-clear`)
- **Trackpad-friendly scroll** — 1 line per tick (default 5 is too fast on trackpads)
- **Custom prefix `Ctrl+A`** (screen-style). `Ctrl+A Ctrl+A` sends a literal Ctrl+A
- **Menu on `Ctrl+A q`** — copy mode, paste, splits, zoom, rename, kill, respawn, reload config
- **Status bar off** — Cursor has its own UI, saves a row
- **Inherit** `~/.tmux.conf` if present (append your theme/keybinds)

On updates, if the managed file is out of date you get a one-time toast offering to regenerate it. The old file is backed up next to it with a timestamp before any rewrite.

Two commands:
- `Terminal Sessions: Open tmux.conf` — opens the file in an editor
- `Terminal Sessions: Reload tmux Config` — applies changes to all running sessions

### Portability / recovery
- **Remote-SSH support** — runs on whichever side hosts the workspace (remote when connected over SSH, local otherwise). Install on both, the right copy activates per window. One VSIX works both local and remote
- **No lock-in** — everything is plain tmux. If the extension breaks you can `tmux ls` and `tmux attach -t ts-xxx` from any system terminal
- **Index file** at `~/.terminal-sessions/index.json` maps workspace hashes to readable paths and labels (for debugging or external tools)

## Requirements

### Required
- **tmux** on your `PATH`: `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu) or `sudo dnf install tmux` (RHEL/Fedora)
- **Claude Code ≥ 2.1.110** if you want the `CLAUDE_CODE_NO_FLICKER` rendering fix to take effect (earlier versions had a regression that wiped scrollback)

### Optional but recommended (for best notification UX)

The extension works out of the box, but the click-to-focus behavior on notifications depends on small platform helpers. Without them, you still get the notification — you just can't click it to jump straight to the right terminal tab.

**macOS**
- `brew install terminal-notifier` — makes **click on a `Claude done` / `Claude needs approval` banner focus Cursor** instead of bouncing you to Script Editor. Without it, notifications still show up, but they are posted via `osascript` which attributes them to Script Editor.app; clicking "Show" opens Script Editor, not the IDE. With it, the extension uses `terminal-notifier -activate <Cursor bundle id>` so clicks land in Cursor.
- For fully persistent banners that stay on screen until you dismiss them: System Settings → Notifications → Script Editor (or Terminal Notifier, if you installed it) → set Notification style to **Alerts** instead of Banners. Alternatively keep banners and flip `terminalSessions.waitingAlertStyle` to `"alert"` so waiting events come through as a modal dialog (persistent and click-to-focus, macOS-only).

**Linux**
- `libnotify` — required for any native notification at all:
  `sudo apt install libnotify-bin` (Debian/Ubuntu) or `sudo dnf install libnotify` (RHEL/Fedora). Without it, the extension falls back to VS Code toasts (in-editor popups, auto-dismissing).
- `zenity` (optional) — enables the persistent modal dialog for waiting alerts (`waitingAlertStyle: "alert"`). Without it, the `alert` style silently falls back to a sticky `notify-send -u critical` banner. Install with `sudo apt install zenity` or `sudo dnf install zenity`.

### Build from source (only if contributing)
- **Node.js 20+**

### Summary: what's installed vs what you get

| Platform | Package | Without it | With it |
|---|---|---|---|
| macOS | `terminal-notifier` | Notifications appear but clicking them opens Script Editor | Notifications appear and clicks focus Cursor |
| macOS | Notification style = Alerts (System Settings) | Banners auto-dismiss in 5s | Banners stay until dismissed, have `Show` button |
| Linux | `libnotify-bin` | Notifications fall back to VS Code toasts | Native desktop notifications via `notify-send` |
| Linux | `zenity` | `waitingAlertStyle: "alert"` falls back to sticky banner | Real modal dialog with `Show terminal` button |

## Install

### From VSIX
```bash
cursor --install-extension terminal-sessions-0.15.0.vsix --force
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
npm install
npm run package   # produces terminal-sessions-<ver>.vsix
```

### On SSH Remote
The extension runs on the workspace side (remote when connected over SSH, local otherwise). Install it on both so the right copy picks up per window.

1. Install tmux on the remote server
2. In a Remote-SSH window: Cmd+Shift+P → "Extensions: Install from VSIX..." → pick your local `.vsix`. Cursor uploads and installs on the remote automatically
3. Reload the remote window. Sidebar and commands operate against the remote tmux

### On WSL
1. In a WSL-Remote window, open a workspace under `\\wsl$\...`
2. Install tmux in WSL: `sudo apt install tmux`
3. Install the extension in the WSL-Remote extension host (same VSIX flow as above)
4. Reload

## First-time setup

1. Install tmux on the target machine
2. Install the extension and reload Cursor (full quit + reopen if you see stale state)
3. Run `Terminal Sessions: Set as Default Terminal Profile` so every `+` button creates a tmux-wrapped terminal
4. Open the **Terminal Sessions** activity bar icon to see the sidebar
5. Optional: run `Terminal Sessions: Install AI Agent Hooks` to enable live agent state + notifications for Claude, Codex, and Antigravity

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
| `Terminal Sessions: Find Session by Prompt...` | Fuzzy picker over every Claude transcript on your machine |
| `Terminal Sessions: Set as Default Terminal Profile` | Write the VS Code setting so `+` auto-wraps |
| `Terminal Sessions: Open tmux.conf` | Edit `~/.terminal-sessions/tmux.conf` |
| `Terminal Sessions: Reload tmux Config` | Apply config changes to running sessions |
| `Terminal Sessions: Install AI Agent Hooks` | Writes lifecycle hooks for each enabled agent into its own settings file (Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Antigravity `~/.gemini/antigravity-cli/settings.json`) |
| `Terminal Sessions: Uninstall AI Agent Hooks` | Removes the hooks for all agents |
| `Terminal Sessions: Resume Session from Archive...` | Picker over every past conversation on disk (Claude/Codex/Antigravity); resume, view, or name any of them |
| `Terminal Sessions: Resume Other Session...` | Resume a different past conversation into the current session (cross-agent) |
| `Terminal Sessions: Change Sidebar Filter` | Show all / running-only / stopped-only sessions |
| `Terminal Sessions: Fix Claude Code Rendering in Shell` | Appends `CLAUDE_CODE_NO_FLICKER=1` and `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` to your rc file (optional — v0.11 bakes these into tmux.conf so most users won't need this) |
| `Terminal Sessions: Toggle Claude Waiting Alerts (Global)` | Flip the `notifyOnClaudeWaiting` setting |
| `Terminal Sessions: Recreate Sessions from Index` | After a reboot, rebuild tmux sessions from the stored index |
| Right-click on sidebar session → `Preview Scrollback` | Last 200 lines in an editor tab |
| Right-click on sidebar session → `Restart` | Kill + fresh shell; auto-resume the agent if detected |
| Right-click on sidebar session → `View Conversation` | Open a readable Markdown rendering of the conversation |
| Right-click on sidebar session → `Name Conversation...` | Give the session a friendly name (shown in the archive picker) |
| Right-click on sidebar session → `Stop` / `Start` | Pause/respawn the tmux session while keeping the sidebar row |
| Right-click on sidebar session → `Copy Last Session ID` / `Copy Last Session Path` | Clipboard the conversation UUID or its transcript path |
| Right-click on sidebar session → `Reveal Session Folder` | Open the session's working directory in Finder/Explorer |
| Right-click on workspace/group → `New Group…` / `Move to Group…` | Organize sessions into (master) groups |
| Sidebar overflow `⋯` → `Clean Up Empty / Invalid Sessions...` | Soft-delete empty/invalid conversations to `~/.claude/projects/.bak` |
| Right-click on sidebar session → `Rename` | Set a friendly label |
| Right-click on sidebar session → `Change Icon` / `Change Color` | Pick custom icon or theme color |
| Right-click on sidebar session → `Mute Notifications` / `Unmute Notifications` | Per-session silencing |
| Right-click on sidebar session → `Kill` | Terminate that session |
| Right-click on folder in Explorer → `Open in Integrated Terminal - Persistent` | New tmux session rooted at that folder |

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
| `terminalSessions.tmuxPath` | `""` | Absolute path to tmux binary. Empty = autodetect from PATH and common locations |
| `terminalSessions.sessionPrefix` | `"ts"` | Prefix for session names, e.g. `ts-a3f2c71d-1` |
| `terminalSessions.enabledAgents` | `[]` (auto-detect) | Which AI CLIs to track. Empty = Claude always on, Codex/Antigravity on when found on PATH. Override e.g. `["claude","codex"]` |
| `terminalSessions.autoRestore` | `"ask"` | On workspace open: `auto`, `ask`, or `off` |
| `terminalSessions.autoRestoreMaxAgeHours` | `72` | Skip auto-restore for sessions older than this |
| `terminalSessions.pruneAfterDays` | `14` | Offer to prune sessions idle longer than this (`0` to disable) |
| `terminalSessions.sidebarSortMode` | `"created"` | `custom`, `mru`, `created`, or `alphabetical` |
| `terminalSessions.sidebarFilterMode` | `"all"` | Filter sidebar by state: `all`, `running`, or `stopped` |
| `terminalSessions.claudeSidebarDetails` | `"auto"` | Expand the nested rows under a Claude session: `auto`/`always`/`collapsed`/`off` |
| `terminalSessions.contextWarnPct` | `0.8` | Threshold (0-1) for the `⚠ 87% ctx` warning next to Claude state |
| `terminalSessions.nativeNotifications` | `"auto"` | `auto` (native when Cursor unfocused), `always`, `never` |
| `terminalSessions.notificationSound` | `"Glass"` | macOS sound for Claude Stop notifications |
| `terminalSessions.notificationSoundWaiting` | `"Sosumi"` | macOS sound for Claude Waiting notifications (distinct from Stop) |
| `terminalSessions.notifyOnClaudeStop` | `true` | Send a notification when Claude finishes a response |
| `terminalSessions.notifyOnClaudeWaiting` | `true` | Send a notification when Claude blocks for user permission |
| `terminalSessions.waitingAlertStyle` | `"banner"` | `banner` (auto-dismiss) or `alert` (persistent modal dialog with Show button) |
| `terminalSessions.claudeStopMinDurationSeconds` | `15` | Skip Stop notifications for turns shorter than this |
| `terminalSessions.autoResumeClaude` | `false` | After recreating sessions post-reboot, auto-run `claude --resume` |
| `terminalSessions.enableLongRunNotifications` | `true` | Notify when a command takes >N seconds |
| `terminalSessions.longRunThresholdSeconds` | `30` | Threshold for long-run notifications |

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

## Claude Code rendering in tmux

Claude Code's TUI writes full-frame redraws into the main terminal buffer on every state change, which tmux faithfully captures, producing scrambled scrollback, duplicate prompts, and corruption after detach/reattach or during heavy subagent use. This is a Claude-Code-side issue (Ink/React renderer), not tmux. See `anthropics/claude-code#29937`, `#41814`, `#46981`.

### Fix (automatic in v0.11+)

The managed `~/.terminal-sessions/tmux.conf` now emits
```tmux
set-environment -g CLAUDE_CODE_NO_FLICKER 1
set-environment -g CLAUDE_CODE_DISABLE_MOUSE_CLICKS 1
```
so every new tmux window inherits these at startup. No shell rc edit needed. The extension auto-prompts to regenerate older configs on upgrade.

- **`CLAUDE_CODE_NO_FLICKER=1`** — Claude Code renders into the alternate screen buffer (like `vim`, `less`, `htop`). tmux no longer captures each intermediate frame, so scrollback stays clean across detach/reattach and parallel subagents
- **`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`** — clicks are handed to tmux (so you can still click-select panes, tabs, the sidebar, etc.) but scroll events still reach Claude Code. Trackpad scrolls Claude's conversation view directly. `DISABLE_MOUSE=1` alone would block trackpad scroll

Requires Claude Code ≥ 2.1.110 (earlier versions had a regression that wiped scrollback).

If you started Claude in a session before the v3 config was applied, the env vars aren't in that shell yet. Either run `Restart Session` on the sidebar (auto-resumes the conversation) or `exec bash` / `exec zsh` inside the pane to pick them up.

### Copy / paste workflow

- **From plain shell output (git, build logs, bash):** drag-select with the trackpad as usual. Selection copies to the system clipboard via OSC 52
- **From the Claude conversation:** press `Ctrl+O` then `[` inside Claude. That dumps the current conversation view into the main tmux scrollback. From there, drag-select normally. Press `Ctrl+O` then `/` for Claude's own in-view search
- **Cmd+F / tmux copy-mode search** only sees content in the main buffer. The live Claude view lives in alt-screen, so it is not searchable that way — use `Ctrl+O` `/` inside Claude instead

## Roadmap

- Budget-alert thresholds (warn when a session's cost crosses $X)
- Daily / workspace-level cost rollup in the status bar
- Stuck / error detection from `tool_result` content
- Inline sidebar action buttons on agent-active sessions (Interrupt, `/compact`)
- More agents behind the provider abstraction (Gemini CLI, opencode, …)
- Windows native support (requires a tmux alternative — out of scope for now)

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
