/**
 * One rule for what to call a conversation, everywhere the extension shows one
 * (resume pickers, Find Session, View Conversation, rename prefill).
 *
 * Precedence:
 *   1. customTitle — a title the user set INSIDE the agent (Claude `/rename` →
 *      custom-title, Grok `/rename`). The user typed it most recently for that
 *      conversation, so it wins over everything.
 *   2. named       — the extension's own sidecar name (Rename Conversation…), any agent.
 *   3. autoTitle   — the agent's generated title (Claude `ai-title`, Codex `thread_name`,
 *      Antigravity summaries db, Grok `generated_title`).
 *   4. prompt      — the first user message (legacy fallback).
 */
export interface TitledSession {
  sessionId: string;
  customTitle?: string;
  autoTitle?: string;
  firstUserMessage?: string;
}

export type TitleSource = 'custom' | 'named' | 'auto' | 'prompt';

export function conversationTitle(
  s: TitledSession,
  nameLookup: (sessionId: string) => string | undefined,
  max = 80,
): { title?: string; source?: TitleSource } {
  const clean = (v?: string): string | undefined => v?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
  const custom = clean(s.customTitle);
  if (custom) return { title: custom, source: 'custom' };
  const named = clean(nameLookup(s.sessionId));
  if (named) return { title: named, source: 'named' };
  const auto = clean(s.autoTitle);
  if (auto) return { title: auto, source: 'auto' };
  const prompt = clean(s.firstUserMessage);
  if (prompt) return { title: prompt, source: 'prompt' };
  return {};
}
