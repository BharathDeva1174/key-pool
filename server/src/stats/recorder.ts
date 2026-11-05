import type { Db } from '../db/index.js';
import type { SettingsStore } from '../settings.js';
import type { CostStore } from './costStore.js';
import { costForLog, type PriceLike } from '../core/cost.js';
import type { Usage } from '../core/usage.js';

export interface LogRow {
  ts: number;
  requestedModel: string;
  aliasId: string | null;
  entryId: string | null;
  endpointName: string | null;
  credentialLabel: string | null;
  upstreamModel: string | null;
  success: boolean;
  statusCode: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  attempts: number;
  strategy: string | null;
  streaming: boolean;
  latencyMs: number | null;
  ttfbMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  /**
   * Whether `completionTokens` already contains `reasoningTokens`. Always true
   * for the streaming paths, whose usage frames report reasoning inside the
   * total; the non-streaming reader computes it from the response shape.
   */
  completionIncludesReasoning?: boolean;
  /**
   * Computed by the recorder at record() time from the row's own usage and the
   * price store - caller-supplied values are overwritten. NULL means the model
   * was unpriced; a true 0 means no tokens were served.
   */
  costUsd?: number | null;
  /** Where the price that produced `costUsd` came from, when one was used. */
  priceSource?: string | null;
  /**
   * The client the request came from, as the identity classifier named it
   * (claude-code, codex, opencode, unknown). Diagnostics, never forwarded
   * upstream; absent on rows written before the column existed.
   */
  clientCategory?: string | null;
}

const INSERT = `
  INSERT INTO request_logs
    (ts, requested_model, alias_id, entry_id, endpoint_name, credential_label, upstream_model,
     success, status_code, error_kind, error_message, attempts, strategy, streaming,
     latency_ms, ttfb_ms, prompt_tokens, completion_tokens, total_tokens,
     cached_tokens, reasoning_tokens, cost_usd, price_source, client_category)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_THRESHOLD = 100;
/**
 * How fast the buffer drains while a Costs page is watching the live feed.
 *
 * The two-second drain is the baseline everywhere; this only exists so the SSE
 * subscribers see their event within a heartbeat of the request finishing
 * rather than within two seconds of it. It is a timer that is *earlier*, never
 * a second write path - the same `flush()` runs either way.
 */
const SUBSCRIBER_FLUSH_MS = 300;

/**
 * Buffers usage rows and writes them in batches.
 *
 * Logging must never add latency to a proxied request or risk a write error
 * taking down the response, so rows land in memory and drain on a timer. The
 * drain timer starts with the recorder, which is what keeps the dashboard
 * numbers live: waiting for the batch threshold or a manual flush would leave
 * a just-finished request invisible until the buffer happened to fill.
 */
export class StatsRecorder {
  private buffer: LogRow[] = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private fastTimer: NodeJS.Timeout | null = null;
  private subscribers = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly costStore?: CostStore,
  ) {
    this.startDrainTimer();
  }

  /** Drains buffered rows every couple of seconds while the process is up. */
  private startDrainTimer(): void {
    this.drainTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.drainTimer.unref?.();
  }

  record(row: LogRow): void {
    if (!this.settings.get('logRequests')) return;
    this.attachCost(row);
    this.buffer.push(row);
    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.flush();
      return;
    }
    // A page watching the live feed gets a fast drain; nobody watching keeps
    // the two-second cadence. Rescheduled rather than piled up, so a burst of
    // requests costs one timer, not one per request.
    if (this.subscribers.size > 0 && !this.fastTimer) {
      this.fastTimer = setTimeout(() => {
        this.fastTimer = null;
        this.flush();
      }, SUBSCRIBER_FLUSH_MS);
      this.fastTimer.unref?.();
    }
  }

  /**
   * Snapshots the cost onto the row.
   *
   * At record() time, not at read time: the price that matters is the one in
   * force when the request happened, and a price edited tomorrow must not
   * silently reprice what was spent today. A row with no token counts at all -
   * every fully failed request - is a true zero; NULL is reserved for a request
   * that produced tokens under a price nobody knows.
   */
  private attachCost(row: LogRow): void {
    if (!this.costStore) return;
    const price = row.upstreamModel ? this.costStore.resolvePrice(row.upstreamModel) : null;
    const priced = row.promptTokens !== null || row.completionTokens !== null;
    const usage: Usage | null = priced
      ? {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          cachedTokens: row.cachedTokens ?? null,
          reasoningTokens: row.reasoningTokens ?? null,
          completionIncludesReasoning: row.completionIncludesReasoning ?? true,
        }
      : null;
    row.costUsd = costForLog(usage, price);
    row.priceSource = price?.source ?? null;
  }

  /**
   * Subscribes to flush notifications for the live feed.
   *
   * The callback carries no data on purpose: the page refetches, so the numbers
   * always come from the same SQL the initial load used rather than from a
   * parallel code path. Returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    const insert = this.db.prepare(INSERT);
    try {
      this.db.exec('BEGIN');
      for (const r of rows) {
        insert.run(
          r.ts,
          r.requestedModel,
          r.aliasId,
          r.entryId,
          r.endpointName,
          r.credentialLabel,
          r.upstreamModel,
          r.success ? 1 : 0,
          r.statusCode,
          r.errorKind,
          r.errorMessage,
          r.attempts,
          r.strategy,
          r.streaming ? 1 : 0,
          r.latencyMs,
          r.ttfbMs,
          r.promptTokens,
          r.completionTokens,
          r.totalTokens,
          r.cachedTokens ?? null,
          r.reasoningTokens ?? null,
          r.costUsd ?? null,
          r.priceSource ?? null,
          r.clientCategory ?? null,
        );
      }
      this.db.exec('COMMIT');
      for (const fn of this.subscribers) {
        try {
          fn();
        } catch {
          /* a dead subscriber must not break the drain */
        }
      }
    } catch {
      // Usage telemetry is not worth failing a request over.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
    }
  }

  /** Deletes rows past the retention window. Returns how many were removed. */
  prune(now = Date.now()): number {
    const days = this.settings.get('logRetentionDays');
    const cutoff = now - days * 86_400_000;
    try {
      const result = this.db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff);
      this.db.exec('PRAGMA optimize');
      return Number(result.changes);
    } catch {
      return 0;
    }
  }

  startRetentionTimer(): void {
    if (this.retentionTimer) return;
    const tick = () => {
      this.flush();
      this.prune();
    };
    this.retentionTimer = setInterval(tick, 60 * 60 * 1000);
    this.retentionTimer.unref?.();
  }

  stop(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.fastTimer) {
      clearTimeout(this.fastTimer);
      this.fastTimer = null;
    }
    this.flush();
  }
}
