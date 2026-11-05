import type { PoolStateLike } from './strategies.js';

const EWMA_ALPHA = 0.3;

interface LatencySample {
  ewma: number;
  samples: number;
}

/**
 * In-memory routing state.
 *
 * Deliberately not persisted: a cursor that resets to zero on restart is
 * harmless, and keeping this out of SQLite means selection never touches the
 * disk. Durable health lives in the `credentials` / `model_entries` tables.
 */
export class PoolState {
  private readonly poolStates = new Map<string, PoolStateLike>();
  private readonly inFlight = new Map<string, number>();
  private readonly totalUses = new Map<string, number>();
  private readonly latency = new Map<string, LatencySample>();

  private stateFor(poolKey: string): PoolStateLike {
    let s = this.poolStates.get(poolKey);
    if (!s) {
      s = { cursor: 0, lastGood: null };
      this.poolStates.set(poolKey, s);
    }
    return s;
  }

  /** Returns the mutable per-pool record used by the strategies. */
  pool(poolKey: string): PoolStateLike {
    return this.stateFor(poolKey);
  }

  /**
   * Claims a slot for an entry. Called in the same synchronous block as
   * selection so two concurrent requests cannot pick the same round-robin slot.
   */
  begin(entryId: string): void {
    this.inFlight.set(entryId, (this.inFlight.get(entryId) ?? 0) + 1);
    this.totalUses.set(entryId, (this.totalUses.get(entryId) ?? 0) + 1);
  }

  end(entryId: string): void {
    const next = (this.inFlight.get(entryId) ?? 0) - 1;
    if (next <= 0) this.inFlight.delete(entryId);
    else this.inFlight.set(entryId, next);
  }

  inFlightFor(entryId: string): number {
    return this.inFlight.get(entryId) ?? 0;
  }

  totalUsesFor(entryId: string): number {
    return this.totalUses.get(entryId) ?? 0;
  }

  latencyFor(entryId: string): number | null {
    return this.latency.get(entryId)?.ewma ?? null;
  }

  /** Folds an observation into the entry's EWMA. Null samples are ignored. */
  recordLatency(entryId: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const current = this.latency.get(entryId);
    if (!current) {
      this.latency.set(entryId, { ewma: ms, samples: 1 });
      return;
    }
    this.latency.set(entryId, {
      ewma: EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * current.ewma,
      samples: current.samples + 1,
    });
  }

  /** Marks an entry as the last one that worked for a pool (drives `lkgp`). */
  markGood(poolKey: string, entryId: string): void {
    this.stateFor(poolKey).lastGood = entryId;
  }

  lastGood(poolKey: string): string | null {
    return this.stateFor(poolKey).lastGood;
  }

  /** Drops per-entry counters for entries that no longer exist. */
  forget(entryIds: string[]): void {
    for (const id of entryIds) {
      this.inFlight.delete(id);
      this.totalUses.delete(id);
      this.latency.delete(id);
    }
    for (const [key, state] of this.poolStates) {
      if (state.lastGood && entryIds.includes(state.lastGood)) state.lastGood = null;
      void key;
    }
  }

  snapshot(entryIds: string[]): Record<string, { inFlight: number; totalUses: number; latencyEwma: number | null }> {
    const out: Record<string, { inFlight: number; totalUses: number; latencyEwma: number | null }> = {};
    for (const id of entryIds) {
      out[id] = {
        inFlight: this.inFlightFor(id),
        totalUses: this.totalUsesFor(id),
        latencyEwma: this.latencyFor(id),
      };
    }
    return out;
  }
}
