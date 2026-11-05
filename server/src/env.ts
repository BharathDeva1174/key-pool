import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface ServerConfig {
  /** Interface to bind. Defaults to loopback so the proxy is not network-exposed. */
  host: string;
  /** Port for the single process serving both the dashboard and /v1. */
  port: number;
  /** Directory holding data.sqlite and master.key. */
  dataDir: string;
  logLevel: string;
  /** Open the dashboard in the default browser once listening. */
  openBrowser: boolean;
  /**
   * Whether host/port came from a CLI flag or environment variable.
   *
   * Settings persist a port and a bind address, but they are also pre-seeded
   * with defaults - so without this flag a stored default would silently beat
   * an explicit `--port` on the command line.
   */
  portExplicit: boolean;
  hostExplicit: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/ -> server/ -> repo root
const REPO_ROOT = resolve(HERE, '..', '..');

function readArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function toPort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/**
 * Resolves process configuration from CLI args first, then environment, then
 * defaults. Port/host can be overridden again by Settings once the database is
 * open - see `resolveBootSettings`.
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const hostArg = readArg(argv, 'host');
  const portArg = readArg(argv, 'port');
  return {
    host: hostArg ?? env.KEYPOOL_HOST ?? '127.0.0.1',
    port: toPort(portArg ?? env.PORT, 20121),
    dataDir: resolve(env.KEYPOOL_DATA_DIR ?? resolve(REPO_ROOT, 'data')),
    logLevel: env.KEYPOOL_LOG_LEVEL ?? 'info',
    openBrowser: hasFlag(argv, 'open'),
    portExplicit: portArg !== undefined || env.PORT !== undefined,
    hostExplicit: hostArg !== undefined || env.KEYPOOL_HOST !== undefined,
  };
}

export const REPO_ROOT_DIR = REPO_ROOT;
