/**
 * Streak arithmetic, kept pure.
 *
 * "Consecutive days" is the one dashboard figure that cannot be a plain SQL
 * aggregate: a day boundary is a local-time concept, and whether a day counts
 * depends on whether it has finished yet. Both rules live here so they can be
 * tested without a database, the same split `routing/health.ts` uses for the
 * circuit breaker.
 */

/** A day with recorded traffic, as returned by the aggregate in `queries.ts`. */
export interface DayActivity {
  /** `YYYY-MM-DD` in the server's local time. */
  day: string;
  requests: number;
  successes: number;
}

export interface Streak {
  /** Consecutive active days ending today, or ending yesterday if today is still open. */
  current: number;
  /** Whether a successful request has already been recorded today. */
  todayActive: boolean;
  /**
   * The walk reached the oldest day the log still holds, so `current` is a
   * floor rather than a fact: the real run may be longer. The UI says "at
   * least N" rather than asserting precision it does not have.
   */
  truncated: boolean;
  /** Distinct days with traffic across the queried window. */
  totalActiveDays: number;
  /** Total requests across the queried window. */
  totalRequests: number;
  /** Oldest day present in the log, or null when there is no history. */
  oldestDay: string | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * A `YYYY-MM-DD` key in local time.
 *
 * Local, not UTC, and not an accident: the timezone here is +5:30, so most
 * traffic falls after 18:30 UTC and bucketing by UTC would file it under
 * tomorrow. The SQLite aggregate buckets the same way, and the two have to
 * agree or a day reads as active in one and not the other.
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The local day `offset` days before the local day containing `now`. */
function dayKeyOffset(now: number, offset: number): string {
  // Stepping back a fixed 24h and re-reading the local date is correct across a
  // DST boundary in both directions, because the local day is re-derived from
  // the instant rather than from a 24h-wide bucket.
  return localDayKey(now - offset * MS_PER_DAY);
}

/**
 * The current run of consecutive days with at least one success.
 *
 * Two rules, and the second is the one that decides how the feature feels:
 *
 *  - a gap anywhere ends the run;
 *  - **today only counts once a request has been recorded.** A day that has not
 *    happened yet cannot break anything, so the walk starts at yesterday when
 *    today is still empty. Without this, opening the dashboard at 8am would
 *    report a broken streak for a day that is still in progress.
 */
export function computeStreak(days: DayActivity[], now: number): Streak {
  const active = new Set(days.filter((d) => d.successes > 0).map((d) => d.day));
  const totalActiveDays = active.size;
  const totalRequests = days.reduce((sum, d) => sum + d.requests, 0);

  const sorted = [...active].sort();
  const oldestDay = sorted[0] ?? null;
  const today = localDayKey(now);
  const todayActive = active.has(today);

  let current = 0;
  let truncated = false;
  if (totalActiveDays > 0) {
    // Start on the most recent day that can legitimately end a run: today once
    // it has been used, otherwise yesterday.
    let cursor = todayActive ? 0 : 1;
    for (;;) {
      const key = dayKeyOffset(now, cursor);
      if (active.has(key)) {
        current += 1;
        cursor += 1;
        continue;
      }
      // Running out of history is not the same as hitting a gap, and the two
      // look identical from inside the walk: both arrive as a key that is not
      // in the set. The difference is where the missing key sits relative to
      // the oldest day the log still holds. A gap *newer* than that is a real
      // break; a gap *older* than it is the edge of the data, so the run may
      // continue into rows that were pruned.
      if (key < (oldestDay as string)) truncated = true;
      break;
    }
  }

  return { current, todayActive, truncated, totalActiveDays, totalRequests, oldestDay };
}

// ------------------------------------------------------------------- tiers

export interface Tier {
  days: number;
  label: string;
  /** One line on what reaching it meant. Shown on the badge, never scolded. */
  blurb: string;
}

/**
 * Milestones, escalating in value rather than in difficulty.
 *
 * The gaps are wide early and narrow later on purpose: a first win has to
 * arrive quickly or the mechanic reads as a trap, while a long run needs a goal
 * far enough away to stay interesting.
 */
export const TIERS: readonly Tier[] = [
  { days: 3, label: 'Getting started', blurb: 'Three days running.' },
  { days: 7, label: 'Week one', blurb: 'A full week.' },
  { days: 14, label: 'Fortnight', blurb: 'Two weeks unbroken.' },
  { days: 30, label: 'Month', blurb: 'A month of use.' },
  { days: 60, label: 'Two months', blurb: 'Two months in.' },
  { days: 100, label: 'Century', blurb: 'A hundred days.' },
  { days: 365, label: 'Full year', blurb: 'A year of days.' },
] as const;

/** The next tier to reach, or null once the last one is behind you. */
export function nextTier(current: number): Tier | null {
  return TIERS.find((t) => t.days > current) ?? null;
}

/**
 * Every tier already earned.
 *
 * Earned, not current: a broken streak keeps these, which is the whole point.
 * A badge that disappears the moment you miss a day is a punishment wearing a
 * reward's clothes, and the documented failure mode of streak mechanics is
 * exactly that - shame that drives people to abandon the habit rather than
 * restart it.
 */
export function earnedTiers(best: number): Tier[] {
  return TIERS.filter((t) => t.days <= best);
}

/**
 * A calendar heatmap of recent activity, for consistency rather than runs.
 *
 * Twelve weeks is the window GitHub uses for the same reason it works here: it
 * spans three months, so seasonal habits are visible, and it fits a margin
 * column without becoming a full page.
 */
export const HEATMAP_WEEKS = 12;

/*
 * Upper bounds for levels 1-3, so a day needs 5 requests to leave level 1, 20 to
 * leave level 2, and 60 to leave level 3. Written as ceilings rather than floors
 * because the previous shape put the first threshold at 1, which made level 1
 * unreachable: every active day skipped straight to 2 and the quietest cell
 * read the same as a moderately busy one.
 */
const LEVELS = [5, 20, 60] as const;

/** Volume bucket for one cell. 0 is empty; the rest are thresholds on requests. */
export function heatLevel(requests: number): 0 | 1 | 2 | 3 | 4 {
  if (requests <= 0) return 0;
  if (requests < LEVELS[0]) return 1;
  if (requests < LEVELS[1]) return 2;
  if (requests < LEVELS[2]) return 3;
  return 4;
}

/** The last `HEATMAP_WEEKS` weeks, oldest first, ending on the current week. */
export function heatmapRange(now: number): string[] {
  const keys: string[] = [];
  for (let w = HEATMAP_WEEKS - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      keys.push(dayKeyOffset(now, w * 7 + (6 - d)));
    }
  }
  return keys;
}
