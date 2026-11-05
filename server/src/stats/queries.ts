import type { Db } from '../db/index.js';
import type { DayActivity } from './streak.js';

type Row = Record<string, unknown>;

export type { DayActivity };

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Total tokens for a window, kept consistent with the in/out split the UI shows.
 *
 * Providers report `total_tokens` as prompt + completion, so a split that
 * exists is authoritative. A provider that reports only a grand total keeps it,
 * because deriving zero from a missing split would understate real usage.
 */
function tokenTotal(prompt: number, completion: number, reported: number): number {
  return prompt + completion > 0 ? prompt + completion : reported;
}

export interface Overview {
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  streamingRequests: number;
  since: number;
}

export interface TimeseriesBucket {
  bucket: number;
  requests: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number | null;
}

export interface BreakdownRow {
  label: string;
  requests: number;
  failures: number;
  totalTokens: number;
  avgLatencyMs: number | null;
}

/**
 * Spend for a window. `costUsd` sums the per-row snapshots; a request the
 * recorder could not price contributes nothing to the sum and is counted
 * separately in `unpricedRequests`, so a total is never quietly understated by
 * reporting an unknown as zero.
 */
export interface CostSummary {
  costUsd: number | null;
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  /** Spend divided by priced requests only - unpriced rows would drag it down. */
  avgCostPerRequestUsd: number | null;
}

export interface CostTimeseriesPoint {
  bucket: number;
  requests: number;
  costUsd: number | null;
}

export interface CostBreakdownRow {
  label: string;
  requests: number;
  failures: number;
  costUsd: number | null;
  unpricedRequests: number;
  avgCostPerRequestUsd: number | null;
  /**
   * In + out tokens the label served, read the same way the token tables read
   * them (a provider that reported only a grand total keeps it). This is what
   * a price is applied to.
   */
  combinedTokens: number;
}

/** One row of the recent-priced-requests feed. */
export interface CostRequestRow {
  id: number;
  ts: number;
  /** The model that served, falling back to the name the client asked for. */
  model: string;
  requestedModel: string;
  endpointName: string | null;
  credentialLabel: string | null;
  success: boolean;
  statusCode: number | null;
  errorKind: string | null;
  streaming: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  priceSource: string | null;
}

/**
 * All dashboard aggregates are SQL over indexed columns rather than in-memory
 * counters, so the numbers always agree with the log and survive a restart.
 */
export class StatsQueries {
  constructor(private readonly db: Db) {}

  overview(sinceMs: number): Overview {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(COALESCE(prompt_tokens, 0))     AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(total_tokens, 0))      AS total_tokens,
                AVG(latency_ms)                     AS avg_latency,
                SUM(streaming)                      AS streaming
           FROM request_logs
          WHERE ts >= ?`,
      )
      .get(sinceMs) as Row;

    const latencies = (
      this.db
        .prepare('SELECT latency_ms FROM request_logs WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC')
        .all(sinceMs) as Row[]
    ).map((x) => num(x.latency_ms));

    const requests = num(r.requests);
    const successes = num(r.successes);
    const promptTokens = num(r.prompt_tokens);
    const completionTokens = num(r.completion_tokens);
    return {
      requests,
      successes,
      failures: num(r.failures),
      successRate: requests === 0 ? 0 : successes / requests,
      promptTokens,
      completionTokens,
      totalTokens: tokenTotal(promptTokens, completionTokens, num(r.total_tokens)),
      avgLatencyMs: r.avg_latency === null ? null : Math.round(num(r.avg_latency)),
      p95LatencyMs: percentile(latencies, 0.95),
      streamingRequests: num(r.streaming),
      since: sinceMs,
    };
  }

  timeseries(sinceMs: number, bucketMs: number): TimeseriesBucket[] {
    const rows = this.db
      .prepare(
        // `ts - (ts % ?)` rather than `(ts / ?) * ?`. The division form is true
        // division once the bound parameter is a double, so `ts / 3600000 *
        // 3600000` returns the timestamp unchanged and every request becomes its
        // own bucket of one. `%` casts to integer, so this form is exact.
        `SELECT ts - (ts % ?) AS bucket,
                COUNT(*) AS requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(COALESCE(prompt_tokens, 0))     AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                AVG(latency_ms)                     AS avg_latency
           FROM request_logs
          WHERE ts >= ?
          GROUP BY bucket
          ORDER BY bucket ASC`,
      )
      .all(bucketMs, sinceMs) as Row[];

    return rows.map((r) => ({
      bucket: num(r.bucket),
      requests: num(r.requests),
      failures: num(r.failures),
      promptTokens: num(r.prompt_tokens),
      completionTokens: num(r.completion_tokens),
      avgLatencyMs: r.avg_latency === null ? null : Math.round(num(r.avg_latency)),
    }));
  }

  /**
   * The model breakdown ranks the model that actually served each request, not
   * the name the client asked for: a spoof is a client-facing alias, and the
   * figure the operator reads should be the real model behind it. Rows with no
   * served model (a request that matched nothing) keep the requested name, and
   * asked-vs-served stays in the request log.
   */
  byModel(sinceMs: number): BreakdownRow[] {
    return this.breakdown("COALESCE(NULLIF(upstream_model, ''), requested_model)", sinceMs);
  }

  byUpstream(sinceMs: number): BreakdownRow[] {
    return this.breakdown("COALESCE(endpoint_name, 'unrouted')", sinceMs);
  }

  byCredential(sinceMs: number): BreakdownRow[] {
    return this.breakdown("COALESCE(credential_label, 'unknown')", sinceMs);
  }

  byError(sinceMs: number): BreakdownRow[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(error_kind, 'none') AS label,
                COUNT(*) AS requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(COALESCE(prompt_tokens, 0))     AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(total_tokens, 0))      AS total_tokens,
                AVG(latency_ms) AS avg_latency
           FROM request_logs
          WHERE ts >= ? AND success = 0
          GROUP BY label
          ORDER BY requests DESC`,
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => {
      const promptTokens = num(r.prompt_tokens);
      const completionTokens = num(r.completion_tokens);
      return {
        label: String(r.label),
        requests: num(r.requests),
        failures: num(r.failures),
        totalTokens: tokenTotal(promptTokens, completionTokens, num(r.total_tokens)),
        avgLatencyMs: r.avg_latency === null ? null : Math.round(num(r.avg_latency)),
      };
    });
  }

  private breakdown(expr: string, sinceMs: number): BreakdownRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${expr} AS label,
                COUNT(*) AS requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(COALESCE(prompt_tokens, 0))     AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(total_tokens, 0))      AS total_tokens,
                AVG(latency_ms) AS avg_latency
           FROM request_logs
          WHERE ts >= ?
          GROUP BY label
          ORDER BY requests DESC
          LIMIT 50`,
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => {
      const promptTokens = num(r.prompt_tokens);
      const completionTokens = num(r.completion_tokens);
      return {
        label: String(r.label),
        requests: num(r.requests),
        failures: num(r.failures),
        totalTokens: tokenTotal(promptTokens, completionTokens, num(r.total_tokens)),
        avgLatencyMs: r.avg_latency === null ? null : Math.round(num(r.avg_latency)),
      };
    });
  }

  /**
   * Per-day traffic, bucketed by local day.
   *
   * `'localtime'` rather than bare `'unixepoch'` is load-bearing: with a
   * +5:30 offset most traffic lands after 18:30 UTC, so a UTC bucket files
   * ordinary evening use under the following day. The same local rule is
   * applied in `localDayKey` on the other side of the boundary - the SQL and the
   * walk have to agree or a day reads as active in one and missing in the other.
   *
   * Bounded by `sinceMs` so the window matches the pruning window, which is what
   * keeps the streak honest about how far back the log still reaches.
   */
  activityByDay(sinceMs: number): DayActivity[] {
    const rows = this.db
      .prepare(
        `SELECT date(ts/1000,'unixepoch','localtime')       AS day,
                COUNT(*)                                     AS requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes
           FROM request_logs
          WHERE ts >= ?
          GROUP BY day
          ORDER BY day ASC`,
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      day: String(r.day),
      requests: num(r.requests),
      successes: num(r.successes),
    }));
  }

  /**
   * The longest run ever recorded, raised but never lowered.
   *
   * Reads as `MAX(best_days, candidate)` so two concurrent requests can both
   * call this and the larger one still wins - an unconditional write would let
   * the slower of the two overwrite a higher value with a lower one.
   */
  recordBestStreak(candidate: number): number {
    if (candidate <= 0) return this.bestStreak();
    this.db
      .prepare(
        `UPDATE stats_best_streak
            SET best_days = MAX(best_days, ?), updated_at = ?
          WHERE id = 1`,
      )
      .run(candidate, Date.now());
    return this.bestStreak();
  }

  bestStreak(): number {
    const row = this.db.prepare('SELECT best_days FROM stats_best_streak WHERE id = 1').get() as Row | undefined;
    return row ? num(row.best_days) : 0;
  }

  logs(filters: {
    sinceMs?: number;
    model?: string;
    success?: boolean;
    errorKind?: string;
    limit?: number;
    offset?: number;
  }): { rows: Row[]; total: number } {
    const { clause, params } = StatsQueries.logFilter(filters);

    const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
    const offset = Math.max(0, filters.offset ?? 0);

    const total = num((this.db.prepare(`SELECT COUNT(*) AS c FROM request_logs WHERE ${clause}`).get(...params) as Row).c);
    const rows = this.db
      .prepare(`SELECT * FROM request_logs WHERE ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];

    return { rows, total };
  }

  /** Deletes every row the log read would show for the same filters; returns the count removed. */
  deleteLogs(filters: { sinceMs?: number; model?: string; success?: boolean; errorKind?: string }): number {
    const { clause, params } = StatsQueries.logFilter(filters);
    const res = this.db.prepare(`DELETE FROM request_logs WHERE ${clause}`).run(...params);
    return Number(res.changes);
  }

  /**
   * The WHERE clause shared by the log read and the log delete, so "delete what
   * the console shows" cannot disagree with "what the console shows".
   */
  private static logFilter(filters: { sinceMs?: number; model?: string; success?: boolean; errorKind?: string }): {
    clause: string;
    params: Array<string | number>;
  } {
    const where: string[] = ['ts >= ?'];
    const params: Array<string | number> = [filters.sinceMs ?? 0];

    if (filters.model) {
      where.push('requested_model = ?');
      params.push(filters.model);
    }
    if (filters.success !== undefined) {
      where.push('success = ?');
      params.push(filters.success ? 1 : 0);
    }
    if (filters.errorKind) {
      where.push('error_kind = ?');
      params.push(filters.errorKind);
    }

    return { clause: where.join(' AND '), params };
  }

  // ------------------------------------------------------------------- costs
  //
  // Every cost figure is the same kind of SQL aggregate the token figures are,
  // over the snapshot the recorder wrote at request time. The frontend does no
  // summing, so the page and the log cannot disagree.

  /** Shared SELECT over the cost columns for one window. */
  private costAggregate(sinceMs: number, untilMs: number | undefined): Row {
    const clause = untilMs === undefined ? 'ts >= ?' : 'ts >= ? AND ts <= ?';
    const params = untilMs === undefined ? [sinceMs] : [sinceMs, untilMs];
    return this.db
      .prepare(
        `SELECT COUNT(*)                                          AS requests,
                SUM(cost_usd)                                     AS cost,
                SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced,
                SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)     AS unpriced
           FROM request_logs
          WHERE ${clause}`,
      )
      .get(...params) as Row;
  }

  costSummary(sinceMs: number, untilMs?: number): CostSummary {
    const r = this.costAggregate(sinceMs, untilMs);
    const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
    const priced = num(r.priced);
    return {
      costUsd: cost,
      requests: num(r.requests),
      pricedRequests: priced,
      unpricedRequests: num(r.unpriced),
      avgCostPerRequestUsd: cost !== null && priced > 0 ? cost / priced : null,
    };
  }

  costTimeseries(sinceMs: number, bucketMs: number, untilMs?: number): CostTimeseriesPoint[] {
    const clause = untilMs === undefined ? 'ts >= ?' : 'ts >= ? AND ts <= ?';
    const params = untilMs === undefined ? [bucketMs, sinceMs] : [bucketMs, sinceMs, untilMs];
    // `ts - (ts % ?)` rather than `(ts / ?) * ?` - same reason as the token
    // timeseries above: the division form is inexact on doubles.
    const rows = this.db
      .prepare(
        `SELECT ts - (ts % ?) AS bucket,
                COUNT(*)      AS requests,
                SUM(cost_usd) AS cost
           FROM request_logs
          WHERE ${clause}
          GROUP BY bucket
          ORDER BY bucket ASC`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({
      bucket: num(r.bucket),
      requests: num(r.requests),
      costUsd: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    }));
  }

  /**
   * Spend grouped by an arbitrary label expression. The caller passes the
   * expression (a fixed set of constants defined in the routes), so the three
   * breakdowns share one query the way the token breakdowns do.
   */
  costBreakdown(expr: string, sinceMs: number, untilMs?: number): CostBreakdownRow[] {
    const clause = untilMs === undefined ? 'ts >= ?' : 'ts >= ? AND ts <= ?';
    const params = untilMs === undefined ? [sinceMs] : [sinceMs, untilMs];
    const rows = this.db
      .prepare(
        `SELECT ${expr}                                           AS label,
                COUNT(*)                                          AS requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)      AS failures,
                SUM(cost_usd)                                     AS cost,
                SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
                SUM(CASE WHEN COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) > 0
                         THEN COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)
                         ELSE COALESCE(total_tokens, 0) END)      AS combined_tokens
           FROM request_logs
          WHERE ${clause}
          GROUP BY label
          ORDER BY requests DESC
          LIMIT 50`,
      )
      .all(...params) as Row[];
    return rows.map((r) => {
      const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
      const priced = num(r.requests) - num(r.unpriced);
      return {
        label: String(r.label),
        requests: num(r.requests),
        failures: num(r.failures),
        costUsd: cost,
        unpricedRequests: num(r.unpriced),
        avgCostPerRequestUsd: cost !== null && priced > 0 ? cost / priced : null,
        combinedTokens: num(r.combined_tokens),
      };
    });
  }

  /**
   * The newest rows with their cost columns, cursor-paginated by id.
   *
   * Id rather than ts: several rows can share a millisecond, and a ts cursor
   * would either skip or repeat them.
   */
  recentCostRows(limit: number, beforeId?: number): CostRequestRow[] {
    const clause = beforeId !== undefined && beforeId > 0 ? 'WHERE id < ?' : '';
    const params: number[] = beforeId !== undefined && beforeId > 0 ? [beforeId] : [];
    const rows = this.db
      .prepare(
        `SELECT id, ts,
                COALESCE(NULLIF(upstream_model, ''), requested_model) AS model,
                requested_model, endpoint_name, credential_label,
                success, status_code, error_kind, streaming, latency_ms,
                prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
                cost_usd, price_source
           FROM request_logs ${clause}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      ts: num(r.ts),
      model: String(r.model),
      requestedModel: String(r.requested_model),
      endpointName: r.endpoint_name === null || r.endpoint_name === undefined ? null : String(r.endpoint_name),
      credentialLabel: r.credential_label === null || r.credential_label === undefined ? null : String(r.credential_label),
      success: num(r.success) === 1,
      statusCode: r.status_code === null || r.status_code === undefined ? null : num(r.status_code),
      errorKind: r.error_kind === null || r.error_kind === undefined ? null : String(r.error_kind),
      streaming: num(r.streaming) === 1,
      latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : num(r.latency_ms),
      promptTokens: r.prompt_tokens === null || r.prompt_tokens === undefined ? null : num(r.prompt_tokens),
      completionTokens: r.completion_tokens === null || r.completion_tokens === undefined ? null : num(r.completion_tokens),
      cachedTokens: r.cached_tokens === null || r.cached_tokens === undefined ? null : num(r.cached_tokens),
      reasoningTokens: r.reasoning_tokens === null || r.reasoning_tokens === undefined ? null : num(r.reasoning_tokens),
      costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
      priceSource: r.price_source === null || r.price_source === undefined ? null : String(r.price_source),
    }));
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx] as number);
}
