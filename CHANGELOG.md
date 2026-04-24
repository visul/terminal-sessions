# Changelog

All notable changes to the Terminal Sessions extension.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semantic versioning once past 1.0.0.

## [0.11.0] — 2026-04-24

Major productivity release. Highlights: Claude rendering fix is now automatic
(no more manual shell setup), restart auto-resumes the Claude conversation,
waiting-for-permission notifications land with their own sound and can be
persistent, sidebar badge surfaces sessions that need attention, clicking a
terminal tab reveals its row in the sidebar. Linux notification support added.

### Added

**Claude session management**
- **Restart Session auto-resumes the Claude conversation.** When you restart a
  session that had Claude running, the extension detects the Claude session ID
  via the tracker and, after the fresh shell is ready, runs
  `claude --resume <id>` automatically. The confirmation dialog tells you up
  front: `Detected Claude session abc12345... will auto-run "claude --resume"
  after restart.` Context survives, the Ink renderer starts clean. If the
  transcript JSONL has been pruned from `~/.claude/projects/`, the extension
  silently falls back to a plain shell instead of triggering Claude's
  `No conversation found` error.
- **Click terminal tab → reveal session in sidebar.** When you click any
  `Terminal Sessions #N` tab in the VS Code terminal panel, the Terminal
  Sessions sidebar now selects and highlights the matching row, auto-expanding
  its workspace group. Bi-directional parity: click a row in the sidebar to
  focus the terminal, click the terminal to locate the row.

**Notifications**
- **Claude Waiting notification.** Fires when Claude blocks for user permission
  (tool approval, risky command, URL access). Separate sound from Stop (default
  `Sosumi` vs `Glass`), `⚠ Claude needs approval` title, subtitle is the
  session label. Configurable via `terminalSessions.notifyOnClaudeWaiting`,
  `terminalSessions.notificationSoundWaiting`.
- **Persistent waiting alerts** via `terminalSessions.waitingAlertStyle:
  "alert"`. Instead of a 5-second banner, waiting events surface as a modal
  dialog with a `Show terminal` button. Click → activates Cursor
  (`open -a <appName>`) → focuses the matching terminal tab. macOS uses
  `osascript display alert`; Linux uses `zenity --question` when installed,
  falls back to a sticky `notify-send -u critical` banner otherwise.
- **Global waiting-alerts on/off toggle.** Bell icon in the Terminal Sessions
  sidebar title bar flips `notifyOnClaudeWaiting`. Icon animates between
  `$(bell)` and `$(bell-slash)` based on state. Also available as
  `Terminal Sessions: Toggle Claude Waiting Alerts (Global)` in the Command
  Palette.
- **Per-session mute.** Right-click a session → `Mute Notifications`. Both
  Stop and Waiting events are silenced for that session until unmuted. Muted
  sessions get a `🔕` suffix in the sidebar description.
- **Activity bar badge.** Numeric badge on the Terminal Sessions activity
  bar icon when Claude sessions need attention. `waiting` count takes priority
  (user action pending) with tooltip
  `N Claude sessions waiting for you`. Falls back to `working` count when no
  waiting sessions; hidden when everything is idle.
- **Linux native notifications.** `notify-send` from libnotify, with urgency
  `critical` for warning-level events (sticky on most desktop environments).
  `zenity` is used for modal alerts when available.
- **Click-to-focus on macOS banners** via `terminal-notifier`. If
  `brew install terminal-notifier` is present, notifications are posted through
  it with `-activate <Cursor bundle id>`, so clicking a banner brings Cursor to
  the foreground instead of Script Editor (the implicit owner of osascript
  notifications). Without `terminal-notifier`, banners still work but click
  bounces to Script Editor.

### Changed

**Zero-setup Claude rendering fix**
- **Managed `~/.terminal-sessions/tmux.conf` bumped to v3.** The template now
  emits `set-environment -g CLAUDE_CODE_NO_FLICKER 1` and
  `set-environment -g CLAUDE_CODE_DISABLE_MOUSE_CLICKS 1`. Every new tmux
  window inherits them, so Claude Code renders in alt-screen and trackpad
  scroll stays inside the conversation view without any shell rc edit. Users
  on v2 configs see a one-time upgrade toast; the previous config is backed
  up with a timestamp suffix. Declining is remembered.
- The `Terminal Sessions: Fix Claude Code Rendering in Shell` command from
  v0.10 is still available for users who also run Claude outside tmux, but
  most installs will never need it.

**Minor polish**
- **`Open in Integrated Terminal - Persistent` shows the real folder.** The
  VS Code tab description now reflects the sub-folder you right-clicked
  (e.g. `Store - Offers - From Sources & Networks`) instead of always showing
  the workspace root (`Projects`). Parity with VS Code's native command.

### Fixed

- **Multiple sidebar rows mirroring the same Claude state.** When you ran
  `claude --resume <id>` in several tmux tabs over time, the tracker map held
  every old association. Triggering Claude in one tab lit up every tab that
  had ever touched the conversation, with the same `working 3s, 33% ctx` state
  on all of them. Now a new hook event transfers ownership: any other tmux
  session that had the same Claude session ID is cleared from the map, and
  only the most recent tab shows live state.
- **Restart could send `claude --resume` into a dead tab.** After killing the
  old tmux session, the VS Code tab sometimes outlived its shell (inner
  process already exited). The follow-up `openTerminalForSession` returned the
  dead tab instead of creating a new one, and `sendText` went nowhere. The
  restart flow now disposes the stale tab through an `onDidCloseTerminal`
  wait (with a 500 ms ceiling) before creating the replacement, checks
  `vscode.window.terminals.includes(term)` right before firing the resume
  command, and guards the call with try/catch.
- **Stuck "working" state after Esc / cancel.** The previous heuristic
  required a `[Request interrupted by user]` marker in the last user message.
  When Claude was mid-stream and you hit Esc, the marker landed in the last
  assistant message instead, leaving the state stuck. State transition is now
  triggered by either marker location. For cases where Claude writes no
  interrupt marker at all, a secondary heuristic based on transcript JSONL
  file mtime drops to idle after 90 seconds of no writes — long-thinking
  turns that legitimately produce chunks keep the file live and stay
  `working` indefinitely.
- **Context % inflated for fresh Opus 4.5+ sessions.** The limit used to be
  assumed 200k until a single turn crossed it. Opus/Sonnet 4.5+ run under a
  1M-context beta header by default, so short sessions that never crossed
  200k were divided by the wrong denominator, reporting `~55% ctx` when
  Claude's own status bar showed `11% ctx`. The context limit now defaults to
  1M for Opus/Sonnet 4.5+ models regardless of observed max; falls back to
  200k for older models unless a turn goes over.
- **Stale tracker entries survived indefinitely.** When Claude Code pruned an
  old transcript `.jsonl`, `~/.terminal-sessions/claude-map.json` still
  referenced it. The sidebar and the restart dialog kept offering sessions
  that Claude itself could no longer load, producing the
  `No conversation found with session ID:` error. Entries whose transcripts
  have disappeared are now treated as absent at read time.

### Security
- **Validation on hook-sourced input.** The `claude-hook.sh` log stream is
  written by the extension's own hook but lives at
  `~/.terminal-sessions/claude-events.log`; a crafted line could, in principle,
  smuggle `../../` segments into downstream path joins. `sessionId` is now
  matched against a UUID allowlist
  (`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-…-[0-9a-fA-F]{12}`) before assignment, and
  `cwd` is passed through `path.resolve` to collapse relative segments before
  reaching `path.join`.

### Internal
- `cmdRestart` refactored to use a `disposeAndWait` helper that resolves on
  the terminal's close event or a 500 ms timeout, replacing an opportunistic
  `sleep(150)`.
- `transcriptPathFor` from `claude-transcript.ts` is now the single source of
  truth for JSONL path construction; the inline duplicate in `commands.ts`
  was removed.
- Top-level `import * as os/fs` replaces inline `require()` calls in
  `commands.ts` for consistency with the rest of the source tree.
- `void maybePromptInstallClaudeHook(ctx)` makes the fire-and-forget intent
  explicit and satisfies floating-promise lint rules.
- SessionTreeItem `contextValue` now encodes mute state (`session` vs
  `session.muted`) so the view-item/context menu can show Mute vs Unmute
  conditionally; all other existing menus use a regex `=~ /^session/` match
  so they keep working regardless of mute state.

## [0.10.0] — 2026-04-24

Claude Code rendering fixes in tmux. Background: Claude Code's Ink/React
renderer does full-frame redraws into the main scrollback on every state
update, which tmux faithfully preserves — producing garbled scrollback and
duplicate prompt/spinner frames, worse after detach/reattach and during heavy
subagent activity. See `anthropics/claude-code#29937`, `#41814`, `#46981`.

### Added
- **`Terminal Sessions: Fix Claude Code Rendering in Shell`** command. Detects
  your shell (`zsh` / `bash` / `fish`), opens a confirmation dialog with
  exactly what will be appended (`CLAUDE_CODE_NO_FLICKER=1` and
  `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`), and writes to your rc file. Also
  available as "Show only (I paste manually)" for the paranoid.
  - **`NO_FLICKER=1`** puts Claude into fullscreen (alt-screen) rendering so
    the tmux scrollback stays clean. Trade-off: to copy text from Claude's
    conversation view, press `Ctrl+O` then `[` — that dumps the view into the
    main tmux scrollback, where drag-select + OSC 52 copy works normally.
    Copy from plain shell output is unaffected.
  - **`DISABLE_MOUSE_CLICKS=1`** (not `DISABLE_MOUSE=1`): clicks go to tmux so
    you can still select panes, tabs, etc. natively, but scroll events still
    reach Claude Code so the trackpad scrolls the conversation. `DISABLE_MOUSE`
    alone would block trackpad scroll inside Claude.
  - The command migrates users who ran earlier iterations that wrote the
    `DISABLE_MOUSE=1` variant — it replaces the line in place on rerun.
- **tmux.conf auto-upgrade prompt.** If your managed `~/.terminal-sessions/
  tmux.conf` was generated by a pre-0.10 release, you'll see a one-time toast
  offering to regenerate it. The old file is backed up next to it with a
  timestamp suffix before the rewrite. "Don't ask again" is remembered.

### Changed
- **Managed tmux.conf template updated** with TUI-friendly renderer settings:
  - `default-terminal` → `tmux-256color` (project-recommended; was
    `xterm-256color`)
  - Truecolor cap updated: `xterm-256color:RGB` (was the legacy `*256col*:Tc`)
  - `set -as terminal-features ',xterm*:sync'` — pass DECSET 2026
    synchronized-output through tmux, which lets apps like Claude Code
    eliminate flicker once they start emitting the sequence. Requires
    tmux 3.4+.
  - `set -g allow-passthrough on` — let TUIs send OSC/kitty-graphics/clipboard
    sequences through unfiltered.
  - `set -g extended-keys on` + `set -as terminal-features 'xterm*:extkeys'`
    — modern CSI-u encoding so Ctrl+Shift combos reach Claude Code correctly.

### Notes
The tmux config alone is a marginal improvement because the underlying bug is
in Claude Code's renderer, not tmux. The practical fix is the
`CLAUDE_CODE_NO_FLICKER=1` env var (requires Claude Code ≥ 2.1.110, earlier
versions had a regression that wiped scrollback). The new command handles
that wiring for you. Zellij has the same bug — see
`anthropics/claude-code#52304` — so backend migration is not on the roadmap
as a fix for this.

## [0.9.3] — 2026-04-23

### Fixed
- **Sidebar stayed stuck on `idle` while Claude was actually generating.** Claude Code reads `~/.claude/settings.json` once at startup, so when the extension upgraded the hook set mid-session the new `UserPromptSubmit` / `PreToolUse` hooks never fired for the already-running session. State updates now fall back to the transcript: if `lastUserMessageAt > lastAssistantMessageAt`, the session is `working`; otherwise `idle`. Hook events are still used when they arrive (for `tool` and `waiting input`) but are no longer required for the `working`/`idle` flip.
- **Context % only showed above the warn threshold.** Now it shows on every Claude-active session regardless of value (e.g. `idle 3m · 31% ctx`). When it crosses `terminalSessions.contextWarnPct`, a `⚠` prefix is added (`idle · ⚠ 87% ctx`).

## [0.9.2] — 2026-04-23

### Fixed
- **API cost calculation used Opus 4.1 rates for all Opus models, overstating cost by ~3x for Opus 4.5/4.6/4.7.** Verified against the live [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing): Opus 4.5+ is `$5/$25/$6.25/$10/$0.50` (input / output / 5m cache / 1h cache / cache read) per MTok, vs Opus 4/4.1 at `$15/$75/$18.75/$30/$1.50`. Re-ran on the in-progress session: result dropped from `$160.74` to `$55.25`, much closer to reality.
- **Cost double-counted retried turns.** Claude Code sometimes writes the same `assistant` event multiple times to the transcript when the API call is retried. Cost is now deduplicated by `message.id` so a retried turn is billed once.
- **Cache creation was always billed at the 5-minute rate** even when the transcript recorded 1-hour cache writes (2× the 5-minute rate). The new logic reads `usage.cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` separately and applies the correct multiplier to each.

### Added
- **`claude-pricing.ts`** module with an up-to-date Anthropic rate card covering Opus 4 / 4.1 / 4.5 / 4.6 / 4.7, Sonnet 4 / 4.5 / 4.6, Haiku 3.5 / 4.5. Selection keys off the model string in the transcript (e.g. `claude-opus-4-7` → Opus 4.5+ tier).
- **Tooltip now shows cost breakdown per model** (e.g. `opus: $5.80 · sonnet: $0.18`) alongside the tokens breakdown (input / output / cache read / cache 5m / cache 1h) for transparency.

## [0.9.1] — superseded by 0.9.2

Attempted to drop the cost feature after the v0.9.0 numbers disagreed with `ccusage`. Investigation in 0.9.2 revealed the rate-card was wrong (Opus 4.7 was treated as Opus 4.1), not the methodology — so cost is restored with the correct prices.

### Fixed
- **Context % was computed against the wrong window limit.** Opus-4.7 with the 1M-context beta header was being measured against a hardcoded 200k ceiling, producing nonsensical values like `124% ctx`. Limit is now inferred dynamically per session: if any single turn's input + cache-read + cache-create has exceeded 200k, the session is treated as 1M-context; otherwise 200k.
- **Subagent turns were inflating the main-thread context %.** Entries with `isSidechain: true` (subagent invocations) are now excluded from the context-window gauge because subagents have their own context, separate from the main conversation.

## [0.9.0] — superseded by 0.9.2

Initial attempt at real-cost tracking and 1M context detection. Both issues surfaced in live use — see 0.9.1 (context) and 0.9.2 (cost) for the resolutions.

### Added
- **Find-Session command** (`terminalSessions.findSession`) + `$(search)` button in the sidebar title. Opens a fuzzy picker across every Claude transcript under `~/.claude/projects/` — matches the first/last user prompt, cwd, and session ID. Selecting a result offers: open transcript in editor, copy session ID, reveal cwd. The search index is persisted at `~/.terminal-sessions/search-index.json` (~600 bytes per session, refreshed on activation and incrementally on new files).
- **Context-window usage badge** next to the Claude state. When the latest turn crosses `terminalSessions.contextWarnPct` (default 0.8 = 80%), a `87% ctx` suffix is appended so you know when to run `/compact`.
- **Theme colors for Claude state icons** via `contributes.colors`: `terminalSessions.workingIcon` (yellow), `toolIcon` (blue), `waitingIcon` (orange), `idleIcon` (green). Override in your theme or `workbench.colorCustomizations`.

## [0.8.1] — 2026-04-23

### Fixed
- **Interrupt detection** — when the user presses Esc to interrupt Claude, the Stop hook doesn't always fire. The tracker now treats a new user message in the transcript (or the literal string `[Request interrupted by user]`) as an end-of-turn signal and resets state to `idle`.
- **Misleading token total** — `97.0M tok` was the sum of cache-read tokens across every message (same context re-read dozens of times). Now the detail row shows only the net output total (`403k out`).

## [0.8.0] — 2026-04-23

### Added
- **Live Claude Code status in the sidebar** — per-session indicator for `working | tool | waiting | idle | none`, icon color per state, and nested detail rows under each session showing last user message, last Claude reply, model, token output, turn count.
- **Transcript tailing** — watches `~/.claude/projects/<slug>/<sessionId>.jsonl` in real time to extract preview messages, model, and token usage.
- **Setting `terminalSessions.claudeSidebarDetails`** with modes `auto | always | off` to control whether the detail rows appear under each session.

### Fixed
- **Claude hook was not capturing session IDs** — the shell script read `CLAUDE_SESSION_ID` from env (never set) instead of parsing the JSON payload on stdin. The rewrite reads stdin JSON and also extracts `tool_name`, `tool_input`, and `transcript_path`. Installing hooks now registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`; old one-event installs are auto-upgraded on activation.

## [0.7.1] — 2026-04-23

### Fixed
- **Drag-and-drop one-position moves** in the sidebar did nothing. The drop handler always inserted before the target; now it detects direction against the source's original index and inserts before or after accordingly.

## [0.7.0] — 2026-04-23

### Added
- **Sidebar sort modes** — setting `terminalSessions.sidebarSortMode` with values `custom | mru | created | alphabetical`, exposed as the `$(list-ordered)` icon in the view title. Custom mode is drag-reorderable with the order persisted in `~/.terminal-sessions/index.json`; dragging from any mode auto-switches to Custom.
- **MRU tracking** via `onDidChangeActiveTerminal` — the terminal you just focused floats to top when sort mode is `mru`.

### Removed
- **`syncSidebarOrderToTabs` setting** — dropped because VS Code's `vscode.window.terminals` array is in creation order, not visual tab order, so the setting never actually did what its name suggested. Replaced with the more honest sort-mode picker above.

## [0.6.0] — 2026-04-23

### Added (removed in 0.7.0)
- Attempted one-way sync from terminal tab order to sidebar. Abandoned after discovering the underlying API limitation — see 0.7.0 notes.

## [0.5.0] — 2026-04-22

### Changed
- Explorer right-click context menu entry renamed `Open in Integrated Terminal (Pers)` → `Open in Integrated Terminal - Persistent`.

## [0.4.x] — 2026-04-22

### Added
- **Explorer right-click** → "Open in Integrated Terminal - Persistent" opens a workspace-scoped tmux session rooted at the clicked folder, auto-labeled with the folder basename.
- **Smart click behavior** — clicking a session that's already attached focuses the existing terminal tab instead of opening a duplicate.
- Publisher renamed `adi` → `visul` (GitHub + OpenVSX).

## [0.3.x and earlier]

Initial releases. Core tmux-backed persistent terminals, workspace-scoped naming, sidebar, status bar, auto-restore, managed `tmux.conf`, Claude Stop notifications (v1 hook).
