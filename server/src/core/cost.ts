/**
 * Cost arithmetic and price parsing, kept pure.
 *
 * No database and no network in this file, for the same reason `routing/health.ts`
 * holds no database: the rules that decide what a request cost are the rules
 * most worth testing exhaustively, and they are also the rules most expensive to
 * get wrong, because a wrong number is indistinguishable from a right one on a
 * bill. Everything here is a function of its arguments.
 *
 * Reading token usage out of a response lives in `usage.ts`, which is shared
 * with the proxy path - a stream and a non-streaming body must never be priced
 * from two different readings of the same usage block.
 */
import type { Usage } from './usage.js';

/**
 * The shape of a price the arithmetic needs. `ModelPrice` (in costStore) adds
 * bookkeeping fields; the math only ever reads the three rates.
 */
export interface PriceLike {
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedPer1m: number | null;
}

/** A price parsed out of a catalogue payload, before it has a row. */
export interface ParsedPrice extends PriceLike {
  modelId: string;
}

/**
 * The cost of one request, in USD.
 *
 * `null` means **unpriced** and must never be coerced to zero: a request
 * against a model with no known price is an unknown amount, and reporting it as
 * free is how a real bill ends up quietly understated. A price of exactly 0 is a
 * legitimate answer for a self-hosted model and is returned as 0.
 *
 * Cached input is billed at its own rate and subtracted from the prompt count,
 * so the two never double-count the same token.
 */
export function computeCostUsd(usage: Usage, price: PriceLike): number | null {
  if (price.inputPer1m === null || price.outputPer1m === null) return null;
  const prompt = usage.promptTokens ?? 0;
  // A provider can report more cached than prompt on a retried or partially
  // cached request; clamping stops that producing a negative input charge.
  const cached = Math.max(0, Math.min(usage.cachedTokens ?? 0, prompt));
  const billableInput = prompt - cached;
  // A null cached rate falls back to the input rate, which is the safe reading:
  // it over-charges slightly rather than handing out a free cache discount the
  // provider never advertised.
  const cachedRate = price.cachedPer1m ?? price.inputPer1m;
  let completion = usage.completionTokens ?? 0;
  if (!usage.completionIncludesReasoning && (usage.reasoningTokens ?? 0) > 0) {
    completion += usage.reasoningTokens as number;
  }
  return (
    (billableInput * price.inputPer1m + cached * cachedRate + completion * price.outputPer1m) /
    1_000_000
  );
}

/**
 * The cost to record for one logged request.
 *
 * `usage === null` - or a row whose token counts are both absent, which is how a
 * fully failed request logs - is a **true zero**, never NULL: no tokens were
 * served, so there is nothing to price. NULL is reserved for the one case where
 * the amount is genuinely unknown, a request that produced tokens under a model
 * whose price nobody knows. Collapsing those two would either bill every failed
 * request as an unknown or report every unpriced model as free.
 */
export function costForLog(usage: Usage | null, price: PriceLike | null): number | null {
  if (!usage || (usage.promptTokens === null && usage.completionTokens === null)) return 0;
  if (!price) return null;
  return computeCostUsd(usage, price);
}

/**
 * Finds the price for a model this proxy actually routes to.
 *
 * Upstreams here are third-party OpenAI-compatible gateways whose ids are not
 * OpenRouter's, so an exact match is the exception rather than the rule. The
 * fallback is the part after the last slash, which is what makes
 * "minimax/minimax-m3" resolve against "minimax-m3". First match wins, so a
 * caller should pass exact candidates before loose ones.
 */
export function matchPrice<P extends ParsedPrice>(modelId: string, table: Map<string, P>): P | null {
  const exact = table.get(modelId);
  if (exact) return exact;
  /*
   * The slash rule has to work in both directions, because both mismatches
   * occur in practice and neither is the rarer one:
   *
   *   table "minimax/minimax-m3" vs routed "minimax-m3"  - a third-party gateway
   *   that drops the vendor prefix from the id it reports;
   *   table "minimax-m3"       vs routed "minimax/minimax-m3" - a router that
   *   namespaces a model the catalogue lists bare.
   *
   * So every bare name on either side is a candidate, and a match is accepted
   * only when it is unambiguous. Two vendors publishing the same bare name is
   * common enough in the catalogue that guessing between them would put a wrong
   * number on a real bill; an unpriced model is a label, a wrong price is money
   * someone pays.
   */
  const bare = (id: string) => id.slice(id.lastIndexOf('/') + 1);
  // Compare bare name to bare name. That single comparison covers both
  // directions: it does not matter which side carries the vendor prefix.
  //
  // Note that only the query's own bare name is a candidate. Folding every key
  // in the table into the candidate set would make every entry match it, and
  // "ambiguous, so unpriced" would then be the answer to every question.
  const matches = [...table.values()].filter((p) => bare(p.modelId) === bare(modelId));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** A change large enough to be worth telling the operator about. */
const SUSPICIOUS_FACTOR = 3;

/**
 * Flags a price change the operator should see before trusting it.
 *
 * A >3x move in either direction is far more likely to be a units mistake or a
 * catalogue error than a real repricing, and a cache rate above the input rate
 * is nonsense in every provider that has ever existed. Neither is rejected - the
 * figure is still stored, because a wrong-looking price may be right - but both
 * are surfaced.
 */
export function flagPriceChange(previous: ParsedPrice | null, next: ParsedPrice): 'none' | 'jumped_up' | 'jumped_down' | 'cached_above_input' {
  if (!previous) return 'none';
  const before = previous.inputPer1m;
  if (before === null || before === 0) return 'none';
  if (next.cachedPer1m !== null && next.inputPer1m !== null && next.cachedPer1m > next.inputPer1m) {
    return 'cached_above_input';
  }
  for (const [was, now] of [
    [before, next.inputPer1m],
    [previous.outputPer1m, next.outputPer1m],
  ] as Array<[number | null, number | null]>) {
    if (was === null || now === null || was === 0) continue;
    const ratio = now / was;
    if (ratio >= SUSPICIOUS_FACTOR) return 'jumped_up';
    if (ratio <= 1 / SUSPICIOUS_FACTOR) return 'jumped_down';
  }
  return 'none';
}

/**
 * Parses `GET /openrouter.ai/api/v1/models`.
 *
 * Two conventions in that payload matter and both are easy to get wrong:
 *
 *  - prices are **strings** in USD **per token** ("0.0000025"), so they are
 *    multiplied by 1e6 into the per-million unit this codebase stores;
 *  - a price of **"-1"** means "this provider does not sell that modality",
 *    not "free". Skipping it is the difference between an unpriced model and a
 *    model that silently reports zero.
 */
export function parseOpenRouterModels(payload: unknown): ParsedPrice[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ParsedPrice[] = [];
  for (const entry of data) {
    const row = entry as { id?: unknown; pricing?: Record<string, unknown> } | null;
    if (typeof row?.id !== 'string' || !row.id) continue;
    const pricing = row.pricing ?? {};
    out.push({
      modelId: row.id,
      inputPer1m: perMillion(pricing.prompt),
      outputPer1m: perMillion(pricing.completion),
      cachedPer1m: perMillion(pricing.input_cache_read),
    });
  }
  return out;
}

/** A per-token price string to per-million, or null when absent or -1. */
function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

export interface FxRate {
  code: string;
  rate: number;
  name: string | null;
}

/**
 * Parses `https://open.er-api.com/v6/latest/USD`.
 *
 * The response is keyed by currency code and omits USD itself, so it is added
 * back at 1. A missing or non-finite rate is skipped rather than defaulted,
 * because a rate of 1 for an unknown currency would report real spend as zero.
 */
export function parseFxRates(payload: unknown): FxRate[] {
  const body = payload as { rates?: Record<string, unknown> } | null;
  if (!body || typeof body.rates !== 'object' || body.rates === null) return [];
  /*
   * Keyed by code, and the base is *defined* rather than fetched.
   *
   * The source includes USD in its own list, so prepending a USD row alongside
   * it produced two rows with the same primary key and the whole insert failed.
   * A Map cannot do that. Forcing USD to 1 also means a source that omitted the
   * base, or quoted it oddly, still cannot make the base currency
   * unconvertible - every other rate is defined as "per 1 USD", so that row has
   * to be true for the arithmetic to mean anything.
   */
  const byCode = new Map<string, FxRate>();
  for (const [code, value] of Object.entries(body.rates)) {
    const rate = typeof value === 'number' ? value : Number(value);
    if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0) continue;
    byCode.set(code, { code, rate, name: null });
  }
  byCode.set('USD', { code: 'USD', rate: 1, name: 'US Dollar' });
  return [...byCode.values()];
}
