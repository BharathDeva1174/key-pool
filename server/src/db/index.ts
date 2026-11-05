import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;

/**
 * Opens (creating if needed) the SQLite database, applies pragmas and runs
 * pending migrations. Uses Node's built-in `node:sqlite` so there is no native
 * module to compile - the usual Windows install failure mode.
 */
export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'data.sqlite');
  const db = new DatabaseSync(file);

  // WAL keeps readers from blocking the single writer; NORMAL sync is the
  // right durability trade-off for usage telemetry we can afford to lose.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number((r as { version: number }).version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${String(err)}`);
    }
  }
}

/** Resolves the on-disk location of the database for the given data dir. */
export function databasePath(dataDir: string): string {
  return join(dataDir, 'data.sqlite');
}

/** Resolves the on-disk location of the master key for the given data dir. */
export function masterKeyPath(dataDir: string): string {
  return join(dataDir, 'master.key');
}

/**
 * Resolves the on-disk location of the unified client key for the given data
 * dir. The database only ever holds the hash; this file is the plaintext.
 */
export function unifiedKeyPath(dataDir: string): string {
  return join(dataDir, 'unified-key.txt');
}
