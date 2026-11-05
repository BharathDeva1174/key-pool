/**
 * The ranking itself: three axes, one composite, six role picks.
 *
 * Intelligence is the curated prior from knowledge.ts. Reliability is the
 * live success rate blended with the health of the keys behind the model.
 * Efficiency is price and latency, scored on log scales because the difference
 * between $0.10 and $1 per million matters far more than between $20 and $21.
 *
 * All of it is pure arithmetic over numbers the route already has, so the
 * page, the tests and any future surface cannot disagree about how a model
 * was ranked.
 */

export type Tier = 'S' | 'A' | 'B' | 'C';

export interface ModelInput {
  modelId: string;
  requests: number;
  failures: number;
  avgLatencyMs: number | null;
  totalKeys: number;
  healthyKeys: number;
  inputPer1m: number | null;
  outputPer1m: number | null;
  free: boolean;
}

export interface ScoredModel extends ModelInput {
  family: string;
  successRate: number | null;
  blendedPricePer1m: number | null;
  intelligence: number;
  reliability: number;
  efficiency: number;
  composite: number;
  tier: Tier;
  /** Whether the reliability figure rests on real traffic or only on health. */
  measured: 'tested' | 'untested';
  /** Whether a price was available at all. */
  priced: boolean;
}

export const COMPOSITE_WEIGHTS = { intelligence: 0.5, reliability: 0.3, efficiency: 0.2 } as const;

/**
 * Role weights: how much each axis matters for a step of the workflow.
 * Planning is about depth; testing is about trust; long agent runs are about
 * cost and not falling over, so the weights move with the job.
 */
export const ROLE_WEIGHTS = {
  plan: { intelligence: 0.7, reliability: 0.2, efficiency: 0.1 },
  build: { intelligence: 0.45, reliability: 0.35, efficiency: 0.2 },
  test: { intelligence: 0.25, reliability: 0.55, efficiency: 0.2 },
  review: { intelligence: 0.55, reliability: 0.3, efficiency: 0.15 },
  docs: { intelligence: 0.35, reliability: 0.15, efficiency: 0.5 },
  agent: { intelligence: 0.2, reliability: 0.35, efficiency: 0.45 },
} as const;

export type RoleName = keyof typeof ROLE_WEIGHTS;
const ROLES = Object.keys(ROLE_WEIGHTS) as RoleName[];

export interface RolePick {
  role: RoleName;
  modelId: string;
  runnerUpId: string | null;
  score: number;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(clamp(n));

/** Price per million at a balanced input/output mix, or null when unknown. */
export function blendedPrice(input: number | null, output: number | null, free: boolean): number | null {
  if (free) return 0;
  if (input === null && output === null) return null;
  const i = input ?? output ?? 0;
  const o = output ?? input ?? 0;
  return Math.round((i * 0.5 + o * 0.5) * 1000) / 1000;
}

/**
 * Efficiency on two log scales: a linear scale made a free model and a
 * $0.50 model both read as "cheap", which is not what the operator needs to
 * know.
 */
function efficiencyScore(price: number | null, latencyMs: number | null): number {
  const priceScore = price === null ? 50 : clamp(100 - 38 * Math.log10(1 + price));
  const latencyScore = latencyMs === null ? 60 : clamp(100 - 30 * Math.log10(1 + latencyMs / 100));
  return round(priceScore * 0.6 + latencyScore * 0.4);
}

export function scoreModel(input: ModelInput, prior: { intelligence: number; family: string }): ScoredModel {
  const successRate = input.requests > 0 ? (input.requests - input.failures) / input.requests : null;
  const healthShare = input.totalKeys > 0 ? input.healthyKeys / input.totalKeys : 0;

  // Real traffic is evidence; key health is a prior. Blend so a quiet model
  // with dead keys cannot outrank a proven one, and a proven one with a single
  // dead key is not dragged to the floor.
  const reliability =
    successRate === null
      ? round(healthShare * 100)
      : round((successRate * 100) * 0.65 + healthShare * 100 * 0.35);

  const price = blendedPrice(input.inputPer1m, input.outputPer1m, input.free);
  const efficiency = efficiencyScore(price, input.avgLatencyMs);

  const composite = round(
    prior.intelligence * COMPOSITE_WEIGHTS.intelligence +
      reliability * COMPOSITE_WEIGHTS.reliability +
      efficiency * COMPOSITE_WEIGHTS.efficiency,
  );

  const tier: Tier = composite >= 85 ? 'S' : composite >= 75 ? 'A' : composite >= 65 ? 'B' : 'C';

  return {
    ...input,
    family: prior.family,
    successRate,
    blendedPricePer1m: price,
    intelligence: prior.intelligence,
    reliability,
    efficiency,
    composite,
    tier,
    measured: input.requests > 0 ? 'tested' : 'untested',
    priced: price !== null,
  };
}

const roleScore = (m: ScoredModel, role: RoleName): number => {
  const w = ROLE_WEIGHTS[role];
  return m.intelligence * w.intelligence + m.reliability * w.reliability + m.efficiency * w.efficiency;
};

/** The best model per role, with a runner-up so the advice is not a single point of failure. */
export function pickRoles(models: ScoredModel[]): RolePick[] {
  if (models.length === 0) return [];
  return ROLES.map((role) => {
    const ranked = [...models].sort(
      (a, b) => roleScore(b, role) - roleScore(a, role) || b.composite - a.composite || a.modelId.localeCompare(b.modelId),
    );
    const best = ranked[0]!;
    const second = ranked[1];
    return {
      role,
      modelId: best.modelId,
      runnerUpId: second?.modelId ?? null,
      score: round(roleScore(best, role)),
    };
  });
}

export function tierCounts(models: ScoredModel[]): Record<Tier, number> {
  const out: Record<Tier, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const m of models) out[m.tier] += 1;
  return out;
}

/** Ranked best-first: composite, then intelligence as the tie-break. */
export function rankModels(models: ScoredModel[]): ScoredModel[] {
  return [...models].sort(
    (a, b) => b.composite - a.composite || b.intelligence - a.intelligence || a.modelId.localeCompare(b.modelId),
  );
}
