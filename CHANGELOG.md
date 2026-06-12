# Changelog

All notable changes to the Terminal Sessions extension.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semantic versioning once past 1.0.0.

## [0.14.4] — 2026-06-12

### Fixed
- **Copying non-ASCII text from the terminal no longer mangles it on paste (ș → È™).** Cursor/VS Code mis-decode OSC 52 clipboard payloads as Latin-1, so Romanian diacritics (and CJK, Cyrillic, etc.) came out double-encoded when you pasted a terminal selection into another app — even though the terminal showed them correctly. This is an editor-side bug (works in VS Code, broken in Cursor; see Cursor forum + anthropics/claude-code#66098/#66269, microsoft/terminal#7819). The managed `~/.terminal-sessions/tmux.conf` now copies the selection through a real clipboard program — `pbcopy` on macOS, `wl-copy`/`xclip`/`xsel` on Linux — which writes correct UTF-8 straight to the system clipboard and bypasses the broken OSC 52 path. `set-clipboard` is set to `external` so apps inside tmux can still use OSC 52 themselves; only tmux's own copy stops using it. Where no clipboard program is found (e.g. a headless box), it falls back to the previous OSC 52 behaviour.
  - **Mouse-drag selection** now copies via the clipboard program and exits copy-mode. Tip: select with a **plain drag** (no Option/Shift) so the selection goes through tmux → the footer shows "copied N chars to clipboard" and the paste is clean. Holding Option routes the copy through Cursor's own (buggy) clipboard path instead.
  - The tmux.conf version bumped (`v4` → `v5`); the extension offers to regenerate it (a backup of your current file is saved alongside).

## [0.14.3] — 2026-06-12

### Added
- **"Reveal Session in Sidebar" from a terminal.** Right-click a terminal tab (or inside the terminal body) → "Reveal Session in Sidebar" to select and scroll to that session in the Terminal Sessions tree, expanding any parent group/master so it comes into view. Focusing a terminal tab already auto-highlights its session; this is the explicit, deliberate trigger. (VS Code exposes no double-click or inline hover-button action for terminal tabs, so the context menu is the available surface.)

### Fixed
- **Re-attach, reveal, and tab-focus highlight now work on tabs you renamed (no `#<tabId>` in the label).** Identity previously relied on either the terminal's `shellArgs` (trimmed on reload) or the tab label's `#<tabId>` (gone once you rename the tab), so a renamed-and-reloaded tab couldn't be matched to its tmux session — re-attach reported it as "unrecognized" and did nothing. As a last resort it now reads the live `tmux … attach-session -t <name>` process via the terminal's PID, which survives both reload and rename. Re-attach also now scans the open terminals directly (in panel order) instead of iterating sessions, so renamed tabs are no longer missed.
- **Tab-focus auto-highlight now works on reload-restored terminals.** Clicking a terminal tab is meant to highlight its session in the sidebar, but it silently did nothing for ⚠ disconnected tabs after a reload (their trimmed `shellArgs` hid the tmux name). It now resolves the session robustly via the tab label, and also reveals sessions nested inside collapsed groups/masters.
- **"Re-attach All Ghost Terminals" now also revives the ⚠ disconnected tabs left after a window reload, not just process-exited ones.** After a Reload Window (as opposed to a full quit), VS Code keeps the terminal's pty but marks the tab with a warning triangle; these tabs carry no `exitStatus`, so the old check counted them as "live" and the button reported "N already live" while doing nothing. They are now detected (VS Code trims their `creationOptions`, so the absence of the tmux name in `shellArgs` is the signal) and reconnected. Because the underlying tmux session is still alive with its program inside, these are reconnected with a plain `tmux attach` and **no** agent-resume injection (resume stays reserved for true exited ghosts whose pane may have dropped to a bare shell), so it never types `claude --resume` into a live agent.
- **"Reveal Session Folder" works on reload-restored terminals.** The terminal-side reveal previously failed with "Could not determine the session folder" on ⚠ disconnected tabs, because their trimmed `shellArgs` hid the tmux name. It now falls back to the tab label's `#<tabId>` to find the session in the index.
- **Re-attach preserves the existing tab order.** Re-attached terminals are now recreated in the order they currently sit in the panel (left to right), so they come back exactly where you had them instead of jumping to sidebar-sort order.

## [0.14.2] — 2026-06-10

### Added
- **"Reveal Session Folder" is now also in the terminal TAB context menu.** Right-click a terminal tab in the panel (not just inside the terminal body or the sidebar) and pick "Reveal Session Folder in Explorer / Finder". The command resolves the terminal VS Code hands it (or the active terminal, since right-clicking a tab activates it) back to its tmux session to find the folder.

## [0.14.1] — 2026-06-10

### Added
- **"Reveal Session Folder" right-click command (Explorer + Finder).** A session now carries the folder it was opened in (its recorded `folderPath`, or the workspace root for workspace-level sessions); right-click a session in the sidebar — or right-click inside a session terminal — and pick "Reveal Session Folder in Explorer" / "...in Finder" to jump straight to that exact folder. Distinct from the existing selection-based "Reveal in Finder/Explorer" (which resolves a path you highlighted in the terminal output): this one always targets where the session started, no selection needed. The terminal-side entry resolves the active terminal back to its tmux session to find the folder.

## [0.14.0] — 2026-06-08

### Added
- **Multi-agent support: Codex and Antigravity (`agy`) alongside Claude.** The deep per-session integration the sidebar gave Claude Code (live working/tool/waiting/idle state, context %, token/cost, auto-resume after Stop→Start and reboot, OS notifications) now also tracks OpenAI **Codex** and Google **Antigravity** running in your tmux panes. Each row shows the agent it belongs to ("Codex working 12s" vs Claude's "working 12s"), and resume sends the right command per agent (`claude --resume`, `codex resume`, `agy --conversation`).
  - **How it works:** a single `AgentProvider` abstraction with Claude as provider #1. A shared hook forwarder (`agent-hook.sh`) self-identifies the source agent and writes a unified, agent-tagged event log; per-agent providers own transcript parsing (Codex rollout JSONL `token_count`, Antigravity `brain/<id>/…/transcript.jsonl` + statusLine), resume syntax, and hook install targets (`~/.codex/hooks.json`, `~/.gemini/antigravity-cli/settings.json`).
  - **Enable:** `terminalSessions.enabledAgents` (defaults to auto-detect: Claude always on; Codex and Antigravity turn on when their CLI is found on PATH). Run "Terminal Sessions: Install AI Agent Hooks (Claude / Codex / Antigravity)" to wire the hooks, or accept the install prompt.
  - **Codex caveat:** Codex `PreToolUse`/`PostToolUse` hooks currently fire only for the Bash tool, so working/idle state is driven primarily from the rollout transcript (`task_started`/`task_complete`), with hooks/notify for the done / needs-approval notifications.
- **Agent-tagged session history.** Resume history (`agentSessions[]`) now spans every CLI that ran in a tmux session; the legacy Claude-only fields are still mirrored for back-compat, and old index files keep working.

### Changed
- **Hook install/uninstall, resume, and notifications are now agent-aware.** The install command installs hooks for every enabled agent and migrates existing Claude installs from the legacy `claude-hook.sh` to the shared `agent-hook.sh` forwarder (the silent activation upgrade only touches agents whose hook is already present). Notifications read "🤖 Codex done" / "Antigravity needs approval" etc. The "Resume Other Session..." picker is agent-scoped. Claude behavior is unchanged.

## [0.13.22] — 2026-06-02

### Added
- **Master groups (groups of groups).** A new container kind that holds only other groups/masters, never sessions directly. Rendered with a distinct `library` icon and a `(N groups)` description so it reads clearly as a folder-of-folders. Nesting is arbitrary-depth: master → master → … → group → sessions.
  - **Create:** right-click workspace → "New Master Group..."; right-click a master → "New Group Inside" / "New Master Group..." to nest.
  - **Move:** drag a group/master onto a master to nest it; drag it onto the workspace root to pop it back out; or right-click → "Move to Master Group..." for a quick pick (cycle-creating targets are filtered out).
  - **Delete:** deleting a master pops its direct children up one level (to the master's own parent, or root) — nothing nested is recursively deleted, and no sessions are touched.
  - **Cycle-safe:** a master can't be moved inside itself or any of its own descendants (enforced in both drag-drop and the quick pick).
  - **Filter-aware:** under the running/stopped filter, a master is hidden when no session anywhere beneath it matches.

## [0.13.21] — 2026-05-26

### Fixed
- **Couldn't reorder a group between two other groups via drag-drop.** Dropping a group onto another group set the drop destination to the *target group's interior* (`destGroupId = target.groupId`), so the reorder ran against the sessions inside that group — a list the dragged group isn't even part of, hence nothing moved. Groups can only ever live at the workspace root, so the destination parent is now forced to root whenever the drag payload contains a group; the target (group or session) acts purely as a reorder anchor among root-level siblings. Group-between-groups reordering now works, as does dropping a group next to a root-level session.

## [0.13.20] — 2026-05-26

### Added
- **"Resume Other Claude Session..." right-click command.** Surfaces every Claude sessionId in the tmux's `claudeSessionHistory`, with cwd · line count · age · first user prompt preview. Pick one explicitly and the extension sends `cd "<recordedCwd>" && claude --resume <id>` to the session's attached terminal. Use when auto-resume's smart pick is still wrong (e.g. multiple substantial conversations under the same folderPath) or when you want to revisit an older conversation that auto-resume deprioritized.

### Changed
- **Auto-resume now applies a cwd-subset filter + size-based tie-break instead of head-first walk.** A sessionId's transcript cwd must be the tmux session's `folderPath` (or workspace root) or a descendant of it — otherwise it's polluted history (a brief `claude --resume <foreign-id>` glance) and gets skipped. Among in-scope candidates, the largest transcript wins; brief touches under 5 KB are dropped from auto-resume entirely (still visible in the picker). Real consequence: in a tmux where a tiny categorize-categories session and a 22k-line FirstHand-Data conversation share the same folderPath, auto-resume now picks the FirstHand one. Falls back to head-first if every candidate fails the cwd filter, so the worst case is "no change in behavior" rather than "silently does nothing".

## [0.13.19] — 2026-05-26

### Fixed
- **Auto-resume skipped sessions whose `lastClaudeSessionId` pointed at a transcript Claude had since pruned.** Claude Code deletes 0-turn / aborted sessions from disk silently. If a previous Stop->Start fired `claude --resume <head>` and it failed (e.g. the cwd was wrong before v0.13.18, or the user hit Esc immediately), Claude created a fresh 0-turn session, recorded its id as the new head via the hook, then deleted that transcript when it ended — leaving `lastClaudeSessionId` pointing at a dead file. Every subsequent Stop->Start then silently skipped resume (`findTranscriptBySessionId` returned undefined for the dead head), and the original conversation sitting one slot deeper in `claudeSessionHistory` was ignored. Fix: new `resolveResumeFromHistory(liveSid, meta, cwd)` walks the live map → `lastClaudeSessionId` → full `claudeSessionHistory` (most-recent-first, deduped) and returns the first one whose transcript is still on disk. Wired into cmdStart, cmdRestart, cmdReattachAll, and the reboot-recovery path in restore.ts. Now a botched resume can't poison subsequent restarts — they walk past the ghost and pick up the real conversation.

## [0.13.18] — 2026-05-25

### Fixed
- **Auto-resume fired `claude --resume <id>` from the wrong cwd, returning "No conversation found".** Even after v0.13.17 located the transcript across all project-slug dirs, the actual resume command was sent in whatever cwd the new tmux session landed in (`folderPath` or workspace root). `claude --resume` is project-scoped — it only finds the conversation when invoked from the SAME cwd-slug it was launched in. A session recorded in `__DPF_DB/_Categories` cannot be resumed from `__DPF_DB`. Fix: new `readTranscriptCwd(path)` reads the first `cwd` field embedded in the JSONL transcript and `buildResumeCommand` prepends `cd "<recordedCwd>" && ` to the resume command when it differs from the terminal's current cwd. Wired into `cmdStart`, `cmdRestart`, `cmdReattachAll`, and `maybeOfferRestore`. Properly quoted to survive spaces / `@` / underscores in folder names.

## [0.13.17] — 2026-05-25

### Fixed
- **Auto-resume Claude after Stop->Start skipped sessions whose transcript was written under a different cwd than the recorded `folderPath`.** Stop->Start computed the transcript path as `~/.claude/projects/<slug(folderPath)>/<sessionId>.jsonl` and bailed if the file wasn't there — but the slug Claude actually chose at session-start depends on the cwd in effect when `claude` was launched. Common shapes that broke: (a) user `cd`-ed into a subdir before running `claude`, (b) `claude --resume <id>` was fired from the workspace root after the session had been created in a subfolder, (c) the user moved between two distinct project dirs in the same tmux tab. Fix: new helper `findTranscriptBySessionId(cwd, sessionId)` tries the fast path first (slug(cwd)) and otherwise single-level scans `~/.claude/projects/*/` for `<sessionId>.jsonl` — finds the transcript wherever Claude wrote it. Wired into `cmdStart`, `cmdRestart`, `cmdReattachAll`, and `maybeOfferRestore`, so auto-resume now succeeds for every sessionId Claude still has on disk.

## [0.13.16] — 2026-05-25

### Fixed
- **`recordWorkspace` wiped `groups` on every workspace touch.** The function rebuilt the workspace entry listing only `path/label/lastSeen/sessions`, silently dropping the newly-added `groups` map. Pressing "+ New Persistent Terminal" calls `recordWorkspace` first thing in `provideTerminalProfile`, so creating any new session erased every user-defined folder while leaving `session.groupId` refs dangling. Fix: spread the existing entry first and only override the volatile fields.

## [0.13.15] — 2026-05-25

### Added
- **User-defined groups (folders) within a workspace.** Sessions and groups sit at the same level under the workspace and share a single sortOrder pool — drag-drop reorders both kinds. New per-workspace `groups: Record<id, {name, sortOrder}>` in index.json keyed by short random ids (so renaming a group doesn't invalidate `session.groupId` refs). Empty groups are hidden when the filter (running/stopped) eliminates all their members.
- **Commands:** "New Group..." (right-click workspace), "Rename Group" / "Delete Group" (right-click group), "Move to Group..." (right-click session — quick pick of existing groups + "New group..." + "Remove from group"). Delete group asks for confirmation and orphans sessions back to the workspace root (none are killed).
- **Drag-drop into / out of groups:** session dropped on a group folder gets that groupId; dropped on a session inside a group joins that group; dropped on the workspace gets its groupId cleared. Groups dropped on each other reorder at root. Cross-workspace drops are still refused.

## [0.13.14] — 2026-05-25

### Fixed
- **Ghost "working" spinner on sessions that aren't running Claude.** When a Claude session-id moved between tmux tabs (`/clear` + `claude --resume <id>` in another tab) or a session was Stopped, the source tab's tracker snap kept pointing at the now-foreign transcript. The 90s mtime stale-out couldn't trigger because the new owner kept writing chunks, so the abandoned row sat spinning "working 48h" forever — and the spin would noticeably reappear after every sidebar refresh (notably right after Stop on a different session). Two-part fix: (a) `getSnapshot` now does an ownership check before any state reasoning — if the snap's sessionId doesn't match the active claude-map entry for this tmux, the snap is cleared to `none` and returned early; (b) `cmdStop` calls a new `tracker.forgetSession(name)` that drops the map entry, snapshot, and waiting-notify cooldown for the stopped tmux, so the sidebar doesn't keep mirroring a Claude conversation the killed tab no longer owns.

## [0.13.13] — 2026-05-25

### Changed
- **Detached sessions now show a hollow circle icon** (`circle-outline`) regardless of Claude state, instead of inheriting the attached state icon. Visual cue that nobody's currently attached to the tmux session, while the icon color still carries Claude state.
- **Removed trailing "· attached" from session descriptions.** The attached state is now encoded entirely in the icon (filled vs outline), freeing up horizontal space on every row.
- **Removed "🤖 N done" subagent counter.** Only "🤖 N running" stays — the done count was historical noise that grew unbounded over a session's lifetime without offering anything actionable.
- **Context % moved from the main row to the expanded details row.** Now appears alongside `model · cost · turns`, e.g. `opus · $3.51 · 14 turns · 9% ctx`. Keeps the always-visible row tighter while still showing context usage when the session is expanded. Warning prefix (`⚠`) still fires when crossing `terminalSessions.contextPctAlert`.

## [0.13.12] — 2026-05-25

### Added
- **"Re-attach All" sidebar action.** New toolbar button next to Refresh that disposes every "process exited" ghost terminal (the orange ⚠ tabs VS Code leaves behind after a Cursor restart) and re-creates a live tmux-attached terminal for each, in the current sidebar sort order. Skips: stopped sessions, sessions without any tab in the terminal panel (user wasn't using them), and sessions whose terminal is already live (no scroll-buffer disruption). Claude `--resume <id>` is batched after a single shell-init wait — N sessions cost ~1.5 s total instead of N × 1.5 s. Toast summarizes attached / resumed / skipped / failed.

## [0.13.11] — 2026-05-24

### Fixed
- **Post-reboot restore (and Stop->Start) now finds Claude transcripts for sessions whose `folderPath` was never recorded.** The transcript existence check builds the Claude project slug from `meta.folderPath || ws.path`, so a session that was launched in a subfolder via the integrated terminal — but never went through right-click → "New Persistent in Folder" — falls back to the workspace root and the check fails (file lives under the subfolder's slug, not the root's). Two-part fix: (a) the activation-time backfill now also scans the event log for each session's most recent non-empty `cwd` and sets it as `folderPath` when missing; (b) the live hook handler does the same opportunistically the first time it sees a `cwd` for a session whose `folderPath` is still empty. Sticky once set, so a later `cd` inside the session doesn't overwrite the creation directory.

## [0.13.10] — 2026-05-24

### Fixed
- Cumulative release confirming the Stop→Start auto-resume chain end-to-end after the v0.13.5→v0.13.9 fixes: persisted `claudeSessionHistory`, activation-time backfill from the event log, corrected `slugFromCwd` encoding for cwd paths containing underscores/dots/spaces, and the `meta.folderPath`-based transcript existence check. No new code in this release; bumping for the verified-working snapshot.

## [0.13.9] — 2026-05-24

### Fixed
- **`slugFromCwd` now matches Claude Code's actual project-slug encoding.** Claude stores every transcript under `~/.claude/projects/<slug>/<sessionId>.jsonl` where `<slug>` is the cwd with every non-alphanumeric character (except `-`) replaced by `-` — so `/Users/adi/MyWork/Projects/__DPF_DB` becomes `-Users-adi-MyWork-Projects---DPF-DB`. The previous implementation only replaced `/`, silently producing a wrong slug for any cwd that contained underscores, dots, spaces, `@`, etc. The transcript existence check in `cmdStart` / `cmdRestart` / `maybeOfferRestore` then returned false and the auto-resume was skipped — so Stop→Start (and reboot recovery) looked like nothing happened even when the conversation was sitting right on disk. The regex now strips the leading `/`, then replaces every char outside `[A-Za-z0-9-]` with `-`.

## [0.13.8] — 2026-05-24

### Added
- **Per-session Claude history (`claudeSessionHistory`).** Each tmux entry in the session index now keeps an ordered list of every Claude session id that ever ran in it (most recent first, capped at 10). The head feeds auto-resume on Stop→Start and post-reboot restore (same behavior as `lastClaudeSessionId` before), while older ids stick around so the user can manually `claude --resume <id>` an earlier conversation in the same terminal. `recordClaudeSession` on every hook event with a `session_id` dedupes-then-prepends; the activation-time backfill scans the event log and replays sightings oldest→newest so the resulting order matches what `recordClaudeSession` would have produced live. `lastClaudeSessionId` is kept in sync with `claudeSessionHistory[0]` for backwards compatibility.

## [0.13.7] — 2026-05-24

### Added
- **Post-reboot restore auto-resumes Claude per session.** Previously `maybeOfferRestore` recreated the tmux sessions and attached terminals but refused to inject `claude --resume <id>` ("never inject commands into the terminal automatically") — only a generic toast hint with a single workspace-wide most-recent session id. So a system reboot lost every per-tmux Claude link, even though the data was tracked. The restore now uses the same lookup chain as `cmdStart`: live tracker -> `meta.lastClaudeSessionId` -> transcript existence check against `meta.folderPath`. Per-session resume commands are batched after a single 1.5s shell-init wait, so a 16-session restore takes ~2s total instead of ~24s. Sessions without a tracked Claude id just attach to a fresh shell, same as before.

## [0.13.6] — 2026-05-24

### Fixed
- **Auto-backfill `lastClaudeSessionId` on extension activation.** v0.13.5 added the persisted historical mapping but only populated it on fresh hook events — sessions whose Claude conversations stopped firing events before the upgrade stayed empty and `Stop → Start` still skipped the resume. The tracker now walks `claude-events.log` once at startup, finds the most recent `sessionId` ever associated with each tmux name that lacks `lastClaudeSessionId`, and writes it into the session index. Subsequent fresh hooks continue to keep the field current; the backfill only fills the gaps.

## [0.13.5] — 2026-05-24

### Fixed
- **Stop -> Start now auto-resumes Claude even after the conversation moved to another tab.** The in-memory `claude-map` clears a tmux's mapping whenever the same Claude session id appears in a different tmux (e.g. you ran `claude --resume <id>` in another tab) so the sidebar doesn't mirror state across two rows. That cleanup also wiped the only record of which Claude session originally lived in the stopped tmux, so `cmdStart` had nothing to resume. The tmux's most recent Claude session id is now persisted as `lastClaudeSessionId` in the session index, set on every hook event with a `session_id`, and used as a fallback when the live map comes up empty. Existing sessions are backfilled from the event log on next extension activation (manual one-time script for now). The transcript existence check uses `meta.folderPath` instead of `ws.path` so sessions created in a subfolder find the right Claude project directory.
- `cmdRestart` picks up the same fallback chain, so a manual Restart of a session whose Claude conversation has moved no longer silently drops the resume.

## [0.13.4] — 2026-05-24

### Changed
- **Collapse-all keeps workspace folders open.** VS Code's built-in `Collapse All` button folded every level — including the workspace folder rows that hold all your sessions — so one click hid the entire tree. The new `$(collapse-all)` icon at the right of the sidebar title bar runs a custom command that collapses session detail rows (Claude inline detail children, Agents folder) and then re-expands the workspace folders so the session list stays visible. The built-in collapse-all is suppressed (`showCollapseAll: false`).

## [0.13.3] — 2026-05-24

### Fixed
- **`/clear` and `/compact` no longer leave the sidebar stuck on ⟳ working.** When the user runs a slash command that lands as the final user line in the JSONL without a follow-up assistant block (`/clear`, `/compact`, custom skill macros), `lastUserMessageAt > lastAssistantMessageAt` holds forever and the transcript-tailer was forcing `state = working` on every refresh. The same mtime freshness check used in the assistant branch now gates the user-newer branch too — if the transcript hasn't been touched in 30s, the slash-command prompt is old and the row falls back to `idle`.
- **Reattaching a session created in a subfolder no longer creates a tab that looks like a duplicate.** `openTerminalForSession` was ignoring the session's persisted `folderPath` and passing `cwd: undefined` to `vscode.window.createTerminal`, so VS Code grouped the reattach under the workspace root instead of the original subfolder — making the tab look like a separate "Projects"-grouped duplicate of the original "__DPF_DB"-grouped one. The function now resolves `cwd` to `meta.folderPath` first, falling back to the workspace path, so reattached terminals stay grouped with their originals.

## [0.13.2] — 2026-05-24

### Fixed
- **Sidebar no longer flips to ✓ idle while Claude is actively composing.** The transcript tailer's rule `assistant_ts ≥ user_ts → idle` was demoting `working` sessions to `idle` as soon as Claude's first assistant chunk landed in the JSONL — even though the message had only just started. `lastAssistantMessageAt` is the START of an assistant message and doesn't advance with subsequent streaming, so the rule misclassified every in-progress turn. The classifier now consults three signals: a Stop hook timestamp at-or-after the assistant message (genuinely done), the transcript file mtime (fresh within 30s = still streaming chunks = working), and the legacy `ta ≥ tu` fallback (idle when no other signal applies). The `working` 90-second mtime stale-out is preserved for the missed-Stop case.

## [0.13.1] — 2026-05-24

### Fixed
- **No more spurious ⚠ waiting state after idle turns.** Claude Code fires a `Notification` hook event ~60s after every Stop while sitting at the prompt ("Claude is waiting for your input"). The previous version treated that identically to a real permission block, flipping the sidebar to ⚠ waiting and ringing the alert sound — even though Claude had finished and was just idle. The forwarder hook (`media/claude-hook.sh` v3) now captures the `message` field; idle-nudge notifications are no-ops for state, while real permission blocks ("Claude needs your permission to use {Tool}") still flip to waiting and ring the alert. **Re-install the Claude hook** (`Terminal Sessions: Install Claude Code Hook`) or reload the extension to pick up the v3 forwarder.
- **Stuck `waiting` state self-heals via the transcript tailer.** The tailer used to refuse to leave `waiting` no matter what — so any missed Stop event after a real permission approval (Claude Code reads `settings.json` once at startup, so sessions begun before hook install never fire Stop reliably) left the sidebar showing ⚠ forever. The tailer now compares transcript activity against the `waitingSince` timestamp recorded when the wait began; newer assistant or user activity transitions the state to `idle` or `working` as appropriate. Legacy snapshots without `waitingSince` (pre-v0.13.1) are treated as stale and cleared on the next tailer pass.

## [0.13.0] — 2026-05-24

### Added
- **Stop / Start sessions.** New "Stop" command kills the tmux session but keeps the entry in the sidebar (marked with a muted ■ icon and greyed label). New "Start" command recreates the tmux session and — if a Claude conversation was tracked — auto-runs `claude --resume <id>` to restore the exact conversation. Reachable via the inline action row, right-click menu, or clicking a stopped row directly.
- **Filter dropdown in the title bar.** A new $(filter) icon lets you switch the sidebar between **All / Running only / Stopped only**. Active filter shown next to the "SESSIONS" header. Workspace counts always show running ▶ / detached ⇄ / stopped ⏸ totals regardless of the active filter.
- Confirmation modal when stopping a session whose Claude is actively `working` or `tool` (silent otherwise).

### Changed
- `WorkspaceTreeItem` description now includes a `· N⏸` suffix when any session in that workspace is stopped.
- `maybeOfferRestore` (workspace-open recovery) now skips sessions explicitly marked `stopped: true` — they stay stopped across VS Code restarts and surface in the sidebar via the merged tree.
- Tightened existing `viewItem =~ /^session/` `when` clauses to `=~ /^session($|\.muted$)/` so live-only actions (preview, mirror, restart, stop) don't appear on stopped rows.

## [0.12.5] — 2026-05-01

### Fixed
- **No more duplicate terminals when reattaching to a session that has a
  "process exited" ghost.** Clicking a session in the sidebar used to
  spawn a brand-new terminal whenever the previous tab had gone yellow
  (tmux client died, or VS Code restored the terminal across a window
  reload with trimmed creationOptions). The session lookup now (a) falls
  back to matching the terminal name suffix `#<tabId>` when shellArgs
  no longer carry the tmux session id, and (b) disposes any exited
  ghost it finds before opening the new live attach so you don't end up
  with two tabs for the same session.

## [0.12.4] — 2026-05-01

### Fixed
- **Restart now keeps the original folder.** Sessions created from a
  subfolder via right-click → *New Persistent in Folder* no longer drop
  back to the VS Code workspace root after a restart. The cwd is
  persisted in the session index (`folderPath`) at creation; for older
  sessions that pre-date this field, the live tmux `session_path` is
  read once before the kill and back-filled into the index, so a single
  restart self-heals the entry.
- **Post-reboot restore honors subfolder cwd.** The same `folderPath` is
  used when `maybeOfferRestore` recreates sessions after a tmux server
  death, instead of always pinning everything to the workspace root.

## [0.12.3] — 2026-04-25

Live visibility into Claude Code subagents. v0.12 introduced the subagent
tree; 0.12.1–0.12.3 refined it through real-world use to land the final
shape: a single tidy `🤖 Agents (N)` folder per session, background agents
parsed from their own per-agent transcripts (not the main jsonl sidechain),
and state inferred from file mtime + tool_use outstanding.

### Added
- **`🤖 Agents (N running · M done)` folder per Claude-active session.** A
  single collapsible group row wraps every subagent, so a session that
  spawned 6 agents doesn't dump 6 rows on the main list. Expanded by
  default while anything is live; collapsed when all are done. Tooltip
  previews the first five agents.
- **Live per-subagent tree row.** Each subagent shows state icon
  (spinner / tools / check), elapsed time, current tool with input
  preview, and last streamed message. Inline label comes from the `Agent`
  tool input — `<subagent_type> — <description>`, e.g.
  `researcher — MCP servers for note apps`. Subagents nest recursively for
  agents that spawn sub-subagents.
- **Inline subagent counter in the session description** — `Terminal
  Sessions waiting input · 69% ctx · 🤖 2 running` (falls back to
  `🤖 N done` when everything completed). Surfaces agent activity without
  having to expand the session.
- **Background-agent transcripts support.** Claude Code ≥ 2.1.119 spawns
  subagents via the `Agent` tool with `run_in_background: true`; their
  activity is NOT written as sidechain messages in the main jsonl, but
  into `<main-jsonl-path-without-ext>/subagents/agent-<id>.jsonl` plus
  `agent-<id>.meta.json`. The transcript tailer now scans this sibling
  directory on every 3-second poll (fs.watch only sees the main file),
  reads each agent's last `tool_use` / `text` block, and infers state
  from mtime: **< 30 s since last write = live; otherwise done.** The
  classic synchronous `Task` tool path (with sidechain messages in the
  same jsonl) keeps working.
- **Setting `terminalSessions.showCompletedSubagents`** (default `true`) —
  keep completed agents visible so short-running ones don't flicker in and
  out. Flip to `false` (or run `Terminal Sessions: Toggle Show Completed
  Subagents`) to focus only on live work.
- **`Open Subagent Transcript` command** — right-click a subagent row to
  open its transcript in an editor tab at the first line where that agent
  was first registered. For background agents this is the per-agent
  jsonl (much smaller and more readable than the main one).

### Changed
- **Sidebar children order under a session** — subagents group appears
  last, below the existing detail rows (last user, last Claude, current
  tool, metadata). Rationale: the conversation headline stays above the
  fold; subagents are auxiliary context you drill into when you need it.
- **Auto-done on parent session idle** is now time-gated (2 min grace)
  instead of firing instantly. Short idle flickers no longer clobber a
  legitimately running subagent's state.

### Internal
- New `SubagentSnapshot` type in `claude-transcript.ts` with fields for
  id, parent id, depth, agent type, description, current tool, last
  message, state, timestamps, and `firstOffset`.
- `TailState` now carries `subagentMap` (id → snapshot) + `msgInfo`
  (uuid → belongsTo + spawnedTasks) for main-thread sidechain
  attribution.
- New `scanBackgroundAgents(state)` helper reads the `subagents/`
  directory on every tick, pairs `.jsonl` + `.meta.json`, and computes a
  fresh `SubagentSnapshot` per agent. Deltas are diffed against the map
  so unchanged agents don't trigger sidebar refreshes.
- TranscriptTailer now owns a 3-second `setInterval` poll that calls
  `readDelta` for every tracked session, specifically to pick up
  background-agent file changes that `fs.watch` on the main jsonl
  misses.
- Sidebar: new `SubagentsFolderItem` (group header) and `SubagentTreeItem`
  (leaf) classes in `sidebar/items.ts`. Tree provider's `getChildren`
  branches on both to render the nested layout.

### Known limitations
- **Multi-Task messages in one assistant turn.** When a single message
  spawns more than one synchronous `Task` at once (uncommon but supported
  by the API), our parser attributes incoming sidechain messages to the
  most recently unresolved Task from that parent. Final done/working
  state remains correct because it relies on `tool_use_id` matching;
  only interior activity attribution can shift between parallel siblings.
- **Per-subagent cost breakdown** is not surfaced yet (roadmap v0.13).

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
