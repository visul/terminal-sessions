// OpenAI gpt-5.x rate card for Codex sessions.
//
// ⚠️  VERIFY RATES: these are best-effort per-million-token USD prices for the
// OpenAI Responses/Codex models as of early 2026. OpenAI adjusts pricing
// periodically and the Codex CLI may run several gpt-5.x variants (`gpt-5`,
// `gpt-5.5`, `gpt-5-codex`, `gpt-5-mini`, …). Re-check against
// https://platform.openai.com/docs/pricing before trusting the cost figure.
//
// Unlike Anthropic's transcript (which carries a cache_creation split), Codex's
// token_count event reports only `input_tokens`, `cached_input_tokens`, and
// `output_tokens`. OpenAI bills cached input at a discounted rate, so we treat
// `cached_input_tokens` as a "cacheRead" bucket priced at the model's cached
// input rate. There is no separate cache-write charge on OpenAI, so we don't
// model one.

export interface CodexModelPricing {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached input tokens (the discounted re-read rate). */
  cachedInput: number;
  /** USD per 1M output tokens (includes reasoning output tokens). */
  output: number;
  /** Default context window, used only as a fallback — the transcript's
   *  `model_context_window` is authoritative when present. */
  contextLimit: number;
}

// gpt-5.x flagship (gpt-5 / gpt-5.5 / gpt-5-codex share the same headline
// rates in OpenAI's published card; the codex-tuned variant is billed as the
// base model).
const GPT_5: CodexModelPricing = {
  input: 1.25,
  cachedInput: 0.125,
  output: 10,
  contextLimit: 400_000,
};

// gpt-5-mini — cheaper tier sometimes selected for lightweight turns.
const GPT_5_MINI: CodexModelPricing = {
  input: 0.25,
  cachedInput: 0.025,
  output: 2,
  contextLimit: 400_000,
};

// gpt-5-nano — smallest tier.
const GPT_5_NANO: CodexModelPricing = {
  input: 0.05,
  cachedInput: 0.005,
  output: 0.4,
  contextLimit: 400_000,
};

/** Pick the rate card for a Codex model string (e.g. `gpt-5.5`, `gpt-5-codex`,
 *  `gpt-5-mini-2026-xx`). Defaults to the gpt-5 flagship card when unknown so
 *  cost is over- rather than under-estimated. */
export function pricingForCodexModel(model: string | undefined): CodexModelPricing {
  if (!model) return GPT_5;
  const m = model.toLowerCase();
  // Order matters: match the more specific suffixes before the generic gpt-5.
  if (m.includes('nano')) return GPT_5_NANO;
  if (m.includes('mini')) return GPT_5_MINI;
  // gpt-5, gpt-5.5, gpt-5-codex, o3/o4 fall through to the flagship card.
  return GPT_5;
}

/** Per-turn token usage extracted from a Codex `token_count` event's
 *  `last_token_usage` block. `input` is the UNCACHED input (we subtract the
 *  cached portion before billing so the same tokens aren't charged twice). */
export interface CodexUsage {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Compute the USD cost of one Codex turn. `usage.input` is the full input token
 * count from the event; `usage.cachedInput` is the cached subset. We bill the
 * uncached remainder at the input rate and the cached subset at the cheaper
 * cached rate. Reasoning output tokens are already folded into `output` by the
 * caller (OpenAI bills them at the standard output rate).
 */
export function costForUsageCodex(model: string | undefined, usage: CodexUsage): number {
  const p = pricingForCodexModel(model);
  const perM = 1_000_000;
  const cached = Math.max(0, usage.cachedInput);
  const uncached = Math.max(0, usage.input - cached);
  return (
    (uncached * p.input) / perM +
    (cached * p.cachedInput) / perM +
    (Math.max(0, usage.output) * p.output) / perM
  );
}

/** Short display name: "gpt-5-codex" → "gpt-5", "gpt-5.5" → "gpt-5.5". */
export function shortCodexModelName(m: string): string {
  if (!m) return m;
  const match = m.toLowerCase().match(/^(gpt-[0-9.]+|o[0-9])/);
  return match ? match[1] : m;
}
