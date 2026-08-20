// Turn-outcome classification: a cheap, LLM-free read of "how did the last
// agent turn end?" built only from signals the transcript tailers already
// collect. The sidebar uses it to color an idle row (done vs failed vs asked
// you), the Stop notification uses it for a concrete body, and the unread
// badge uses it to pick green vs red.

import type { TranscriptSnapshot } from './claude-transcript';

export type OutcomeKind = 'ok' | 'failed' | 'tests-red' | 'rate-limited' | 'asked-user';

export interface TurnOutcome {
  kind: OutcomeKind;
  /** Short human hint for the row/tooltip/toast, e.g. "3 tests failed". */
  hint?: string;
}

/** Per-turn tool-result evidence the transcript reducers accumulate. Reset on
 *  every new user prompt so a recovered error from a previous turn never
 *  colours the current one. */
export interface TurnEvidence {
  /** Number of tool results flagged as errors by the agent runtime this turn. */
  toolErrors: number;
  /** True when the most recent tool result of the turn was an error — the agent
   *  stopped right after a failure instead of recovering. */
  lastToolErrored: boolean;
  /** Preview of the most recent error output. */
  lastToolErrorPreview?: string;
  /** Set when a tool result looked like a test/build failure; cleared again when
   *  a later result looks like a pass. */
  testsFailedHint?: string;
  /** Set when a result or message mentioned a rate limit / overload. */
  rateLimitHint?: string;
}

export function emptyTurnEvidence(): TurnEvidence {
  return { toolErrors: 0, lastToolErrored: false };
}

// Tool output shapes that mean a test/build/lint run went red. Kept narrow on
// purpose: a false "tests failed" on a green row is worse than a missed one.
const TEST_FAIL_RES: RegExp[] = [
  /\b([1-9]\d*)\s+(?:tests?\s+)?failed\b/i,      // "3 failed", "3 tests failed" (never "0 failed")
  /\bTests?:\s+[1-9]\d*\s+failed/i,              // jest summary
  /\bFAILED\s*\(/i,                              // pytest "FAILED (failures=2)"
  /^\s*FAIL\b/m,                                 // jest/go per-file FAIL
  /\bnpm ERR!\b/,                                // npm script failure
  /\berror TS\d{4}\b/,                           // tsc
  /\bAssertionError\b/,
  /\bBUILD FAILED\b/i,
  /\bcompilation failed\b/i,
  /\bexit(?:ed)?(?: with)? code [1-9]\d*\b/i,
];
const TEST_PASS_RES: RegExp[] = [
  /\b(\d+)\s+passed\b.*\b0\s+failed\b/i,
  /\bTests?:\s+\d+\s+passed,\s+\d+\s+total\b/i,
  /\ball tests passed\b/i,
  /\bok\s+\d+\s+tests?\b/i,
  /\bBUILD SUCCESS(?:FUL)?\b/i,
];
const RATE_LIMIT_RE = /\b(rate.?limit|overloaded|usage limit|quota exceeded|429|529)\b/i;

function firstLine(s: string, max = 90): string {
  const line = s.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function matchingLine(s: string, res: RegExp[]): string | undefined {
  for (const re of res) {
    const m = s.match(re);
    if (m) {
      // Surface the whole line the match sits on, it reads better than the token.
      const idx = m.index ?? 0;
      const start = s.lastIndexOf('\n', idx) + 1;
      const end = s.indexOf('\n', idx);
      return firstLine(s.slice(start, end < 0 ? undefined : end));
    }
  }
  return undefined;
}

/** Tools whose output is a command's stdout/stderr — the only place the text
 *  heuristics below are meaningful. A `Read` of a CI log or a `Grep` hit on
 *  "AssertionError" is not a failed run. */
const SHELL_TOOL_RE = /^(bash|bashoutput|shell|exec|exec_command|run_command|terminal|command|powershell|zsh|sh)$/i;
export function isShellTool(name: string | undefined): boolean {
  return !!name && SHELL_TOOL_RE.test(name);
}

/** Fold one tool result into the turn evidence. `isError` is the runtime's own
 *  flag when it has one (Claude `is_error`, Codex `exit_code`) and applies to
 *  any tool; the text heuristics run only for shell-like tools (`toolName`). */
export function noteToolResult(
  ev: TurnEvidence,
  text: string | undefined,
  isError: boolean | undefined,
  toolName?: string,
): void {
  const body = text || '';
  if (isError) {
    ev.toolErrors++;
    ev.lastToolErrored = true;
    ev.lastToolErrorPreview = firstLine(body) || undefined;
  } else {
    ev.lastToolErrored = false;
  }
  if (!body || !isShellTool(toolName)) return;
  const fail = matchingLine(body, TEST_FAIL_RES);
  if (fail) ev.testsFailedHint = fail;
  else if (matchingLine(body, TEST_PASS_RES)) ev.testsFailedHint = undefined;
  const rl = body.match(RATE_LIMIT_RE);
  if (rl) ev.rateLimitHint = firstLine(body);
  else if (!isError) ev.rateLimitHint = undefined; // a later clean command = the limit passed
}

const GAVE_UP_RE = /\b(fail(ed|ure|s)?|error|couldn'?t|cannot|can'?t|unable|broken|not (able|possible)|gave up|blocked)\b/i;

/** Fold an assistant message into the evidence. API errors land there; and a
 *  final text that does NOT read as giving up clears a trailing tool error —
 *  an expected probe failure (file-exists check, grep with no match) followed
 *  by "Done, all green." is a success, not a failed turn. */
export function noteAssistantText(ev: TurnEvidence, text: string | undefined): void {
  if (!text) return;
  if (/^API Error\b/i.test(text) || RATE_LIMIT_RE.test(text)) { ev.rateLimitHint = firstLine(text); return; }
  // Ordinary assistant text after a limit hit means the agent got through.
  ev.rateLimitHint = undefined;
  if (ev.lastToolErrored && !GAVE_UP_RE.test(text)) ev.lastToolErrored = false;
}

/** Does the agent's final message read as a question the user must answer?
 *  Only the LAST sentence counts, and a trailing "?" is required — "Done. Let
 *  me know if you want more." is a closing courtesy, not a block. */
function asksUser(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim().replace(/[*_`)\]]+$/, '').trim();
  if (!/\?$/.test(t)) return false;
  const lastSentence = t.split(/(?<=[.!?])\s+/).pop() || t;
  // Rhetorical / offer-of-more endings don't block anything.
  return !/\b(anything else|let me know|feel free|want (me )?to (also|go) (on|further|ahead))\b/i.test(lastSentence);
}

/** Classify how the last turn ended. Precedence: rate limit (hard stop) >
 *  an error the agent gave up on > red tests > a question > plain done. */
export function classifyOutcome(t: TranscriptSnapshot): TurnOutcome {
  const ev = t.turn;
  if (ev?.rateLimitHint) return { kind: 'rate-limited', hint: ev.rateLimitHint };
  if (ev?.lastToolErrored) return { kind: 'failed', hint: ev.lastToolErrorPreview || 'last tool call failed' };
  if (ev?.testsFailedHint) return { kind: 'tests-red', hint: ev.testsFailedHint };
  if (asksUser(t.lastAssistantMessage)) return { kind: 'asked-user', hint: t.lastAssistantMessage };
  return { kind: 'ok' };
}

/** Row/toast wording per outcome. */
export function outcomeLabel(o: TurnOutcome | undefined): string {
  switch (o?.kind) {
    case 'failed': return '✗ failed';
    case 'tests-red': return '✗ tests failed';
    case 'rate-limited': return '⏳ rate limited';
    case 'asked-user': return '? asked you';
    default: return 'done';
  }
}

export function outcomeIsBad(o: TurnOutcome | undefined): boolean {
  return o?.kind === 'failed' || o?.kind === 'tests-red' || o?.kind === 'rate-limited';
}
