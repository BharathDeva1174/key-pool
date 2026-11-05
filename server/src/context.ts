import type { Db } from './db/index.js';
import type { UpstreamStore } from './upstream/store.js';
import type { SettingsStore } from './settings.js';
import type { PoolState } from './routing/poolState.js';
import type { StatsRecorder } from './stats/recorder.js';
import type { StatsQueries } from './stats/queries.js';
import type { CostStore } from './stats/costStore.js';
import type { PriceSyncService } from './stats/priceSync.js';

/** Everything the HTTP layer needs, assembled once during boot. */
export interface AppContext {
  db: Db;
  store: UpstreamStore;
  settings: SettingsStore;
  poolState: PoolState;
  recorder: StatsRecorder;
  queries: StatsQueries;
  dataDir: string;
  /** Shown once at boot / on rotate; never persisted and never returned again. */
  bootstrapUnifiedKey: string | null;
  /**
   * Cost accounting. Optional so a minimal context (a restart-continuity test)
   * can omit the whole subsystem: the costs routes simply do not register and
   * logged rows carry a NULL cost.
   */
  costStore?: CostStore;
  /** The catalogue/FX sync service. Never started by buildApp; boot owns the timers. */
  priceSync?: PriceSyncService;
}
