import { loadConfig, REPO_ROOT_DIR } from './env.js';
import { openDatabase, masterKeyPath, unifiedKeyPath } from './db/index.js';
import { loadOrCreateMasterKey } from './core/crypto.js';
import { SettingsStore, resolveBootSettings } from './settings.js';
import { UpstreamStore } from './upstream/store.js';
import { PoolState } from './routing/poolState.js';
import { CostStore } from './stats/costStore.js';
import { PriceSyncService } from './stats/priceSync.js';
import { StatsRecorder } from './stats/recorder.js';
import { StatsQueries } from './stats/queries.js';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDatabase(config.dataDir);
  const masterKey = loadOrCreateMasterKey(masterKeyPath(config.dataDir));

  const settings = new SettingsStore(db, unifiedKeyPath(config.dataDir));
  const { key, created } = settings.ensureUnifiedKey();

  // Settings win over the process config, so a port/host change made in the
  // dashboard takes effect on the next start.
  const { host, port } = resolveBootSettings(settings.all, config);

  const store = new UpstreamStore(db, masterKey);
  const poolState = new PoolState();
  // Built before the recorder: every logged row prices itself against this
  // store's snapshot of what the catalogue said at request time.
  const costStore = new CostStore(db);
  const priceSync = new PriceSyncService(costStore);
  const recorder = new StatsRecorder(db, settings, costStore);
  const queries = new StatsQueries(db);

  const ctx: AppContext = {
    db,
    store,
    settings,
    poolState,
    recorder,
    queries,
    costStore,
    priceSync,
    dataDir: config.dataDir,
    bootstrapUnifiedKey: created ? key : null,
  };

  recorder.startRetentionTimer();

  const app = await buildApp(ctx, { logLevel: config.logLevel, devCors: process.env.NODE_ENV === 'development' });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    priceSync.stop();
    recorder.stop();
    try {
      await app.close();
    } catch {
      /* closing anyway */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Catalogue + FX sync. Fire-and-forget by design - a slow fetch must not
  // delay the proxy coming up, and a failed one leaves the previous prices
  // standing. The dashboard shows the numbers as soon as they land.
  priceSync.start(settings.get('autoSyncPrices'));

  await app.listen({ host, port });

  app.log.info(`dashboard  http://${host}:${port}/`);
  app.log.info(`base url   http://${host}:${port}/v1`);
  app.log.info(`data dir   ${config.dataDir}`);

  // Every start, not just the one that generated it. The key is in the key file
  // now, so there is no reason to make an operator who missed the first banner
  // rotate their way back to a working key.
  if (key) {
    const line = '='.repeat(64);
    console.log(`\n${line}`);
    console.log('  Your unified API key:');
    console.log(`\n    ${key}\n`);
    console.log(`  Also written to ${unifiedKeyPath(config.dataDir)}`);
    console.log('  Point any OpenAI-compatible client at:');
    console.log(`    Base URL : http://${host}:${port}/v1`);
    console.log(`    API Key  : ${key}`);
    console.log(`${line}\n`);
  }

  if (config.openBrowser) {
    void openDashboard(`http://${host}:${port}/`);
  }

  void REPO_ROOT_DIR;
}

/** Best-effort browser launch; failures are non-fatal. */
async function openDashboard(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command[0] as string, command[1] as string[], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // The user can just open the URL manually.
  }
}

main().catch((err) => {
  console.error('Failed to start KeyPool:');
  console.error(err);
  process.exit(1);
});
