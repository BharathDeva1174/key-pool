export type StrategyName =
  | 'round-robin'
  | 'random'
  | 'weighted'
  | 'least-used'
  | 'least-latency'
  | 'priority'
  | 'lkgp'
  | 'failover';

export const STRATEGY_NAMES: readonly StrategyName[] = [
  'round-robin',
  'random',
  'weighted',
  'least-used',
  'least-latency',
  'priority',
  'lkgp',
  'failover',
] as const;

export const STRATEGY_DESCRIPTIONS: Record<StrategyName, string> = {
  'round-robin': 'Cycle through every healthy key in turn. The default.',
  random: 'Pick a uniformly random healthy key.',
  weighted: 'Weighted random, honouring each entry\'s weight.',
  'least-used': 'Prefer the key with the fewest requests in flight right now.',
  'least-latency': 'Prefer the key with the lowest observed average latency.',
  priority: 'Always drain the lowest priority number first, then the next.',
  lkgp: 'Last-known-good path: stay on the key that last worked until it fails.',
  failover: 'Always use the first healthy key; only move on when it errors.',
};

/** One routable `(base_url, api_key, model_id)` triple. */
export interface Candidate {
  entryId: string;
  credentialId: string;
  endpointId: string;
  modelId: string;
  weight: number;
  priority: number;
  inFlight: number;
  totalUses: number;
  /** Smoothed latency in ms, or null when the entry has never been measured. */
  latencyEwma: number | null;
}

export interface StrategyContext {
  /** Identity of the pool being routed, e.g. `model:gpt-4o` or `alias:fast`. */
  poolKey: string;
  now: number;
  rand: () => number;
}

export interface PoolStateLike {
  cursor: number;
  lastGood: string | null;
}

/**
 * Orders candidates so index 0 is the preferred target and the rest form the
 * failover sequence. Pure: every decision reads from the arguments only.
 */
export function orderCandidates(
  candidates: Candidate[],
  strategy: StrategyName,
  state: PoolStateLike,
  ctx: StrategyContext,
): Candidate[] {
  if (candidates.length <= 1) return [...candidates];

  switch (strategy) {
    case 'round-robin': {
      const list = [...candidates];
      const start = state.cursor % list.length;
      state.cursor = (state.cursor + 1) % Math.max(list.length, 1);
      return rotate(list, start);
    }

    case 'random': {
      const list = [...candidates];
      const start = Math.floor(ctx.rand() * list.length) % list.length;
      return rotate(list, start);
    }

    case 'weighted': {
      const list = [...candidates];
      const start = weightedIndex(list, ctx.rand());
      return rotate(list, start);
    }

    case 'least-used': {
      return [...candidates].sort(
        (a, b) => a.inFlight - b.inFlight || a.totalUses - b.totalUses || byCreationOrder(a, b),
      );
    }

    case 'least-latency': {
      return [...candidates].sort((a, b) => {
        // An unmeasured key is tried before a measured one. Ranking it last
        // instead would make the pool settle forever on whichever key happened
        // to be picked first, since a key with no sample can never win - so the
        // strategy would never discover a faster key. One probe is enough to
        // give it a number, after which this branch stops applying.
        const aUnknown = a.latencyEwma === null;
        const bUnknown = b.latencyEwma === null;
        if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
        if (aUnknown && bUnknown) return byCreationOrder(a, b);
        return (a.latencyEwma ?? 0) - (b.latencyEwma ?? 0) || byCreationOrder(a, b);
      });
    }

    case 'priority': {
      return [...candidates].sort((a, b) => a.priority - b.priority || byCreationOrder(a, b));
    }

    case 'failover': {
      // Always the first key the operator added, and only a failure moves
      // traffic down the chain. Candidates arrive in the order they were added
      // (the store orders by the monotonic `seq`), so preserving that order is
      // the whole strategy. Ranking by priority here would make this the same
      // thing as `priority` and quietly promote a demoted key.
      return [...candidates];
    }

    case 'lkgp': {
      const list = [...candidates];
      if (state.lastGood) {
        const idx = list.findIndex((c) => c.entryId === state.lastGood);
        if (idx > 0) return rotate(list, idx);
      }
      return list;
    }

    default:
      return [...candidates];
  }
}

/**
 * Creation-order comparison, used as the deterministic tiebreak everywhere.
 *
 * Entry ids are `<prefix>_<9-char base36 milliseconds><10 random chars>`
 * (see `core/ids.ts`), so within one prefix a plain code-unit comparison of two
 * ids is a true creation-order comparison. `localeCompare` is deliberately not
 * used: ICU collation is locale-aware and its ordering for mixed alphanumeric
 * strings is not guaranteed to match code-unit order, which would make the
 * tiebreak depend on the machine's locale.
 */
function byCreationOrder(a: Candidate, b: Candidate): number {
  if (a.entryId < b.entryId) return -1;
  if (a.entryId > b.entryId) return 1;
  return 0;
}

function rotate<T>(list: T[], start: number): T[] {
  const n = list.length;
  if (n === 0) return list;
  const offset = ((start % n) + n) % n;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

function weightedIndex(list: Candidate[], rand: number): number {
  const weights = list.map((c) => Math.max(0, c.weight));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return Math.floor(rand * list.length) % list.length;
  // Keep the threshold strictly inside (0, total) and step over zero-weight
  // entries. Without both, a draw landing exactly on 0 would select the first
  // entry even when its weight is 0 - the one entry the operator explicitly
  // asked never to be used.
  let threshold = Math.min(Math.max(rand, Number.EPSILON), 1 - Number.EPSILON) * total;
  for (let i = 0; i < list.length; i += 1) {
    const weight = weights[i] ?? 0;
    if (weight <= 0) continue;
    threshold -= weight;
    if (threshold < 0) return i;
  }
  return list.length - 1;
}
