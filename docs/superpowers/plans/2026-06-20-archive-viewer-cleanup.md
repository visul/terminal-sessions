# Archive Browser, Conversation Viewer, Cleanup & Friendly Names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three commands to the Terminal Sessions extension — Resume from Archive, View Conversation, and Cleanup — plus a friendly-name store, reusing the existing multi-agent provider/transcript infrastructure.

**Architecture:** A pure scan/classify/render core (`src/archive.ts`, `src/transcript-render.ts`) sits on top of the providers' existing `listSessions()` disk enumeration and `readTranscriptSummary()`. Three new VS Code commands in `src/commands.ts` wire that core to QuickPicks / the Markdown preview / soft-delete. A sidecar `sessionNames` map in `~/.terminal-sessions/index.json` holds user labels; Claude's own files are never mutated.

**Tech Stack:** TypeScript, VS Code Extension API, Node `fs`/`path`/`os`. Build = `tsc -p ./` (`npm run compile` → `out/`). No test framework — pure functions are smoke-checked with `node -e` against `/tmp` fixtures; UX is verified manually in the Extension Development Host (F5).

## Global Constraints

- **VS Code engine:** `^1.85.0` (do not use newer API).
- **No new runtime dependencies.** devDeps are only `@types/node`, `@types/vscode`, `typescript`.
- **Never mutate `~/.claude` content files for naming.** Friendly names live only in `~/.terminal-sessions/index.json`.
- **Cleanup hard boundary:** only move/unlink session `.jsonl` files (+ their `<id>/subagents` dir) into `~/.claude/projects/.bak/`. NEVER read or write `~/.claude/__store.db`, `sessions-index.json`, history, shell-snapshots, or statsig.
- **No silent truncation.** When the viewer caps records, it prints an explicit elision note.
- **No em dashes** in any user-facing string (project copy rule).
- **Build gate:** `npm run compile` must exit 0 before every commit. (`npm run package` does NOT compile.)
- **Pure core stays vscode-free:** `src/archive.ts` and `src/transcript-render.ts` must NOT `import * as vscode` (keeps them `node -e` testable). They import only `fs`/`path`/`os` and type-only symbols.
- **Commit after each task.** Do not bump the extension version or publish until Task 10 (publishing stays user-gated, out of this plan).

---

## File Structure

| File | Responsibility | Create/Modify |
|------|----------------|---------------|
| `src/claude-transcript.ts` | add `userAssistantCount` + `hasSummary` to `TranscriptSummary` | Modify |
| `src/types.ts` | add `sessionNames` map to `WorkspaceIndex` | Modify |
| `src/session-manager.ts` | `setSessionName` / `getSessionName` | Modify |
| `src/archive.ts` | `scanArchive`, `classifyForCleanup`, `softDeleteSession` (pure/fs, no vscode) | Create |
| `src/transcript-render.ts` | `transcriptToMarkdown` (pure/fs, no vscode) | Create |
| `src/config.ts` | 3 new `COMMAND` ids | Modify |
| `src/commands.ts` | `cmdViewConversation`, `cmdNameSession`, `cmdResumeFromArchive`, `cmdCleanupSessions` + registrations | Modify |
| `package.json` | command + menu contributions | Modify |
| `CHANGELOG.md` / `package.json` version | release notes + bump | Modify (Task 10) |

---

### Task 1: Extend `TranscriptSummary` with message-count fields

**Files:**
- Modify: `src/claude-transcript.ts:145-201` (the `TranscriptSummary` interface + `readTranscriptSummary`)
- Test (fixture): `/tmp/ts-fixtures/` (throwaway)

**Interfaces:**
- Produces: `TranscriptSummary` gains `userAssistantCount: number` and `hasSummary: boolean`. Used by Task 4 (`classifyForCleanup`).

- [ ] **Step 1: Write the fixture + check script**

Create `/tmp/ts-fixtures/make.sh` and run it:

```bash
mkdir -p /tmp/ts-fixtures
# A real-ish transcript: 1 user, 1 assistant, plus a summary line.
cat > /tmp/ts-fixtures/full.jsonl <<'EOF'
{"type":"summary","summary":"Some old summary"}
{"type":"user","cwd":"/Users/x/proj","message":{"role":"user","content":"hello there"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
EOF
# An empty (summary-only) transcript.
cat > /tmp/ts-fixtures/summary-only.jsonl <<'EOF'
{"type":"summary","summary":"orphan"}
EOF
# A truly empty file.
: > /tmp/ts-fixtures/empty.jsonl
```

- [ ] **Step 2: Write the failing check**

Create `/tmp/ts-fixtures/check1.js`:

```js
const assert = require('assert');
const { readTranscriptSummary } = require(process.argv[2]); // path to out/claude-transcript.js
const full = readTranscriptSummary('/tmp/ts-fixtures/full.jsonl');
assert.strictEqual(full.userAssistantCount, 2, 'full uac');
assert.strictEqual(full.hasSummary, true, 'full hasSummary');
const so = readTranscriptSummary('/tmp/ts-fixtures/summary-only.jsonl');
assert.strictEqual(so.userAssistantCount, 0, 'summary-only uac');
assert.strictEqual(so.hasSummary, true, 'summary-only hasSummary');
const e = readTranscriptSummary('/tmp/ts-fixtures/empty.jsonl');
assert.strictEqual(e.userAssistantCount, 0, 'empty uac');
assert.strictEqual(e.hasSummary, false, 'empty hasSummary');
console.log('OK task1');
```

- [ ] **Step 3: Run it to confirm it fails (fields absent)**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check1.js ./out/claude-transcript.js
```
Expected: `AssertionError: full uac` (the new fields are `undefined`).

- [ ] **Step 4: Implement**

In `src/claude-transcript.ts`, extend the interface:

```ts
export interface TranscriptSummary {
  cwd?: string;
  firstUserMessage?: string;
  lineCount: number;
  byteSize: number;
  mtimeMs: number;
  /** Count of user+assistant records (cleanup "empty" = 0). */
  userAssistantCount: number;
  /** True if any `summary` record is present (a summary-only file survives cleanup). */
  hasSummary: boolean;
}
```

Inside `readTranscriptSummary`, add two counters alongside the existing loop. Add the declarations before the `while`:

```ts
    let userAssistantCount = 0;
    let hasSummary = false;
```

Inside the `if (line.length > 0) {` block, after `lineCount++;`, add a cheap typed tally that does NOT depend on the `lineCount <= 200` gate (so long transcripts still count correctly). Replace the existing parse block guard so we always read the `type` even past line 200, but keep the expensive cwd/first-user extraction gated:

```ts
      if (line.length > 0) {
        lineCount++;
        if (line[0] === '{') {
          // Cheap type sniff on every line (no full parse needed for the tally).
          if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
            userAssistantCount++;
          } else if (line.includes('"type":"summary"')) {
            hasSummary = true;
          }
          if (lineCount <= 200 && (!cwd || !firstUser)) {
            try {
              const obj = JSON.parse(line);
              if (!cwd && typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) {
                cwd = obj.cwd;
              }
              if (!firstUser && obj.type === 'user') {
                const c = obj.message?.content;
                if (typeof c === 'string') firstUser = c;
                else if (Array.isArray(c)) {
                  for (const p of c) {
                    if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
                      firstUser = p.text; break;
                    }
                  }
                }
              }
            } catch { /* malformed line */ }
          }
        }
      }
```

Then add the two fields to the returned object:

```ts
    return {
      cwd,
      firstUserMessage: firstUser?.slice(0, 200),
      lineCount,
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
      userAssistantCount,
      hasSummary,
    };
```

> Note: the substring sniff (`line.includes('"type":"user"')`) matches Claude's compact JSON (no spaces after colons), which is how the CLI writes transcripts. The gated `JSON.parse` path is unchanged for cwd/first-user.

- [ ] **Step 5: Run the check to confirm it passes**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check1.js ./out/claude-transcript.js
```
Expected: `OK task1`

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/claude-transcript.ts
git commit -m "feat(transcript): add userAssistantCount + hasSummary to summary"
```

---

### Task 2: Friendly-name sidecar store

**Files:**
- Modify: `src/types.ts:30-33` (`WorkspaceIndex`)
- Modify: `src/session-manager.ts` (add two methods on `SessionIndex`)

**Interfaces:**
- Produces:
  - `WorkspaceIndex.sessionNames?: Record<string, { name: string; ts: number }>` (key = agent sessionId UUID, globally unique).
  - `SessionIndex.setSessionName(sessionId: string, name: string | undefined): void`
  - `SessionIndex.getSessionName(sessionId: string): string | undefined`
- Consumed by Task 7 (`cmdNameSession`) and Task 8 (resume picker label).

- [ ] **Step 1: Write the failing check (HOME-isolated)**

Create `/tmp/ts-fixtures/check2.js`:

```js
const assert = require('assert');
const { SessionIndex } = require(process.argv[2]); // out/session-manager.js
const idx = new SessionIndex();
idx.setSessionName('abc-123', 'My Session');
assert.strictEqual(idx.getSessionName('abc-123'), 'My Session', 'set/get');
const idx2 = new SessionIndex(); // reloads from the same temp HOME index.json
assert.strictEqual(idx2.getSessionName('abc-123'), 'My Session', 'persisted');
idx2.setSessionName('abc-123', undefined);
assert.strictEqual(idx2.getSessionName('abc-123'), undefined, 'cleared');
console.log('OK task2');
```

- [ ] **Step 2: Run it to confirm it fails**

Run (isolated HOME so we never touch the real index):
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && HOME=$(mktemp -d) node /tmp/ts-fixtures/check2.js ./out/session-manager.js
```
Expected: `TypeError: idx.setSessionName is not a function`.

- [ ] **Step 3: Implement the type**

In `src/types.ts`, add to `WorkspaceIndex`:

```ts
export interface WorkspaceIndex {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
  // Friendly names for agent sessions (any agent), keyed by sessionId. Sidecar
  // only — Claude's own transcript files are never modified for naming.
  sessionNames?: Record<string, { name: string; ts: number }>;
}
```

- [ ] **Step 4: Implement the methods**

In `src/session-manager.ts`, add inside the `SessionIndex` class (e.g. right after `getSessionMeta`):

```ts
  /** Set (or clear, when name is empty/undefined) a friendly label for an agent
   *  session id. Stored in the sidecar `sessionNames` map; never touches
   *  ~/.claude. */
  setSessionName(sessionId: string, name: string | undefined): void {
    if (!sessionId) return;
    if (!this.data.sessionNames) this.data.sessionNames = {};
    const trimmed = name?.trim();
    if (trimmed) this.data.sessionNames[sessionId] = { name: trimmed, ts: Date.now() };
    else delete this.data.sessionNames[sessionId];
    this.save();
  }

  getSessionName(sessionId: string): string | undefined {
    return this.data.sessionNames?.[sessionId]?.name;
  }
```

- [ ] **Step 5: Run the check to confirm it passes**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && HOME=$(mktemp -d) node /tmp/ts-fixtures/check2.js ./out/session-manager.js
```
Expected: `OK task2`

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/types.ts src/session-manager.ts
git commit -m "feat(index): sidecar friendly-name store for agent sessions"
```

---

### Task 3: `src/archive.ts` — scan core

**Files:**
- Create: `src/archive.ts`
- Test: `/tmp/ts-fixtures/check3.js`

**Interfaces:**
- Consumes: `AgentProvider.listSessions` + `AgentSessionSummary` from `./agents/types` (type-only).
- Produces:
  - `interface ArchivedSession extends AgentSessionSummary { friendlyName?: string }`
  - `scanArchive(providers: Pick<AgentProvider, 'listSessions'>[], nameLookup: (sessionId: string) => string | undefined, scopeCwd?: string): ArchivedSession[]`
- Consumed by Task 8 (resume) and Task 9 (cleanup).

- [ ] **Step 1: Write the failing check (fake providers, no vscode)**

Create `/tmp/ts-fixtures/check3.js`:

```js
const assert = require('assert');
const { scanArchive } = require(process.argv[2]); // out/archive.js
const pA = { listSessions: () => [
  { agent: 'claude', sessionId: 's1', mtimeMs: 100, firstUserMessage: 'older' },
  { agent: 'claude', sessionId: 's2', mtimeMs: 300, firstUserMessage: 'newest' },
]};
const pB = { listSessions: () => [
  { agent: 'codex', sessionId: 's3', mtimeMs: 200, firstUserMessage: 'middle' },
]};
const names = { s2: 'My Fav' };
const out = scanArchive([pA, pB], (id) => names[id]);
assert.deepStrictEqual(out.map(s => s.sessionId), ['s2', 's3', 's1'], 'mtime desc merge');
assert.strictEqual(out[0].friendlyName, 'My Fav', 'name attached');
assert.strictEqual(out[1].friendlyName, undefined, 'no name');
console.log('OK task3');
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check3.js ./out/archive.js
```
Expected: `Cannot find module './out/archive.js'`.

- [ ] **Step 3: Implement**

Create `src/archive.ts`:

```ts
import type { AgentProvider, AgentSessionSummary } from './agents/types';

/** A past session found on disk, plus its sidecar friendly name if any. */
export interface ArchivedSession extends AgentSessionSummary {
  friendlyName?: string;
}

/**
 * Merge every provider's on-disk session list into one mtime-desc list and
 * attach friendly names. Pure: providers and the name lookup are injected, so
 * this stays vscode-free and node-testable. `scopeCwd` is forwarded to each
 * provider's listSessions (undefined = all projects, a cwd = that slug only).
 */
export function scanArchive(
  providers: Pick<AgentProvider, 'listSessions'>[],
  nameLookup: (sessionId: string) => string | undefined,
  scopeCwd?: string,
): ArchivedSession[] {
  const merged: ArchivedSession[] = [];
  for (const p of providers) {
    let list: AgentSessionSummary[] = [];
    try { list = p.listSessions(scopeCwd); } catch { list = []; }
    for (const s of list) {
      merged.push({ ...s, friendlyName: nameLookup(s.sessionId) });
    }
  }
  merged.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return merged;
}
```

- [ ] **Step 4: Run the check to confirm it passes**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check3.js ./out/archive.js
```
Expected: `OK task3`

- [ ] **Step 5: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/archive.ts
git commit -m "feat(archive): cross-agent scanArchive merge"
```

---

### Task 4: Cleanup classify + soft-delete (in `src/archive.ts`)

**Files:**
- Modify: `src/archive.ts`
- Test: `/tmp/ts-fixtures/check4.js`

**Interfaces:**
- Consumes: `TranscriptSummary` from `./claude-transcript` (type-only); `readTranscriptSummary` (value).
- Produces:
  - `classifyForCleanup(summary: TranscriptSummary | undefined): 'empty' | 'invalid' | 'keep'`
  - `softDeleteSession(transcriptPath: string): { ok: boolean; dest?: string; error?: string }`
- Consumed by Task 9 (`cmdCleanupSessions`).

- [ ] **Step 1: Write the failing check**

Create `/tmp/ts-fixtures/check4.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyForCleanup, softDeleteSession } = require(process.argv[2]); // out/archive.js

// classify
assert.strictEqual(classifyForCleanup({ userAssistantCount: 0, hasSummary: false }), 'empty');
assert.strictEqual(classifyForCleanup({ userAssistantCount: 0, hasSummary: true }), 'keep');
assert.strictEqual(classifyForCleanup({ userAssistantCount: 2, hasSummary: false }), 'keep');
assert.strictEqual(classifyForCleanup({ userAssistantCount: 3, firstUserMessage: 'Invalid API key · Please run /login' }), 'invalid');
assert.strictEqual(classifyForCleanup(undefined), 'keep'); // unreadable → leave alone
console.log('classify OK');

// softDelete: build a fake ~/.claude/projects/<slug>/<id>.jsonl under temp HOME
const home = process.env.HOME;
const slugDir = path.join(home, '.claude', 'projects', '-Users-x-proj');
fs.mkdirSync(slugDir, { recursive: true });
const tp = path.join(slugDir, 'dead-session.jsonl');
fs.writeFileSync(tp, '{"type":"summary"}\n');
const r = softDeleteSession(tp);
assert.strictEqual(r.ok, true, 'softDelete ok');
assert.strictEqual(fs.existsSync(tp), false, 'original gone');
assert.ok(fs.existsSync(r.dest), 'moved to .bak: ' + r.dest);
assert.ok(r.dest.includes(path.join('.claude', 'projects', '.bak')), 'in .bak');
console.log('OK task4');
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && HOME=$(mktemp -d) node /tmp/ts-fixtures/check4.js ./out/archive.js
```
Expected: `TypeError: classifyForCleanup is not a function`.

- [ ] **Step 3: Implement**

Append to `src/archive.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TranscriptSummary } from './claude-transcript';

/**
 * Decide a cleanup verdict for one session.
 *   - empty   = 0 user/assistant records and no summary line.
 *   - invalid = first user message is an "Invalid API key" stub.
 *   - keep    = everything else (and any unreadable summary — never delete
 *               something we couldn't classify).
 */
export function classifyForCleanup(
  summary: TranscriptSummary | undefined,
): 'empty' | 'invalid' | 'keep' {
  if (!summary) return 'keep';
  const first = summary.firstUserMessage || '';
  if (/Invalid API key|Please run \/login/i.test(first)) return 'invalid';
  if (summary.userAssistantCount === 0 && !summary.hasSummary) return 'empty';
  return 'keep';
}

/**
 * Soft-delete a session transcript by moving it into
 * `~/.claude/projects/.bak/<slug>__<id>.jsonl`. Also moves the session's
 * `<id>/subagents` sibling dir if present. A 0-byte file is unlinked outright.
 *
 * HARD BOUNDARY: only the `.jsonl` (+ its subagents dir) is touched. We never
 * read or write __store.db, sessions-index.json, history, or any other Claude
 * state — so Claude's index goes stale but is never corrupted.
 */
export function softDeleteSession(
  transcriptPath: string,
): { ok: boolean; dest?: string; error?: string } {
  try {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const slug = path.basename(path.dirname(transcriptPath));
    const id = path.basename(transcriptPath, '.jsonl');

    let stat: fs.Stats;
    try { stat = fs.statSync(transcriptPath); }
    catch { return { ok: false, error: 'not found' }; }

    if (stat.size === 0) {
      fs.unlinkSync(transcriptPath);
      // Best-effort: drop an empty subagents dir too.
      try { fs.rmSync(path.join(path.dirname(transcriptPath), id, 'subagents'), { recursive: true, force: true }); } catch { /* none */ }
      return { ok: true, dest: '(unlinked empty file)' };
    }

    const bakDir = path.join(projectsRoot, '.bak');
    try { fs.mkdirSync(bakDir, { recursive: true }); }
    catch (e) { return { ok: false, error: `mkdir .bak failed: ${String(e)}` }; }

    const dest = path.join(bakDir, `${slug}__${id}.jsonl`);
    fs.renameSync(transcriptPath, dest);

    // Move the background-agent transcripts dir if it exists.
    const subDir = path.join(path.dirname(transcriptPath), id, 'subagents');
    if (fs.existsSync(subDir)) {
      try { fs.renameSync(subDir, path.join(bakDir, `${slug}__${id}__subagents`)); } catch { /* best effort */ }
    }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
```

> The existing `import type { AgentProvider, AgentSessionSummary }` at the top of the file stays. Add the new `fs`/`path`/`os`/`TranscriptSummary` imports at the top (move them up next to the existing import line; do not leave imports mid-file even though TS allows it).

- [ ] **Step 4: Run the check to confirm it passes**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && HOME=$(mktemp -d) node /tmp/ts-fixtures/check4.js ./out/archive.js
```
Expected: `classify OK` then `OK task4`

- [ ] **Step 5: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/archive.ts
git commit -m "feat(archive): classifyForCleanup + softDeleteSession"
```

---

### Task 5: `src/transcript-render.ts` — Markdown renderer

**Files:**
- Create: `src/transcript-render.ts`
- Test: `/tmp/ts-fixtures/check5.js`

**Interfaces:**
- Produces: `transcriptToMarkdown(transcriptPath: string, opts?: { title?: string; maxRecords?: number }): string`
- Consumed by Task 6 (`cmdViewConversation`).

- [ ] **Step 1: Write the failing check**

Create `/tmp/ts-fixtures/render.jsonl` and `/tmp/ts-fixtures/check5.js`:

```bash
cat > /tmp/ts-fixtures/render.jsonl <<'EOF'
{"type":"user","cwd":"/Users/x/proj","message":{"role":"user","content":"Fix the **bug**"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"Done, see below"},{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b.ts"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"text","text":"ok applied"}]}]}}
EOF
```

```js
const assert = require('assert');
const { transcriptToMarkdown } = require(process.argv[2]); // out/transcript-render.js
const md = transcriptToMarkdown('/tmp/ts-fixtures/render.jsonl', { title: 'My Title' });
assert.ok(md.startsWith('# My Title'), 'title heading');
assert.ok(md.includes('### 🧑 You'), 'user heading');
assert.ok(md.includes('Fix the **bug**'), 'user text verbatim');
assert.ok(md.includes('### 🤖'), 'assistant heading');
assert.ok(md.includes('<details><summary>💭 thinking'), 'thinking collapsible');
assert.ok(md.includes('<details><summary>🔧 Edit'), 'tool_use collapsible');
assert.ok(md.includes('ok applied'), 'tool_result text');
assert.ok(!md.includes('—'), 'no em dashes');
console.log('OK task5');
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check5.js ./out/transcript-render.js
```
Expected: `Cannot find module './out/transcript-render.js'`.

- [ ] **Step 3: Implement**

Create `src/transcript-render.ts`:

```ts
import * as fs from 'fs';

interface Block { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string }

/**
 * Render a Claude/Codex/agy transcript .jsonl into a readable Markdown document
 * for VS Code's built-in preview. User/assistant text is verbatim (assistant
 * content already IS Markdown); thinking + tool_use + tool_result are wrapped in
 * collapsible <details> (the preview renders raw HTML). No content is truncated;
 * only the number of records is capped, and the cap is stated explicitly.
 */
export function transcriptToMarkdown(
  transcriptPath: string,
  opts?: { title?: string; maxRecords?: number },
): string {
  const maxRecords = opts?.maxRecords ?? 400;
  let raw = '';
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); }
  catch { return `# Conversation\n\n_Transcript not readable: ${transcriptPath}_\n`; }

  const lines = raw.split('\n').filter(l => l.length > 0 && l[0] === '{');
  const records: Array<Record<string, unknown>> = [];
  for (const l of lines) { try { records.push(JSON.parse(l)); } catch { /* skip */ } }

  // Keep the most recent maxRecords; note how many were elided.
  const elided = Math.max(0, records.length - maxRecords);
  const shown = elided > 0 ? records.slice(elided) : records;

  let model: string | undefined;
  let cwd: string | undefined;
  let count = 0;
  const parts: string[] = [];

  for (const rec of shown) {
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = rec.message as { role?: string; content?: unknown; model?: string } | undefined;
    if (!msg) continue;
    if (typeof msg.model === 'string') model = msg.model;
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    count++;

    if (type === 'user') {
      const { text, toolResults } = splitUser(msg.content);
      if (text) parts.push(`### 🧑 You\n\n${text}\n`);
      for (const tr of toolResults) {
        parts.push(`<details><summary>📎 tool result</summary>\n\n${fence(tr)}\n</details>\n`);
      }
    } else {
      parts.push(`### 🤖 Assistant\n`);
      renderAssistant(msg.content, parts);
    }
  }

  const head: string[] = [];
  head.push(`# ${opts?.title || 'Conversation'}`);
  const meta = [model && `model \`${model}\``, cwd && `cwd \`${cwd}\``, `${count} messages`]
    .filter(Boolean).join(' · ');
  if (meta) head.push(`\n_${meta}_\n`);
  if (elided > 0) head.push(`\n> ${elided} earlier messages elided. Open the raw .jsonl for the full history.\n`);

  return head.join('\n') + '\n' + parts.join('\n');
}

function renderAssistant(content: unknown, parts: string[]): void {
  if (typeof content === 'string') { parts.push(content + '\n'); return; }
  if (!Array.isArray(content)) return;
  for (const b of content as Block[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text + '\n');
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      parts.push(`<details><summary>💭 thinking</summary>\n\n${blockquote(b.thinking)}\n</details>\n`);
    } else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      parts.push(`<details><summary>🔧 ${name}</summary>\n\n${fence(JSON.stringify(b.input ?? {}, null, 2), 'json')}\n</details>\n`);
    }
  }
}

function splitUser(content: unknown): { text: string; toolResults: string[] } {
  if (typeof content === 'string') return { text: content, toolResults: [] };
  const out = { text: '', toolResults: [] as string[] };
  if (!Array.isArray(content)) return out;
  const texts: string[] = [];
  for (const b of content as Block[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'tool_result') out.toolResults.push(extractResult(b.content));
  }
  out.text = texts.join('\n');
  return out;
}

function extractResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[tool result]';
  const texts: string[] = [];
  for (const b of content as Block[]) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b && typeof b === 'object' && b.type === 'image') texts.push('[image]');
  }
  return texts.join('\n') || '[tool result]';
}

function fence(s: string, lang = ''): string { return '```' + lang + '\n' + s + '\n```'; }
function blockquote(s: string): string { return s.split('\n').map(l => '> ' + l).join('\n'); }
```

> Em-dash rule: this file emits no `—`. The `·` separators above are middle dots (U+00B7), not em dashes — keep them.

- [ ] **Step 4: Run the check to confirm it passes**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile && node /tmp/ts-fixtures/check5.js ./out/transcript-render.js
```
Expected: `OK task5`

- [ ] **Step 5: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/transcript-render.ts
git commit -m "feat(viewer): transcriptToMarkdown renderer"
```

---

### Task 6: `cmdViewConversation` command + live-session wiring

**Files:**
- Modify: `src/config.ts` (COMMAND ids)
- Modify: `src/commands.ts` (handler + registration; imports)
- Modify: `package.json` (command + menu + palette)

**Interfaces:**
- Consumes: `transcriptToMarkdown` (Task 5); `resumeContextFor` (`commands.ts:102`); `getSessionName` (Task 2).
- Produces: command `terminalSessions.viewConversation`, handler `cmdViewConversation(index, registry, claudeTracker, arg?)` accepting a `SessionTreeItem` OR `{ transcriptPath: string; title?: string }`. Consumed by Task 8 (picker eye button).

- [ ] **Step 1: Add the COMMAND id**

In `src/config.ts`, inside `export const COMMAND = { … }`, add:

```ts
  viewConversation: 'terminalSessions.viewConversation',
```

- [ ] **Step 2: Add imports + handler in `commands.ts`**

At the top of `src/commands.ts`, extend the existing claude-transcript import and add the render import:

```ts
import { transcriptPathFor, findTranscriptBySessionId, readTranscriptCwd, readTranscriptSummary } from './claude-transcript';
import { transcriptToMarkdown } from './transcript-render';
```

Add the handler (near `cmdOpenSubagentTranscript`, ~line 300):

```ts
/**
 * Open a readable Markdown rendering of a conversation in VS Code's preview.
 * Two entry shapes:
 *   - a SessionTreeItem (live session right-click) → resolve its current agent's
 *     newest transcript via the resume context;
 *   - { transcriptPath, title } (from the archive picker's eye button).
 */
async function cmdViewConversation(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  arg?: SessionTreeItem | { transcriptPath: string; title?: string },
): Promise<void> {
  let transcriptPath: string | undefined;
  let title: string | undefined;

  if (arg && 'transcriptPath' in arg) {
    transcriptPath = arg.transcriptPath;
    title = arg.title;
  } else if (arg && 'session' in arg) {
    const session = arg.session;
    const { provider, history } =
      resumeContextFor(index, registry, claudeTracker, session.workspaceHash, session.name);
    const cwd = index.getSessionMeta(session.workspaceHash, session.name)?.folderPath
      || session.workspacePath || '';
    const sid = history[0];
    if (sid) {
      transcriptPath = provider.resolveTranscriptPath(sid, cwd, undefined);
      title = index.getSessionName(sid) || session.label || session.name;
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    vscode.window.showInformationMessage('No conversation transcript found for this session yet.');
    return;
  }

  try {
    const md = transcriptToMarkdown(transcriptPath, { title });
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  } catch (e) {
    // Fall back to the raw file so the user still sees something.
    vscode.window.showWarningMessage(`Render failed (${String(e).slice(0, 120)}); opening raw transcript.`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(transcriptPath));
    await vscode.window.showTextDocument(doc);
  }
}
```

- [ ] **Step 3: Register the command**

In `registerCommands`, add to the `ctx.subscriptions.push(...)` list:

```ts
    vscode.commands.registerCommand(COMMAND.viewConversation, (arg?: SessionTreeItem | { transcriptPath: string; title?: string }) => cmdViewConversation(index, registry, claudeTracker, arg)),
```

- [ ] **Step 4: Contribute the command + menu in `package.json`**

In `contributes.commands` (array), add:

```json
{
  "command": "terminalSessions.viewConversation",
  "title": "View Conversation",
  "icon": "$(book)"
}
```

In `contributes.menus` → `view/item/context`, add (mirrors the `resumeOtherClaude` `when`):

```json
{
  "command": "terminalSessions.viewConversation",
  "when": "view == terminalSessions.sessions && viewItem =~ /^session/",
  "group": "open@4"
}
```

If there is a `commandPalette` block in `contributes.menus`, leave `viewConversation` palette-visible (default). If `commandPalette` explicitly hides item-only commands, do nothing — the context menu is the primary entry.

- [ ] **Step 5: Compile + manual verify**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile
```
Expected: exit 0, no TS errors.

Then press F5 (Extension Development Host). In the host:
1. Start a Claude session in a tracked tmux pane, send one prompt so a transcript exists.
2. Right-click the session in the Terminal Sessions sidebar → **View Conversation**.
3. Expected: a Markdown preview opens titled with the session label; your prompt appears under `### 🧑 You`; assistant reply rendered as Markdown; any thinking/tool blocks are collapsible.

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/config.ts src/commands.ts package.json
git commit -m "feat(viewer): View Conversation command (markdown preview)"
```

---

### Task 7: `cmdNameSession` command

**Files:**
- Modify: `src/config.ts` (COMMAND id)
- Modify: `src/commands.ts` (handler + registration)
- Modify: `package.json` (command + menu)

**Interfaces:**
- Consumes: `setSessionName`/`getSessionName` (Task 2); `resumeContextFor` for the live-session sessionId.
- Produces: command `terminalSessions.nameSession`, handler `cmdNameSession(index, registry, claudeTracker, arg?)` accepting a `SessionTreeItem` OR `{ sessionId: string; current?: string }`. Returns the new name (or undefined) so callers can refresh. Consumed by Task 8 (picker edit button).

- [ ] **Step 1: Add the COMMAND id**

In `src/config.ts` `COMMAND`, add:

```ts
  nameSession: 'terminalSessions.nameSession',
```

- [ ] **Step 2: Add the handler in `commands.ts`**

```ts
/**
 * Prompt for a friendly name for an agent session and store it in the sidecar
 * names map. Empty input clears the name. Accepts a SessionTreeItem (resolve the
 * live session's current sessionId) or an explicit { sessionId, current }.
 * Returns the saved name (undefined when cleared/cancelled).
 */
async function cmdNameSession(
  index: SessionIndex,
  registry: AgentRegistry,
  claudeTracker: ClaudeTracker,
  arg?: SessionTreeItem | { sessionId: string; current?: string },
): Promise<string | undefined> {
  let sessionId: string | undefined;
  let current: string | undefined;

  if (arg && 'sessionId' in arg) {
    sessionId = arg.sessionId;
    current = arg.current ?? index.getSessionName(sessionId);
  } else if (arg && 'session' in arg) {
    const session = arg.session;
    const { history } =
      resumeContextFor(index, registry, claudeTracker, session.workspaceHash, session.name);
    sessionId = history[0];
    current = sessionId ? index.getSessionName(sessionId) : undefined;
  }

  if (!sessionId) {
    vscode.window.showInformationMessage('No agent session id to name yet (run the agent once first).');
    return undefined;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Friendly name for this conversation (empty to clear)',
    value: current ?? '',
  });
  if (input === undefined) return current; // cancelled
  const name = input.trim() || undefined;
  index.setSessionName(sessionId, name);
  refreshSidebar();
  return name;
}
```

- [ ] **Step 3: Register the command**

In `registerCommands`, add:

```ts
    vscode.commands.registerCommand(COMMAND.nameSession, (arg?: SessionTreeItem | { sessionId: string; current?: string }) => cmdNameSession(index, registry, claudeTracker, arg)),
```

- [ ] **Step 4: Contribute in `package.json`**

`contributes.commands`:

```json
{
  "command": "terminalSessions.nameSession",
  "title": "Name Conversation...",
  "icon": "$(edit)"
}
```

`contributes.menus` → `view/item/context`:

```json
{
  "command": "terminalSessions.nameSession",
  "when": "view == terminalSessions.sessions && viewItem =~ /^session/",
  "group": "open@5"
}
```

- [ ] **Step 5: Compile + manual verify**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile
```
Expected: exit 0.

F5 host: right-click a session that has run an agent → **Name Conversation...** → type "Test Name" → OK. (Visible surfacing is verified in Task 8's picker; for now just confirm no error and that running it again pre-fills "Test Name".)

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/config.ts src/commands.ts package.json
git commit -m "feat(names): Name Conversation command (sidecar store)"
```

---

### Task 8: `cmdResumeFromArchive` picker

**Files:**
- Modify: `src/config.ts` (COMMAND id)
- Modify: `src/commands.ts` (handler + registration; imports)
- Modify: `package.json` (command + view/title + palette)

**Interfaces:**
- Consumes: `scanArchive` (Task 3); `registry.enabled()`, `registry.getProvider()`; `buildResumeCommand` (`commands.ts:35`); `getConfig`, `currentWorkspace`, `hashPath`, `buildSessionName`, `tmux.buildAttachOrCreateArgs`, `requireTmux`, `findTerminalForSession`, `SHELL_INIT_DELAY_MS`, `sleep`, `metaIconAndColor`; commands `COMMAND.viewConversation` (Task 6) and `COMMAND.nameSession` (Task 7) via `executeCommand`.
- Produces: command `terminalSessions.resumeFromArchive`.

- [ ] **Step 1: Add the COMMAND id**

In `src/config.ts` `COMMAND`, add:

```ts
  resumeFromArchive: 'terminalSessions.resumeFromArchive',
```

- [ ] **Step 2: Add imports + handler in `commands.ts`**

Add the archive import at the top:

```ts
import { scanArchive, ArchivedSession } from './archive';
```

Add the handler. It uses `createQuickPick` (not `showQuickPick`) so each item can carry an eye (preview) and edit (name) button:

```ts
/**
 * Resume ANY past session from disk (cross-agent), even when nothing is live in
 * tmux for it. Scans every enabled provider's on-disk sessions (default: the
 * current workspace's cwd; a toggle widens to all projects). Each row has an eye
 * button (View Conversation) and an edit button (Name Conversation). Accepting a
 * row resumes it into the active Terminal Sessions terminal (if any) or a new
 * persistent session.
 */
async function cmdResumeFromArchive(
  index: SessionIndex,
  registry: AgentRegistry,
): Promise<void> {
  const ws = currentWorkspace();
  let scopeCwd: string | undefined = ws?.path;

  const eyeBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('book'), tooltip: 'View Conversation' };
  const editBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Name Conversation' };

  interface Pick extends vscode.QuickPickItem { sess?: ArchivedSession; toggle?: boolean }

  const build = (): Pick[] => {
    const sessions = scanArchive(registry.enabled(), (id) => index.getSessionName(id), scopeCwd);
    const rows: Pick[] = sessions.slice(0, 500).map(s => {
      const provider = registry.getProvider(s.agent);
      const badge = provider?.displayName || s.agent;
      const primary = s.friendlyName || (s.firstUserMessage?.replace(/\s+/g, ' ').slice(0, 80)) || '(no user message)';
      const lines = (s.lineCount ?? 0).toLocaleString();
      const ageMs = Date.now() - (s.mtimeMs ?? Date.now());
      const ageMin = Math.round(ageMs / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 24 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 60 / 24)}d`;
      const cwdShort = s.cwd ? s.cwd.replace(/^\/Users\/[^/]+\//, '~/') : '?';
      return {
        sess: s,
        label: `$(comment-discussion) ${primary}`,
        description: `${badge} · ${lines} lines · ${ageStr} ago · ${s.sessionId.slice(0, 8)}`,
        detail: cwdShort,
        buttons: [eyeBtn, editBtn],
      };
    });
    const toggle: Pick = {
      toggle: true,
      label: scopeCwd ? '$(globe) Show sessions from all projects...' : '$(home) Show only this workspace',
      alwaysShow: true,
    };
    return [toggle, ...rows];
  };

  const qp = vscode.window.createQuickPick<Pick>();
  qp.matchOnDetail = true;
  qp.placeholder = scopeCwd ? `Resume a past session (this workspace) — ${ws?.label ?? ''}` : 'Resume a past session (all projects)';
  qp.items = build();

  qp.onDidTriggerItemButton(async (e) => {
    const s = e.item.sess;
    if (!s || !s.transcriptPath) return;
    if (e.button === eyeBtn) {
      await vscode.commands.executeCommand(COMMAND.viewConversation, { transcriptPath: s.transcriptPath, title: s.friendlyName || s.firstUserMessage });
    } else if (e.button === editBtn) {
      const name = await vscode.commands.executeCommand<string | undefined>(COMMAND.nameSession, { sessionId: s.sessionId, current: s.friendlyName });
      if (name !== undefined) qp.items = build(); // refresh labels
    }
  });

  const chosen = await new Promise<Pick | undefined>((resolve) => {
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });

  if (chosen?.toggle) {
    scopeCwd = scopeCwd ? undefined : ws?.path;
    // Re-open with the flipped scope.
    qp.dispose();
    return cmdResumeFromArchive(index, registry); // simple re-entry; scope read fresh below
  }
  qp.hide();
  qp.dispose();
  if (!chosen?.sess?.transcriptPath) return;

  const s = chosen.sess;
  const provider = registry.getProvider(s.agent);
  if (!provider) return;

  // Resume target: reuse the active TS terminal if the user has one, else make a
  // new persistent session. The provider's buildResumeCommand handles cd-to-cwd.
  const active = vscode.window.activeTerminal;
  const activeName = active ? resolveTmuxNameForTerminalLive(active) : undefined;
  let useActive = false;
  if (activeName) {
    const choice = await vscode.window.showQuickPick(['Resume in active session', 'New session'], {
      placeHolder: 'Where should this conversation resume?',
    });
    if (!choice) return;
    useActive = choice === 'Resume in active session';
  }

  const tmuxPath = await requireTmux();
  if (!tmuxPath) return;
  const cfg = getConfig();

  if (useActive && active && activeName) {
    active.sendText(buildResumeCommand(provider, s.sessionId, s.transcriptPath, s.cwd || ''));
    active.show();
    return;
  }

  // New persistent session (mirrors cmdNewPersistent), then send resume.
  if (!ws) { vscode.window.showErrorMessage('No workspace folder open to create a session in.'); return; }
  index.recordWorkspace(ws.hash, ws.path, ws.label);
  const tabId = index.getNextTabId(ws.hash, cfg.sessionPrefix);
  const name = buildSessionName(cfg.sessionPrefix, ws.hash, tabId);
  index.recordSession(ws.hash, name);
  const meta = index.getSessionMeta(ws.hash, name);
  const { icon, color } = metaIconAndColor(meta);
  const term = vscode.window.createTerminal({
    name: `${ws.label} ${tabId}`,
    shellPath: tmuxPath,
    shellArgs: tmux.buildAttachOrCreateArgs(name, ws.path),
    cwd: ws.path,
    iconPath: icon,
    color,
  });
  term.show();
  refreshSidebar();
  await sleep(SHELL_INIT_DELAY_MS);
  term.sendText(buildResumeCommand(provider, s.sessionId, s.transcriptPath, ws.path));
}
```

> The `resolveTmuxNameForTerminalLive` import already exists at `commands.ts:8`. `metaIconAndColor` is imported there too. Verify `buildSessionName` and `currentWorkspace` imports exist at `commands.ts:9` (they do).

- [ ] **Step 3: Register the command**

In `registerCommands`, add:

```ts
    vscode.commands.registerCommand(COMMAND.resumeFromArchive, () => cmdResumeFromArchive(index, registry)),
```

- [ ] **Step 4: Contribute in `package.json`**

`contributes.commands`:

```json
{
  "command": "terminalSessions.resumeFromArchive",
  "title": "Resume Session from Archive...",
  "icon": "$(history)"
}
```

`contributes.menus` → `view/title` (toolbar button on the sessions view). Add it alongside the existing title items, navigation group:

```json
{
  "command": "terminalSessions.resumeFromArchive",
  "when": "view == terminalSessions.sessions",
  "group": "navigation@9"
}
```

(If a `commandPalette` block lists commands, ensure `resumeFromArchive` is palette-visible.)

- [ ] **Step 5: Compile + manual verify**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile
```
Expected: exit 0.

F5 host:
1. Run the command via the sessions view toolbar `$(history)` button (or Command Palette → "Resume Session from Archive...").
2. Expected: a QuickPick of past sessions for the current workspace; a top toggle to show all projects.
3. Click an item's `$(book)` button → the conversation opens in Markdown preview (no resume).
4. Click an item's `$(edit)` button → name prompt; after saving, the item's primary label updates to the name.
5. Accept an item → if you have an active TS terminal, you are asked "Resume in active session / New session"; otherwise a new session is created and `claude --resume <id>` (or the agent's equivalent) is sent. Confirm the conversation reattaches.

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/config.ts src/commands.ts package.json
git commit -m "feat(archive): Resume Session from Archive picker"
```

---

### Task 9: `cmdCleanupSessions` command

**Files:**
- Modify: `src/config.ts` (COMMAND id)
- Modify: `src/commands.ts` (handler + registration)
- Modify: `package.json` (command + view/title + palette)

**Interfaces:**
- Consumes: `scanArchive` (Task 3), `classifyForCleanup` + `softDeleteSession` (Task 4), `readTranscriptSummary` (Task 1), `currentWorkspace`.
- Produces: command `terminalSessions.cleanupSessions`.

- [ ] **Step 1: Add the COMMAND id**

In `src/config.ts` `COMMAND`, add:

```ts
  cleanupSessions: 'terminalSessions.cleanupSessions',
```

- [ ] **Step 2: Add imports + handler in `commands.ts`**

Extend the archive import to include the cleanup helpers:

```ts
import { scanArchive, ArchivedSession, classifyForCleanup, softDeleteSession } from './archive';
```

Handler:

```ts
/**
 * Find empty / invalid sessions and soft-delete them into ~/.claude/projects/.bak.
 * Default scope is the current workspace; a confirm step widens to all projects.
 * HARD BOUNDARY: only session .jsonl files (+ subagents dirs) are moved — Claude's
 * __store.db / index are never touched.
 */
async function cmdCleanupSessions(
  index: SessionIndex,
  registry: AgentRegistry,
): Promise<void> {
  const ws = currentWorkspace();
  const scopeChoice = await vscode.window.showQuickPick(
    [
      { label: `$(home) This workspace only`, all: false },
      { label: `$(globe) All projects`, all: true },
    ],
    { placeHolder: 'Scan which sessions for cleanup?' },
  );
  if (!scopeChoice) return;
  const scopeCwd = scopeChoice.all ? undefined : ws?.path;

  const sessions = scanArchive(registry.enabled(), (id) => index.getSessionName(id), scopeCwd);
  const targets: Array<{ s: ArchivedSession; verdict: 'empty' | 'invalid' }> = [];
  for (const s of sessions) {
    if (!s.transcriptPath) continue;
    const summary = readTranscriptSummary(s.transcriptPath);
    const verdict = classifyForCleanup(summary);
    if (verdict === 'empty' || verdict === 'invalid') targets.push({ s, verdict });
  }

  if (targets.length === 0) {
    vscode.window.showInformationMessage('No empty or invalid sessions found.');
    return;
  }

  const nEmpty = targets.filter(t => t.verdict === 'empty').length;
  const nInvalid = targets.filter(t => t.verdict === 'invalid').length;
  const confirm = await vscode.window.showWarningMessage(
    `Move ${targets.length} session(s) to .bak (${nEmpty} empty, ${nInvalid} invalid)? Claude's database is left untouched; files go to ~/.claude/projects/.bak and can be restored manually.`,
    { modal: true },
    'Move to .bak',
  );
  if (confirm !== 'Move to .bak') return;

  let moved = 0;
  let failed = 0;
  for (const t of targets) {
    const r = softDeleteSession(t.s.transcriptPath!);
    if (r.ok) moved++; else { failed++; console.error('[terminal-sessions] cleanup failed:', t.s.transcriptPath, r.error); }
  }
  vscode.window.showInformationMessage(`Cleanup done: moved ${moved}${failed ? `, skipped ${failed} (see console)` : ''}.`);
}
```

- [ ] **Step 3: Register the command**

In `registerCommands`, add:

```ts
    vscode.commands.registerCommand(COMMAND.cleanupSessions, () => cmdCleanupSessions(index, registry)),
```

- [ ] **Step 4: Contribute in `package.json`**

`contributes.commands`:

```json
{
  "command": "terminalSessions.cleanupSessions",
  "title": "Clean Up Empty / Invalid Sessions...",
  "icon": "$(trash)"
}
```

`contributes.menus` → `view/title`:

```json
{
  "command": "terminalSessions.cleanupSessions",
  "when": "view == terminalSessions.sessions",
  "group": "navigation@10"
}
```

- [ ] **Step 5: Compile + manual verify (with a safety check on Claude's DB)**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile
```
Expected: exit 0.

Safety check around the manual run (snapshot Claude's DB before/after):
```bash
# Before:
shasum ~/.claude/__store.db 2>/dev/null > /tmp/store-before.txt; cat /tmp/store-before.txt
```
F5 host: run "Clean Up Empty / Invalid Sessions..." → choose "This workspace only" → if any targets, confirm. Then:
```bash
# After — must be identical to before:
shasum ~/.claude/__store.db 2>/dev/null > /tmp/store-after.txt; diff /tmp/store-before.txt /tmp/store-after.txt && echo "DB UNTOUCHED OK"
ls ~/.claude/projects/.bak 2>/dev/null | head
```
Expected: `DB UNTOUCHED OK`, and any moved files present under `.bak`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add src/config.ts src/commands.ts package.json
git commit -m "feat(cleanup): Clean Up Empty/Invalid Sessions command"
```

---

### Task 10: Version bump + CHANGELOG (no publish)

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`

**Interfaces:** none (release prep only).

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.14.9"` to `"version": "0.15.0"` (a feature minor: three new commands).

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md` (above the latest entry), add:

```markdown
## [0.15.0] - 2026-06-20

### Added
- **Resume Session from Archive** — resume any past session from disk (cross-agent), even when nothing is live in tmux. Sessions view toolbar `$(history)` button or Command Palette. Per-item buttons to view or name a conversation; scope toggle for current workspace vs all projects.
- **View Conversation** — open a readable Markdown rendering of a session (thinking and tool calls collapsible) in VS Code's preview, from a session's right-click menu or the archive picker.
- **Clean Up Empty / Invalid Sessions** — soft-delete empty or "Invalid API key" sessions into `~/.claude/projects/.bak`. Claude's database and session index are never touched.
- **Name Conversation** — assign a friendly name to a session, stored in the extension's sidecar index (no changes to Claude's files).
```

- [ ] **Step 3: Compile (final gate)**

Run:
```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source" && npm run compile
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd "/Users/adi/MyWork/Projects/__Scripts/Terminal Sessions/Terminal Sessions - Source"
git add package.json CHANGELOG.md
git commit -m "chore(release): 0.15.0 — archive resume, viewer, cleanup, names"
```

> Publishing (vsce / ovsx / local + remote install) stays user-gated and is intentionally NOT part of this plan. Offer it to the user after the build is verified.

---

## Self-Review

**Spec coverage:**
- Goal 1 (resume any past session, cross-agent) → Tasks 3, 8. ✓
- Goal 2 (view a conversation) → Tasks 5, 6. ✓
- Goal 3 (cleanup, soft-delete, scoped, DB boundary) → Tasks 1, 4, 9. ✓
- Goal 4 (friendly names, no Claude mutation) → Tasks 2, 7. ✓
- Spec "scanArchive over providers" → Task 3 (signature differs from spec's `scanArchive(registry, names, scopeCwd)` — uses injected `providers`+`nameLookup` instead, to keep the core vscode-free/testable; the command supplies `registry.enabled()` and `id => index.getSessionName(id)`). ✓ documented divergence.
- Spec "extend readTranscriptSummary with userAssistantCount + hasSummary" → Task 1. ✓
- Spec "viewer caps at N=400 with explicit elision note, `<details>` collapsibles, no truncation" → Task 5. ✓
- Spec "cleanup never touches `__store.db`/index, soft-delete to `.bak`, preview+confirm, workspace default" → Tasks 4, 9 (+ DB-hash safety check). ✓
- Spec "names sidecar in index.json keyed by sessionId" → Task 2. ✓
- Spec "Unit 1 scope toggle, eye preview button, resume into active or new session" → Task 8. ✓
- Spec bonus "prune our index.json of stopped entries" → intentionally dropped (YAGNI, was a bonus toggle, not a goal). Noted here so it's a conscious omission, not a gap.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". All code blocks are complete. ✓

**Type consistency:**
- `TranscriptSummary.userAssistantCount`/`hasSummary` defined Task 1, consumed identically Task 4/9. ✓
- `scanArchive(providers, nameLookup, scopeCwd?)` defined Task 3, called with the same arg order Task 8/9. ✓
- `ArchivedSession` imported in Task 8/9 from `./archive` where Task 3 exports it. ✓
- `classifyForCleanup`/`softDeleteSession` names consistent Task 4 ↔ Task 9. ✓
- `cmdViewConversation` arg shape `{ transcriptPath; title? }` matches the picker's `executeCommand(COMMAND.viewConversation, { transcriptPath, title })` in Task 8. ✓
- `cmdNameSession` arg `{ sessionId; current? }` matches the picker's `executeCommand(COMMAND.nameSession, { sessionId, current })` and its `string | undefined` return is awaited in Task 8. ✓
- `COMMAND.viewConversation/nameSession/resumeFromArchive/cleanupSessions` added in Tasks 6/7/8/9 respectively, each registered in the same task. ✓

## Execution note on `package.json` menu groups

The `group` ordinals (`open@4`, `open@5`, `navigation@9`, `navigation@10`) are suggestions to slot the new items after existing ones without reordering. If a chosen ordinal collides with an existing entry, pick the next free integer in that group — ordering within a group is cosmetic and not asserted by any test.
