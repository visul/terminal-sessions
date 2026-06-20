# Design — Archive Browser, Conversation Viewer, Cleanup & Friendly Names

**Date:** 2026-06-20
**Status:** Approved shape, pending spec review
**Scope:** Three user-facing capabilities (+ one supporting store), inspired by the
`es6kr/claude-code-sessions` extension, re-expressed to fit our live-first,
multi-agent architecture.

## Background

`es6kr/claude-code-sessions` is an **archive manager**: it reads Claude's on-disk
session files (`~/.claude/projects/<slug>/<id>.jsonl`) and lets you browse, view,
resume, rename, clean up, move and split them. Our extension is a **live session
manager**: it tracks running tmux panes, their agent state, context/cost, and
auto-resumes the right conversation. The two are complementary. This design borrows
three of their ideas that add value to us, and deliberately drops the ones that
conflict with our philosophy or carry footguns.

Crucially, most of the supporting infrastructure already exists in our codebase:

- `provider.listSessions(cwd?)` (`src/agents/claude.ts:130`, plus codex/agy providers)
  already enumerates **all** on-disk sessions for an agent, returning
  `AgentSessionSummary[]` (agent, sessionId, transcriptPath, cwd, firstUserMessage,
  lineCount, byteSize, mtimeMs), mtime-sorted, with subagent logs (`agent-*.jsonl`)
  excluded via a UUID check.
- `readTranscriptSummary()` (`src/claude-transcript.ts:152`) reads cwd / first-user /
  line-count / size / mtime in one pass.
- `buildResumeCommand()` (`src/commands.ts:35`) + `provider.buildResumeCommand()`
  already produce the correct per-agent resume command (with `cd` to the recorded
  cwd for Claude).
- `cmdResumeOtherClaude()` (`src/commands.ts:1292`) is a working QuickPick pattern we
  can mirror, including the label/description/detail formatting.

So this is mostly **wiring + two new small modules**, not new subsystems.

## What we borrow vs. drop

**Borrow (techniques):**
- Enumerate all sessions from disk for an archive view (we already have `listSessions`).
- Exclude `agent-*.jsonl` subagent logs (already handled by the UUID filter).
- Cleanup as **soft-delete** into a `.bak/` sibling, and their safety boundary:
  never touch `~/.claude/__store.db`, history, or Claude's own session index.
- Derive a display title from the first user message.

**Drop (footguns / off-philosophy):**
- **Rename by rewriting Claude's `.jsonl`** (they append `custom-title` records in
  place with no backup). Conflicts with our "never rewrite live content" rule and
  risks truncating a transcript on a mid-write crash. We use a sidecar name store.
- **Split / move-between-projects / drag&drop** — niche, and they write in place
  without backup. Out of scope.
- **A separate Web UI / MCP server** — different product surface. Out of scope.

## Goals

1. **Resume any past session** from disk, cross-agent, even when nothing is live in
   tmux for it.
2. **View a conversation** in a readable, themed format without re-opening it or
   squinting at raw `.jsonl`.
3. **Clean up** empty/invalid sessions safely (soft-delete, previewed, scoped).
4. **Name a session** with a friendly label that surfaces in (1) and (2), without
   mutating Claude's files.

## Non-goals

Splitting/moving sessions, editing transcript content, a sidebar "Archive" tree
branch (we use a QuickPick to keep the live tree clean), cross-machine sync of
names, and any search UI (we already have `ClaudeSearchIndex` to build on later —
explicitly deferred, YAGNI).

---

## Architecture

Four units, each with one clear purpose:

```
src/archive.ts          (NEW)  scan + classify + soft-delete; pure-ish, fs-only
src/transcript-render.ts (NEW) transcriptToMarkdown(path) → markdown string
src/commands.ts         (EDIT) 3 new command handlers + wiring
src/session-manager.ts  (EDIT) friendly-name store (get/set), new index field
src/types.ts            (EDIT) WorkspaceIndex.sessionNames map
package.json            (EDIT) contribute commands + menu items
```

The `AgentRegistry` is the single source of which providers exist/are enabled;
every scan iterates the registry rather than hardcoding agents.

### Unit 0 — Archive scan core (`src/archive.ts`)

Thin aggregation over what providers already do.

```ts
export interface ArchivedSession extends AgentSessionSummary {
  friendlyName?: string;       // from the sidecar name store, if any
}

// Merge listSessions() across providers. scopeCwd undefined = all projects.
export function scanArchive(
  registry: AgentRegistry,
  names: SessionIndex,
  scopeCwd?: string,
): ArchivedSession[];
```

- Iterate the registry's providers (a small `registry.providers()` / `enabled()`
  accessor — add it if not already present; the registry is the single source of
  which agents exist); call `provider.listSessions(scopeCwd)`.
- Merge, attach `friendlyName` from the name store (keyed by sessionId), keep the
  providers' mtime-desc order.
- No new disk-walking logic — reuse `listSessions`. The only cost knob: when
  `scopeCwd` is set, providers scan a single slug (cheap); unscoped scans all.

### Unit 1 — Resume from Archive (`terminalSessions.resumeFromArchive`)

A QuickPick over `scanArchive`, mirroring `cmdResumeOtherClaude`'s formatting.

- **Default scope = current workspace** (`currentWorkspace()` cwd → `scanArchive(cwd)`),
  with a toggle item ("$(globe) Show sessions from all projects…") that re-runs
  unscoped. This avoids a thousand-item list while still allowing the full archive.
- Each item shows: friendly name or first-user-message, then
  `lines · age · agent badge · sessionId[:8]`, detail = shortened cwd. Cross-agent
  rows are visually tagged via `provider.displayName`/`badge`.
- Each QuickPick item carries a button: `$(eye)` **Preview** → opens Unit 2's viewer
  for that session instead of resuming (so you can look before you leap).
- **On accept**, resume target resolution (in order):
  1. If there's an **active Terminal Sessions terminal**, offer "Resume here" vs
     "New session". (Reuse `findTerminalForSession` / active-terminal resolution.)
  2. Otherwise create a **new persistent session** in the recorded `cwd`
     (mirror `cmdNewPersistent`: `tmux.createDetachedSession` + `openTerminalForSession`),
     then after `SHELL_INIT_DELAY_MS` send `buildResumeCommand(provider, sid, tp, cwd)`.
- The provider handles its own resume syntax + `cd`, so this is agent-agnostic.

### Unit 2 — Conversation Viewer (`terminalSessions.viewConversation`)

Render the transcript to **Markdown** and open VS Code's built-in preview. This
gets theming, search, copy, and collapsible HTML for free — a fraction of a
webview's code, and it sidesteps the es6kr viewer's weaknesses (it drops thinking
blocks and truncates at 800 chars).

`transcriptToMarkdown(path): string` reads the whole file once and emits:

- `# <friendly name | first user message>` + a small metadata line
  (agent, model if known, message count, recorded cwd, mtime).
- Per record, in order:
  - **user** → `### 🧑 You` + the text (verbatim, not truncated).
  - **assistant** text → `### 🤖 <Agent>` + the text rendered as Markdown
    (assistant content already *is* Markdown).
  - **thinking** blocks → `<details><summary>💭 thinking</summary>…</details>`
    (preview renders raw HTML, so these collapse).
  - **tool_use** → `<details><summary>🔧 <ToolName></summary>` + a fenced
    ```json``` block of the input.
  - **tool_result** → collapsed `<details>` with the result text (or `[image]`
    etc. for non-text blocks).
- Large transcripts: cap rendered records at a sane limit (e.g. last N=400 turns)
  with a visible "… N earlier messages elided (open the raw .jsonl for all)" note,
  and an action to open the raw file. (No silent truncation — we state what's elided.)

Wiring:
- Command on **live session items** (sidebar `session` context menu, icon `$(book)`
  to avoid clashing with the existing `preview`/`$(eye)` = tmux scrollback, which
  stays as-is and is a different thing). For a live session we resolve its current
  transcript via the
  tracker/provider; for an archive pick we already have `transcriptPath`.
- Reachable from the Unit 1 QuickPick item button.
- Output goes to `openTextDocument({content, language:'markdown'})` then
  `vscode.commands.executeCommand('markdown.showPreview', doc.uri)`.

Rendering helpers are new (the existing `extractText`/`compactPreview` truncate to
120 chars and are unsuitable for a full document), but they reuse the same block
shapes the Claude reducer already understands.

### Unit 3 — Cleanup (`terminalSessions.cleanupSessions`)

Scan → classify → preview → confirm → soft-delete.

- **Classify** each `ArchivedSession`:
  - **empty** = 0 user/assistant messages. Decision: extend `readTranscriptSummary`
    to also return `userAssistantCount` (one pass, one source of truth) and classify
    on that. A summary-only file has count 0 but `hasSummary` true → survives
    (matches es6kr; we add a `hasSummary` flag to the summary too).
  - **invalid** = first user/assistant text contains `"Invalid API key"` /
    `"API key"` (their predicate).
- **Default scope = current workspace**; a toggle widens to all projects.
  Workspace scope avoids nuking unrelated projects.
- **Preview** modal with counts ("Move 7 empty + 2 invalid sessions to .bak?").
- **Soft-delete**: `fs.rename` each target `<slug>/<id>.jsonl` →
  `~/.claude/projects/.bak/<slug>__<id>.jsonl` (create `.bak/` if missing). A
  0-byte file may be `fs.unlink`-ed. Linked `agent-*.jsonl` subdir, if present, is
  moved alongside.
- **Hard boundary (copied from es6kr):** never read/write `~/.claude/__store.db`,
  Claude's `sessions-index.json`, history, shell-snapshots, or statsig. We only
  move our identified `.jsonl` (+ its subagents dir). Claude's index goes stale but
  uncorrupted; Claude regenerates/ignores as needed.
- Also offer (separately, lower risk) to prune **our** `index.json` of `stopped`
  entries whose tmux + transcript are both gone — but that's a bonus toggle, not the
  default path.

### Unit 4 — Friendly names (sidecar store)

A new top-level map in the index, never touching Claude's files.

```ts
// types.ts → WorkspaceIndex
sessionNames?: Record<string, { name: string; ts: number }>; // key = agent sessionId (UUID, globally unique)
```

```ts
// session-manager.ts → SessionIndex
setSessionName(sessionId: string, name: string | undefined): void;
getSessionName(sessionId: string): string | undefined;
```

- `terminalSessions.nameSession` command: prompt for a name; empty clears it.
  Reachable from the Unit 1 QuickPick (a `$(edit)` button) and from the live
  session context menu.
- Surfaced as the title in Unit 2 and the primary label in Unit 1.
- Stored once, read everywhere. Zero mutation of `~/.claude`.

---

## Data flow

```
scanArchive(registry, names, scopeCwd?)
   └─ for each provider: provider.listSessions(scopeCwd)   [disk, already built]
        └─ readTranscriptSummary(tp)                       [already built]
   └─ attach names.getSessionName(sessionId)
        ↓
   Unit 1 QuickPick  ──accept──▶ resume target ──▶ buildResumeCommand ──▶ term.sendText
        │  └─button $(eye) ─▶ Unit 2
        │  └─button $(edit)─▶ Unit 4 setSessionName ─▶ refresh pick
   Unit 2 transcriptToMarkdown(tp) ─▶ openTextDocument(md) ─▶ markdown.showPreview
   Unit 3 scanArchive ─▶ classify ─▶ confirm ─▶ fs.rename → .bak/
```

## Error handling

- All fs reads already guard with try/catch and return `undefined`/`[]` (see
  `safeReaddir`, `readTranscriptSummary`). Scans degrade to partial results, never throw.
- Resume into a stopped/absent terminal: reuse `cmdResumeOtherClaude`'s "Start
  first?" flow and the "couldn't find terminal" warning.
- Cleanup is transactional per-file (rename is atomic on same fs); a failure on one
  file logs and continues, and the final message reports "moved X, skipped Y
  (errors)". `.bak/` creation failure aborts before any move.
- Viewer on a missing/corrupt transcript: show an info message, fall back to opening
  the raw `.jsonl` (existing behavior).

## Testing

Manual (matching the repo's existing verification style — no unit harness for fs/UX):

- **Unit 1:** run with 0, 1, many archived sessions; scoped vs all; resume a Claude
  and a Codex session; resume into active terminal vs new session; resume a session
  whose recorded cwd differs from the terminal (verify the `cd` prefix).
- **Unit 2:** render a long transcript (thinking + tool_use + tool_result + images);
  confirm collapsibles work in preview, no truncation of user/assistant text, the
  elision note appears past the cap; render a Codex/agy transcript.
- **Unit 3:** seed a fake empty `.jsonl` and an "Invalid API key" one under a test
  slug; confirm only those move to `.bak/`, real conversations untouched, and
  `__store.db`/index are byte-identical before/after (diff). Confirm scope toggle.
- **Unit 4:** name a session, see it in the picker + viewer title, clear it, restart
  the extension host and confirm persistence.
- **Regression:** existing auto-resume, `cmdResumeOtherClaude`, scrollback `preview`,
  and the sidebar are unchanged.

Build gate: `npm run compile` clean (note: `npm run package` does NOT compile), then
`npm run lint`.

## Phasing

Build in dependency order; each phase ships independently:

0. `src/archive.ts` (`scanArchive`) + Unit 4 name store (small, unblocks the rest).
1. Unit 1 — Resume from Archive.
2. Unit 2 — Conversation Viewer (also wired onto live sessions).
3. Unit 3 — Cleanup.

## Risks

- **Unscoped scan cost** on machines with thousands of sessions: mitigated by
  workspace-default scope and the providers' single-pass summary read. If it ever
  bites, add a cap + "showing newest N".
- **Cleanup deleting something wanted**: mitigated by soft-delete to `.bak/`,
  explicit preview/confirm, workspace-default scope, and the hard "never touch
  Claude's DB/index" boundary. A `.bak/` restore is a manual `mv` away.
- **Markdown preview HTML support** varies if the user disabled it; `<details>`
  degrades to visible content, which is acceptable (no data loss, just not collapsed).
