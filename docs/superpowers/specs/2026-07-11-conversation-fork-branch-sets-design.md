# Conversation Fork → Branch Sets — Design

**Goal:** Let a user fork an agent conversation running in a Terminal Sessions
session into a new parallel session/tab that continues an *independent* branch,
and show the resulting sessions as loosely-linked peers ("branch sets") that can
be unlinked back to standalone at any time.

**Status:** Design approved (brainstorm 2026-07-11). Next step: implementation plan.

---

## Background

Terminal Sessions manages tmux-backed terminal sessions, each optionally running
an AI agent (claude/codex/agy/grok), and already:

- records each session's agent conversation head (`agentSessions[0]` = agent + id)
  plus the recorded cwd;
- builds per-agent resume commands via `provider.buildResumeCommand(...)`
  (Claude: `cd <cwd> && claude --resume <id>`);
- creates detached tmux sessions (`tmux.createDetachedSession`) for
  restart/start/restore, allocating a fresh tab id (`nextSafeTabId`);
- renders session rows in a TreeView, already decorating rows through a
  `FileDecorationProvider` (`StoppedSessionDecorationProvider`) keyed on each
  row's `resourceUri`.

Claude's CLI supports `claude --resume <id> --fork-session`, which continues the
conversation under a **new** conversation id. Because the fork gets its own id
from the first message, the two branches are **fully independent on disk** — they
never share a transcript. This is the key simplification: "linking" two forks is
purely a UI/metadata association; "making them individual" only drops that
association and touches nothing real.

## Decisions locked in the brainstorm

1. **Fork point:** from the current head only (matches `--fork-session`). No
   mid-conversation/checkpoint branching (that would require copying+truncating
   the `.jsonl` transcript — out of scope, possible phase 2).
2. **Relationship model:** peers, **not** parent-child. Forks join a shared
   *branch set*; all members are equal siblings.
3. **Display:** each set member carries a shared **⑂ chip** (a colored
   `FileDecoration` badge). Members stay in place (ungrouped, or inside the
   user's manual groups) — the set is not a container.
4. **Unlink:** a command removes a session from its set (becomes standalone);
   when a set drops below 2 members it dissolves automatically.
5. **Agent scope:** Claude-first. `supportsFork` gate; Codex/agy/grok excluded
   until each CLI's fork capability is verified.
6. **Trigger:** the sidebar row right-click **only**, gated per-row to Claude
   sessions (a `forkable` token on the row's `contextValue`). Deliberately **not**
   on the native terminal tab menu: VS Code's `terminal/title/context` `when`
   sees only global / active-terminal context, so it cannot reliably gate on the
   right-clicked tab's agent, whereas a sidebar row's `contextValue` gates
   cleanly. Stop/Restart stay on the tab (they apply to any agent; Fork is
   Claude-specific).
7. **Branch naming:** on fork, show an optional `InputBox` (default `fork N`) so
   siblings with the same origin are distinguishable in the sidebar.

## Out of scope (possible phase 2)

- Checkpoint / mid-conversation branching (`/rewind`+`/branch`-style).
- Fork for non-Claude agents (needs per-CLI fork verification).
- "Jump to sibling" navigation command (MVP surfaces siblings in the tooltip
  only).

---

## Architecture

### 1. Agent provider capability (`src/agents/types.ts`, `claude.ts`, others)

Add to the `AgentProvider` interface:

- `supportsFork: boolean` — whether the agent can fork a conversation into a new
  id. `claude` → `true`; `codex`/`agy`/`grok` → `false`.
- `buildForkCommand(sessionId, terminalCwd, transcriptPath?, extraFlags?): string`
  — same signature shape as `buildResumeCommand`. For Claude it returns the
  resume command with `--fork-session` appended:
  `cd <cwd> && claude --resume <id> --fork-session` (+ surviving launch flags),
  reusing `posixQuote` and the existing `readTranscriptCwd`/`withFlags` helpers.

Providers with `supportsFork: false` may implement `buildForkCommand` as a throw
or simply be never called (guarded upstream).

### 2. Data model (`src/session-manager.ts`)

- **Session meta:** add optional `branchSetId?: string`.
- **Index root:** add `branchSets: { [id: string]: { name: string; colorId: string } }`
  (machine-global, sibling to `groups`).
- **New `SessionIndex` methods** (each begins with the existing
  `reloadIfChanged()` guard and ends with an atomic `save()`, exactly like the
  other mutators, so multi-window writes stay safe):
  - `createBranchSet(name: string): string` — allocates an id, assigns the next
    `colorId` round-robin from the palette, stores `{name, colorId}`, returns id.
  - `addSessionToBranchSet(hash, name, branchSetId)` — sets the session's
    `branchSetId`.
  - `removeSessionFromBranchSet(hash, name)` — clears the session's
    `branchSetId`; if the set now has <2 members, clears the last member too and
    deletes the `branchSets[id]` entry (auto-dissolve).
  - `getBranchSet(id)` / `branchSetMembers(id)` — read helpers for rendering and
    dissolve checks.

Id generation must not use `Date.now()`/`Math.random()` in a way that breaks
determinism concerns elsewhere; reuse whatever id scheme `groups` already uses
(follow the existing `newGroup` id generation in `session-manager.ts`).

### 3. Chip rendering (`src/sidebar/tree-provider.ts`, `items.ts`, `package.json`)

- **New `BranchSetDecorationProvider implements vscode.FileDecorationProvider`**,
  registered alongside the existing `StoppedSessionDecorationProvider`. For a
  session `resourceUri` whose meta has `branchSetId`, return:
  `{ badge: '⑂', color: new vscode.ThemeColor(set.colorId), tooltip: 'Branch: <set name>' }`.
  It holds a reference to the `SessionIndex` to resolve uri → session →
  `branchSetId` → set color. Expose an `onDidChangeFileDecorations` emitter fired
  on fork/unlink.
- **`resourceUri` coverage:** ensure every *live* session row sets a
  `resourceUri` (stopped rows already do at `items.ts:227`). Use a stable scheme
  that encodes `workspaceHash` + session `name` so the decoration provider can
  resolve the session. Reuse/extend the existing uri scheme rather than inventing
  a second one.
- **Theme colors:** contribute `terminalSessions.branchColor1`…`branchColor8` in
  `package.json` `contributes.colors` (defaults chosen to read in both light and
  dark themes), mirroring the existing `terminalSessions.workingIcon`/`idleIcon`
  entries. Sets cycle through these round-robin.
- Coexists with the manual per-session color (that tints the row **icon** via
  `metaIconAndColor`; the chip is a **decoration badge** — different channel).

### 4. Commands & menus (`src/commands.ts`, `src/config.ts`, `package.json`)

- **`terminalSessions.forkConversation`** — handler `cmdForkConversation`.
- **`terminalSessions.unlinkBranch`** — handler `cmdUnlinkBranch`.
- Register both; add both to the `commandPalette` suppression array
  (`"when": "false"`) since they are context-only.
- **`view/item/context`** (sidebar):
  - Fork: shown when the row is a fork-capable session. Gate via a new
    `forkable` token added to the session `contextValue` (set in the tree
    provider when the row's latest agent has `supportsFork`), e.g.
    `viewItem =~ /forkable/`.
  - Unlink: shown when the row has a `branchSetId`. Gate via a new `branched`
    token in `contextValue`, e.g. `viewItem =~ /branched/`.
- **Native tab (`terminal/title/context`): Fork is NOT added here.** VS Code
  cannot gate the tab menu on the right-clicked terminal's agent (see Trigger
  decision), and the requirement is that Fork appear only for Claude — which the
  sidebar `contextValue` gate guarantees. Stop/Restart remain on the tab.

> **Implementation caution — `contextValue` regexes.** The existing session
> inline buttons (`viewConversation`/`restart`/`stop`/`kill`/`lockedHint`) gate on
> anchored patterns such as `viewItem =~ /^session(\.muted)?(\.locked)?$/`. Adding
> `forkable`/`branched` tokens to the session `contextValue` will break those
> anchored matches unless the new tokens are woven into every existing session
> pattern in `package.json`. The plan MUST update all `view/item/context` session
> `when` clauses together (treat the token set as a single ordered scheme, e.g.
> `session[.muted][.forkable][.branched][.locked]`, and update every regex to the
> new order) and verify no existing row action disappears.

### 5. `cmdForkConversation` flow

Invoked from the sidebar row right-click; accepts a `SessionTreeItem`. If invoked
without a session (should not happen given the `forkable` menu gate), inform the
user to right-click a Claude session.

1. Resolve target session; if none → warn and return.
2. `latest = latestAgentSession(index, hash, name)`. If none → warn
   "No agent conversation to fork yet." and return.
3. `provider = registry.get(latest.agent)`; if `!provider.supportsFork` → warn
   "Fork is not supported for <agent> yet." and return.
4. `InputBox` for an optional branch name (default `fork <k>` where `k` is the
   next index within the origin's set, or `fork 2` if the origin has no set yet);
   empty input → use the default.
5. Resolve fork cwd exactly like `cmdRestart` (`meta.folderPath` → live tmux
   `getSessionPath` → workspace root).
6. Allocate a new session: `newTabId = nextSafeTabId(...)`, `newName =
   sessionName(prefix, hash, newTabId)`; `tmux.createDetachedSession(tmuxPath,
   newName, cwd)`.
7. Seed the new session's index entry (label = branch name; carry
   icon/color? no — a fork starts clean) and mark not-stopped.
8. Assign the branch set: if the origin has no `branchSetId`, create one
   (`createBranchSet(originName-derived)`) and add the origin to it; then add the
   new session to the same set.
9. `openTerminalForSession(newName, ...)` and `term.sendText(
   provider.buildForkCommand(latest.id, cwd, transcriptPath, extraFlags))`.
10. Refresh the sidebar and fire the branch-set decoration change so both rows
    get their chip immediately.

### 6. `cmdUnlinkBranch` flow

1. Require a `SessionTreeItem` with a `branchSetId` (from the sidebar
   right-click); otherwise inform the user.
2. `index.removeSessionFromBranchSet(hash, name)` (which auto-dissolves the set
   when <2 remain).
3. Refresh sidebar + fire decoration change so chips update on all affected rows.

Unlinking never touches the tmux session or the transcript — the conversations
were independent from the moment of fork.

---

## Data flow (fork lifecycle)

```
right-click Fork ─▶ resolve session ─▶ guard (agent conversation + supportsFork)
        ─▶ InputBox (branch name) ─▶ createDetachedSession(newTab, cwd)
        ─▶ index: ensure origin in a set, add new session to same set
        ─▶ openTerminal + sendText(buildForkCommand)  [Claude mints a NEW id]
        ─▶ refresh + fire decoration  ─▶ both rows show ⑂ (set color)
```

## Error handling

| Condition | Behavior |
|---|---|
| No target session resolvable | `showWarningMessage`, return (no picker for a destructive-ish op) |
| Session has no agent conversation | Warn "No agent conversation to fork yet." |
| Agent `!supportsFork` | Command hidden on the row via the `forkable` `when` gate — never shown for non-Claude. Not present on the native tab. |
| `tmux.createDetachedSession` / `sendText` failure | `showErrorMessage` (same pattern as `cmdRestart`) |
| Concurrent multi-window writes to `branchSets` | Safe: all set mutators go through `reloadIfChanged()` + atomic `save()` |

## Multi-window safety

`branchSets` lives in the same machine-global `index.json` already hardened in
0.20.17 (read-modify-write with mtime guard + atomic temp+rename + corrupt-file
preservation). Every new set mutator follows that mutator contract, so two Cursor
windows forking/unlinking concurrently cannot clobber each other.

## Testing / verification

The repo has no test framework (only `tsc` via `npm run compile`). Verify by:

1. `npm run compile` — clean.
2. Manual, on a live Claude session:
   - Fork → a new tab appears; both rows show the ⑂ chip in the same color;
     the InputBox name is the new row's label.
   - Independence: send a message in one branch; the other branch's transcript
     (`~/.claude/projects/.../<id>.jsonl`) does not change; the two rows have
     different conversation ids in their tooltip.
   - Fork a second time → third member joins the same set (same chip color).
   - Unlink a member → its chip disappears; when only one remains, that chip
     disappears too (set dissolved).
   - Two Cursor windows: fork in each; both sets persist, neither clobbers the
     other (open `index.json` — both `branchSets` entries present).
   - Non-Claude session: Fork is absent from the sidebar row menu; on the native
     tab it warns instead of acting.

---

## File-by-file change list

| File | Change |
|---|---|
| `src/agents/types.ts` | Add `supportsFork` + `buildForkCommand` to `AgentProvider`. |
| `src/agents/claude.ts` | `supportsFork = true`; implement `buildForkCommand` (resume + `--fork-session`). |
| `src/agents/codex/provider.ts`, `agy/provider.ts`, `grok/provider.ts` | `supportsFork = false` (+ minimal `buildForkCommand` stub/throw). |
| `src/session-manager.ts` | `branchSetId` on meta; `branchSets` map; `createBranchSet`/`addSessionToBranchSet`/`removeSessionFromBranchSet`/`getBranchSet`/`branchSetMembers`. |
| `src/sidebar/tree-provider.ts` | Register `BranchSetDecorationProvider`; fire its change on fork/unlink; add `forkable`/`branched` tokens to session `contextValue`. |
| `src/sidebar/items.ts` | Ensure live rows set a resolvable `resourceUri`; (chip itself comes from the decoration provider). |
| `src/commands.ts` | `cmdForkConversation`, `cmdUnlinkBranch`; register both. |
| `src/config.ts` | `COMMAND.forkConversation`, `COMMAND.unlinkBranch`. |
| `package.json` | Command defs; `view/item/context` entries only (Fork gated on `forkable`, Unlink on `branched`); `commandPalette` suppression; `contributes.colors` `branchColor1..8`. |
| `CHANGELOG.md` | New version entry. |
