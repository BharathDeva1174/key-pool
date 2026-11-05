/**
 * One auto-refresh for every surface that shows live numbers.
 *
 * The dashboard and the Stats page both poll the stats API while they are
 * open, so a request that finishes in another terminal shows up on screen
 * within seconds without a reload. Keeping the cadence here stops one page
 * from being the one that forgot to refresh.
 */
import { useEffect, useRef } from 'react';

/**
 * How often the stats surfaces re-read their aggregates.
 *
 * Short enough that the server's own drain interval plus one poll lands well
 * inside "a few seconds", long enough that an open tab is not hammering the API.
 */
export const STATS_REFRESH_MS = 3_000;

/**
 * Re-runs `refresh` on an interval for as long as the page is mounted.
 *
 * A refresh that is still running when the next tick lands is skipped rather
 * than stacked, so a slow response can never pile up requests or land out of
 * order and show stale numbers last.
 */
export function useAutoRefresh(refresh: () => Promise<void>, intervalMs: number = STATS_REFRESH_MS, enabled = true): void {
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await latest.current();
      } finally {
        running = false;
      }
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
