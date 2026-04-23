// Per-million-token USD prices from https://platform.claude.com/docs/en/about-claude/pricing
// Verified fetch: January 2026. Update when Anthropic changes the rate card.

export interface ModelPricing {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
  contextLimit: number;
}

// Opus 4.5 / 4.6 / 4.7 — new tokenizer, cheaper rates.
const OPUS_45_UP: ModelPricing = {
  input: 5, output: 25, cache5m: 6.25, cache1h: 10, cacheRead: 0.5, contextLimit: 200_000,
};
const OPUS_45_UP_1M: ModelPricing = { ...OPUS_45_UP, contextLimit: 1_000_000 };

// Opus 4 / 4.1 — older, more expensive pricing.
const OPUS_4_41: ModelPricing = {
  input: 15, output: 75, cache5m: 18.75, cache1h: 30, cacheRead: 1.5, contextLimit: 200_000,
};

const SONNET: ModelPricing = {
  input: 3, output: 15, cache5m: 3.75, cache1h: 6, cacheRead: 0.3, contextLimit: 200_000,
};

const HAIKU_45: ModelPricing = {
  input: 1, output: 5, cache5m: 1.25, cache1h: 2, cacheRead: 0.1, contextLimit: 200_000,
};
const HAIKU_35: ModelPricing = {
  input: 0.8, output: 4, cache5m: 1, cache1h: 1.6, cacheRead: 0.08, contextLimit: 200_000,
};

/** Decide which rate card applies based on the model string (e.g.
 *  `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). */
export function pricingForModel(model: string | undefined): ModelPricing {
  if (!model) return SONNET;
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    // 4.5 / 4.6 / 4.7 all share the new cheaper rates.
    if (/opus-(4-[5-9]|4\.[5-9]|5|6|7|8|9)/.test(m)) return OPUS_45_UP;
    // Opus 4 / 4.1 / Opus 3 (deprecated but same rates)
    return OPUS_4_41;
  }
  if (m.includes('haiku')) {
    if (/haiku-4/.test(m)) return HAIKU_45;
    return HAIKU_35;
  }
  return SONNET;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
}

export function costForUsage(model: string | undefined, u: Usage): number {
  const p = pricingForModel(model);
  const perM = 1_000_000;
  return (
    u.input * p.input / perM +
    u.output * p.output / perM +
    u.cacheRead * p.cacheRead / perM +
    u.cacheCreate5m * p.cache5m / perM +
    u.cacheCreate1h * p.cache1h / perM
  );
}

/** Short display name: "claude-opus-4-7" → "opus". */
export function shortModelName(m: string): string {
  const match = m.match(/claude-(opus|sonnet|haiku)/i);
  return match ? match[1].toLowerCase() : m;
}
