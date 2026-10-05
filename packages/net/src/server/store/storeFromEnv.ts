/**
 * `storeFromEnv` — the room server's player store from its environment:
 * Postgres when `GAMEABLE_PG_URL` is set (migrated first), else memory.
 */
import { MemoryStore } from './MemoryStore.js';
import { migrate } from './migrate.js';
import { PostgresStore } from './PostgresStore.js';
import type { PlayerStore } from './types.js';

/**
 * What {@link storeFromEnv} takes besides the environment.
 *
 * @example
 * ```ts
 * import type { StoreFromEnvOptions } from 'gameable/net/server';
 *
 * const options: StoreFromEnvOptions = { log: (line) => console.warn(line) };
 * ```
 */
export interface StoreFromEnvOptions {
  /** Where the memory-store warning and the store's failures go. Default `console.warn`. */
  log?: (line: string) => void;
  /** The SQL folder; default `migrate`'s (the `sql/` beside the bundle, or the package's). */
  sqlDir?: string;
  /** How long `migrate` waits to connect, in ms. Default 10000. */
  connectTimeoutMs?: number;
}

/**
 * Build the player store a room server runs on. With `GAMEABLE_PG_URL` it runs
 * `migrate` once and returns a Postgres store; a database it cannot reach or
 * migrate rejects, so the server does not start on a store it cannot use.
 * Without it the store is in memory, and one warning says that nothing
 * survives a restart. No message ever carries the URL's password.
 *
 * @param env The environment, such as `process.env`.
 * @param options Where warnings go, the SQL folder and the connect timeout.
 * @returns The store; the caller disposes it.
 * @throws {Error} When `GAMEABLE_PG_URL` is not a `postgres://` URL, or the migrations fail.
 *
 * @example
 * ```ts
 * import { storeFromEnv } from 'gameable/net/server';
 *
 * const store = await storeFromEnv(process.env); // Postgres, or memory with a warning
 * ```
 */
export async function storeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: StoreFromEnvOptions = {},
): Promise<PlayerStore> {
  const log =
    options.log ??
    ((line: string) => {
      console.warn(line);
    });
  const url = env.GAMEABLE_PG_URL?.trim() ?? '';
  if (url === '') {
    log(
      'gameable: GAMEABLE_PG_URL is not set: player data is kept in memory and lost when the server stops',
    );
    return new MemoryStore();
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      'GAMEABLE_PG_URL must be a postgres:// URL (postgres://user:password@host:5432/db)',
    );
  }
  await migrate(url, { dir: options.sqlDir, connectTimeoutMs: options.connectTimeoutMs });
  return new PostgresStore(url, { log });
}
