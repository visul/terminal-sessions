// Pure text logic for the terminal link provider: given one terminal line,
// produce (a) ordered path candidates (with spaces) to validate against the
// filesystem, and (b) scheme-less web URL candidates (github.com/owner/repo,
// docs.site.io/page) that the built-in detector ignores.
// No vscode/fs dependencies so it can be tested with plain node.

const MAX_RUNS_PER_LINE = 4;
const MAX_CANDIDATES_PER_RUN = 14;
const MAX_LEAD_WORDS = 8; // words tried before the first slash-word
const MAX_TAIL_WORDS = 4; // words tried after the last slash-word
const MAX_LINE_LENGTH = 2000;

// Characters that terminate a path run. Quotes/backticks are boundaries so a
// quoted path yields exactly the inner text. Parens/brackets are NOT
// boundaries — "Photo (1).png" and "notes/[archive]/file.md" are real names;
// wrapping punctuation is stripped per-candidate instead.
const BOUNDARY = new Set(['"', "'", '`', '<', '>', '|', '*', '?']);

const SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
// Trailing prose/wrapping punctuation almost never ending a real filename.
const TRAILING_PUNCT_RE = /[.,;:!)\]}]+$/;
const LEADING_WRAP_RE = /^[([{]+/;

export interface PathCandidate {
  start: number;
  length: number;
  pathText: string;
  line: number | null;
  col: number | null;
}

interface Run { start: number; text: string; }

function isBoundary(ch: string): boolean {
  return BOUNDARY.has(ch) || ch.charCodeAt(0) < 32;
}

// Extract maximal runs of path-plausible text that contain at least one '/'.
// A single space is allowed inside a run; two consecutive spaces break it.
export function extractRuns(line: string): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    const ch = i < line.length ? line[i] : null;
    const doubleSpace = ch === ' ' && line[i + 1] === ' ';
    if (ch === null || isBoundary(ch) || doubleSpace) {
      if (start !== -1) {
        const text = line.slice(start, i);
        if (text.includes('/')) runs.push({ start, text });
        start = -1;
      }
      if (doubleSpace) i++; // skip second space
    } else if (start === -1 && ch !== ' ') {
      start = i;
    }
  }
  return runs.slice(0, MAX_RUNS_PER_LINE);
}

// Build candidates from one run by choosing a start word (prose may precede
// the path) and an end word (prose may follow it). Slash-bearing words anchor
// the search: every candidate spans the first..last slash-word core, extended
// left/right because folder and file names themselves may contain spaces.
// Ordered longest-first; the first candidate that exists on disk wins.
function candidatesFromRun(run: Run): PathCandidate[] {
  const text = run.text.replace(/\s+$/, '');
  const words: { w: string; pos: number }[] = [];
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) words.push({ w: m[0], pos: m.index });
  if (words.length === 0) return [];

  const slashWords: number[] = [];
  for (let i = 0; i < words.length; i++) if (words[i].w.includes('/')) slashWords.push(i);
  if (slashWords.length === 0) return [];
  const firstSlash = slashWords[0];
  const lastSlash = slashWords[slashWords.length - 1];

  const out: PathCandidate[] = [];
  const seen = new Set<string>();
  const sMin = Math.max(0, firstSlash - (MAX_LEAD_WORDS - 1));
  const eMax = Math.min(words.length - 1, lastSlash + MAX_TAIL_WORDS);

  for (let s = sMin; s <= firstSlash && out.length < MAX_CANDIDATES_PER_RUN; s++) {
    for (let e = eMax; e >= lastSlash && out.length < MAX_CANDIDATES_PER_RUN; e--) {
      let from = words[s].pos;
      const sliceEnd = e + 1 < words.length ? words[e + 1].pos : text.length;
      let cand = text.slice(from, sliceEnd).replace(/\s+$/, '');

      const lead = cand.match(LEADING_WRAP_RE);
      if (lead) {
        from += lead[0].length;
        cand = cand.slice(lead[0].length);
      }
      const punct = cand.match(TRAILING_PUNCT_RE);
      if (punct) cand = cand.slice(0, -punct[0].length);
      if (!cand.includes('/') || cand.length < 3) continue;
      if (seen.has(from + '|' + cand)) continue;
      seen.add(from + '|' + cand);

      // Literal form first: colons are legal in filenames, so the untouched
      // text gets a chance on disk before the :line:col interpretation.
      out.push({ start: run.start + from, length: cand.length, pathText: cand, line: null, col: null });
      const suffix = cand.match(SUFFIX_RE);
      if (suffix) {
        out.push({
          start: run.start + from,
          length: cand.length,
          pathText: cand.slice(0, cand.length - suffix[0].length),
          line: parseInt(suffix[1], 10),
          col: suffix[2] ? parseInt(suffix[2], 10) : null,
        });
      }
    }
  }
  return out;
}

// Public API. Returns candidate groups, one per run; within a group the
// candidates are ordered longest-first — the first that exists on disk wins.
export function findCandidates(rawLine: string): PathCandidate[][] {
  if (!rawLine || !rawLine.includes('/')) return [];
  // Overlong lines (stack traces, minified dumps): scan only the prefix
  // instead of discarding the whole line.
  const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
  return extractRuns(line)
    .map(candidatesFromRun)
    .filter((g) => g.length > 0);
}

// ---------------------------------------------------------------------------
// Scheme-less web URLs. The built-in detector links https:// and www. — this
// catches the rest: github.com/owner/repo, learn.microsoft.com/x, site.io.
// Conservative on purpose: only well-known TLDs (never file-extension
// look-alikes such as .md .sh .ts .py .zip), and never inside another token.
// ---------------------------------------------------------------------------

export interface WebCandidate {
  start: number;
  length: number;
  url: string; // full https:// URL to open
}

const MAX_WEB_LINKS_PER_LINE = 8;

// Common TLDs whose bare mention is near-certainly a website, and which do
// not collide with source-file extensions seen in terminal output.
const TLDS =
  'com|org|net|edu|gov|mil|int|io|dev|ai|app|co|me|info|biz|tv|xyz|cloud|site|online|tech|store|blog|news|wiki|life|space|' +
  'eu|uk|de|fr|es|it|nl|ro|pl|pt|ch|at|be|se|no|fi|dk|ie|gr|cz|hu|ca|us|au|nz|jp|kr|cn|in|br|mx|ar';

// TLDs that collide with everyday non-URL terminal tokens — logger.info(),
// Chrome.app, System.Net, logo.ai, test.pl, Makefile.in… A bare domain on one
// of these only counts when a /path (or :port) follows; github.com stays bare.
const RISKY_TLD_RE = /\.(net|ai|app|co|me|info|pl|in)$/i;

// domain: 1+ labels, then a dot, then a known TLD; path optional.
// Lookbehind keeps us out of emails (@), scheme'd URLs (/), and mid-token
// hits; the lookahead stops the TLD from ending mid-word (example.comfortable)
// or mid-dotted-identifier (System.Net.WebException).
const WEB_RE = new RegExp(
  '(?<![\\w.@/\\-])' +
  '((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:' + TLDS + '))' +
  '(?![a-z0-9-]|\\.[a-z0-9])' +
  '(:\\d{2,5}(?!\\d))?' +
  '((?:/[^\\s"\'`<>|]*)?)',
  'gi',
);

// Trailing punctuation that is prose, not URL: strip like the path matcher.
const WEB_TRAILING_RE = /[.,;:!?)\]}]+$/;

export function findWebCandidates(rawLine: string): WebCandidate[] {
  if (!rawLine || !rawLine.includes('.')) return [];
  const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
  const out: WebCandidate[] = [];
  WEB_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEB_RE.exec(line)) !== null && out.length < MAX_WEB_LINKS_PER_LINE) {
    const domain = m[1];
    // www. is the built-in detector's business; skip to avoid double links.
    if (/^www\./i.test(domain)) continue;
    // A lone TLD pair like "e.g" can't get here (g not in list), but a domain
    // must still look like a hostname: at least 4 chars, no double dots.
    if (domain.length < 4 || domain.includes('..')) continue;
    // Guard against numeric tokens like "1.2.co": the host part (labels
    // before the TLD) must contain at least one letter.
    if (!/[a-z]/i.test(domain.slice(0, domain.lastIndexOf('.')))) continue;
    // Collision-prone TLDs need evidence beyond the bare domain: a port or a
    // path. Otherwise logger.info / Chrome.app / System.Net would linkify.
    if (RISKY_TLD_RE.test(domain) && !m[2] && !m[3]) continue;
    let matched = m[0];
    const punct = matched.match(WEB_TRAILING_RE);
    if (punct) matched = matched.slice(0, -punct[0].length);
    if (matched.length < domain.length) continue; // punct ate into domain — bogus
    out.push({
      start: m.index,
      length: matched.length,
      url: 'https://' + matched,
    });
  }
  return out;
}
