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
  let stat: fs.Stats;
  try { stat = fs.statSync(transcriptPath); }
  catch { return `# Conversation\n\n_Transcript not readable: ${transcriptPath}_\n`; }

  // Only the last maxRecords records are ever shown, so reading (and splitting /
  // JSON.parsing) an 80MB transcript in full would freeze the host for nothing.
  // Read a bounded tail window and parse only that — a few MB comfortably holds
  // maxRecords records; anything before the window is reported as elided.
  const TAIL_WINDOW = 16 * 1024 * 1024;
  const readStart = Math.max(0, stat.size - TAIL_WINDOW);
  let raw = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - readStart;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, readStart);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch { return `# Conversation\n\n_Transcript not readable: ${transcriptPath}_\n`; }

  // When we started mid-file the first line is a partial record — drop it.
  const windowTruncated = readStart > 0;
  if (windowTruncated) {
    const nl = raw.indexOf('\n');
    if (nl >= 0) raw = raw.slice(nl + 1);
  }

  const lines = raw.split('\n').filter(l => l.length > 0 && l[0] === '{');
  // Cap to the most recent maxRecords lines, then JSON.parse only those.
  const overflow = Math.max(0, lines.length - maxRecords);
  const kept = overflow > 0 ? lines.slice(overflow) : lines;
  const records: Array<Record<string, unknown>> = [];
  for (const l of kept) { try { records.push(JSON.parse(l)); } catch { /* skip */ } }

  const anyElided = overflow > 0 || windowTruncated;
  const shown = records;

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
  if (anyElided) {
    const note = windowTruncated
      ? 'Earlier messages elided (large transcript).'
      : `${overflow} earlier messages elided.`;
    head.push(`\n> ${note} Open the raw .jsonl for the full history.\n`);
  }

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

function fence(s: string, lang = ''): string {
  // Use more backticks than the longest backtick run inside the content so a
  // triple-backtick in a tool result can't close the block early.
  let longest = 0;
  const runs = s.match(/`+/g);
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return ticks + lang + '\n' + s + '\n' + ticks;
}
function blockquote(s: string): string { return s.split('\n').map(l => '> ' + l).join('\n'); }
