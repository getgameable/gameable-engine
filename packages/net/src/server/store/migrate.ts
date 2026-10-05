/**
 * `migrate` — applies the player store's SQL files (`packages/net/sql/*.sql`)
 * that a database has not had yet, in name order, and records each in
 * `schema_migrations`. A room server calls it once at start, before
 * {@link postgresStore}.
 */
import { describeError, loadPg } from './pgConnect.js';

/** Where {@link migrate} reads its SQL and how long it waits to connect. */
export interface MigrateOptions {
  /** The folder of `NNN_name.sql` files. Default: the first `sql/` found (see {@link migrate}). */
  dir?: string;
  /** How long to wait for a connection, in ms. Default 10000. */
  connectTimeoutMs?: number;
}

/** Any number: one lock id every server agrees on, so two servers starting at once migrate one after the other. */
const MIGRATE_LOCK = 13910504;

/** The SQL folder: the bundle's own `sql/` beside it, else `sql/` in the package root above this file. */
async function findDir(): Promise<string> {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  let dir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(dir, 'sql'))) return join(dir, 'sql');
  for (let up = 0; up < 6; up += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'sql')))
      return join(dir, 'sql');
    dir = dirname(dir);
  }
  throw new Error('no sql/ folder beside the bundle or in the package root; pass options.dir');
}

/**
 * Applies the SQL files a database has not had yet, all in one transaction
 * under an advisory lock, and resolves with the names it applied (`[]` when
 * the database was already up to date). Rejects, with the URL's password
 * left out of the message, when it cannot connect or a file fails; a server
 * should not start its store on a half-known schema.
 *
 * The SQL folder is `options.dir`, else a `sql/` folder beside the running
 * file (a bundled server copies `packages/net/sql` there), else the
 * package's own `sql/`.
 *
 * @example
 * ```ts
 * import { migrate, postgresStore } from 'gameable/net/server';
 *
 * const url = process.env.GAMEABLE_PG_URL ?? '';
 * await migrate(url); // { applied: ['001_player_data.sql'] } the first time
 * const store = postgresStore(url);
 * ```
 */
export async function migrate(
  url: string,
  options: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = options.dir ?? (await findDir());
    const files = readdirSync(dir)
      .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
      .sort();
    const pg = await loadPg();
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
    });
    client.on('error', () => {}); // a dropped connection rejects the query in flight; that is the error we report
    await client.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [MIGRATE_LOCK]);
      await client.query(
        'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
      );
      const done = new Set(
        (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
          (r) => r.name,
        ),
      );
      const applied: string[] = [];
      for (const name of files.filter((f) => !done.has(f))) {
        await client.query(readFileSync(join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        applied.push(name);
      }
      await client.query('commit');
      return { applied };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  } catch (error) {
    throw new Error(`player store migrations failed: ${describeError(error, url)}`, {
      cause: error,
    });
  }
}
