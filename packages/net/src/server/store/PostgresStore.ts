/**
 * `PostgresStore` — the player store in Postgres (`player_data`, `game_data`,
 * `exchanges`; `packages/net/sql`). Run {@link migrate} first.
 */
import type { Pool, PoolClient } from 'pg';
import { docRefusal } from './docCheck.js';
import { describeError, isInvalidDoc, loadPg } from './pgConnect.js';
import { exchangeTx } from './pgExchange.js';
import { GAME_SQL, PLAYER_SQL, type DocRow } from './pgSql.js';
import type {
  ExchangeApply,
  ExchangeNote,
  ExchangeResult,
  PlayerDoc,
  PlayerStore,
  SaveResult,
} from './types.js';

/** How a {@link PostgresStore} connects. */
export interface PostgresStoreOptions {
  /** Connections in the pool. Default 4. */
  poolSize?: number;
  /** Postgres cancels a statement (a lock wait too) after this many ms; the call answers `unavailable`. Default 5000. */
  statementTimeoutMs?: number;
  /** How long to wait for a connection, in ms. Default 5000. */
  connectTimeoutMs?: number;
  /** `application_name` on every connection, as `pg_stat_activity` shows it. Default `aos-player-store`. */
  applicationName?: string;
  /** Where failures are reported, one line each, never with the password. Default `console.warn`. */
  log?: (line: string) => void;
}

/**
 * A {@link PlayerStore} in Postgres. Every call resolves: an unreachable or
 * slow database answers `unavailable` (or `null` from a load) and logs one
 * line. Saves are compare-and-set on `version`; an exchange is one
 * transaction (see `pgExchange.ts`). `pg` is imported on first use.
 *
 * @example
 * ```ts
 * import { PostgresStore } from 'gameable/net/server';
 *
 * const store = new PostgresStore('postgres://aos@db:5432/rooms', { poolSize: 8 });
 * const saved = await store.save('steal', 'u1', '{"coins":10}', 0);
 * await store.dispose();
 * ```
 */
export class PostgresStore implements PlayerStore {
  private pool: Promise<Pool> | null = null;
  private disposed = false;
  private readonly log: (line: string) => void;

  constructor(
    private readonly url: string,
    private readonly options: PostgresStoreOptions = {},
  ) {
    this.log =
      options.log ??
      ((line) => {
        console.warn(line);
      });
  }

  async load(game: string, player: string): Promise<PlayerDoc | null> {
    return this.read('load', PLAYER_SQL.load, [game, player]);
  }

  async save(
    game: string,
    player: string,
    data: string,
    expectedVersion: number,
  ): Promise<SaveResult> {
    return expectedVersion === 0
      ? this.write('save', data, PLAYER_SQL.create, [game, player, data])
      : this.write('save', data, PLAYER_SQL.update, [game, player, expectedVersion, data]);
  }

  async exchange(
    game: string,
    a: string,
    b: string,
    apply: ExchangeApply,
    expected: { a: number; b: number },
    note?: ExchangeNote,
  ): Promise<ExchangeResult> {
    if (a === b) return { ok: false, reason: 'refused' };
    const run = await this.withClient('exchange', (client) =>
      exchangeTx(client, game, { a, b }, apply, expected, note),
    );
    return run === 'unavailable' || run === 'invalid' ? { ok: false, reason: run } : run;
  }

  async loadGame(game: string): Promise<PlayerDoc | null> {
    return this.read('loadGame', GAME_SQL.load, [game]);
  }

  async saveGame(game: string, data: string, expectedVersion: number): Promise<SaveResult> {
    return expectedVersion === 0
      ? this.write('saveGame', data, GAME_SQL.create, [game, data])
      : this.write('saveGame', data, GAME_SQL.update, [game, expectedVersion, data]);
  }

  /** Closes the pool. Later calls answer `unavailable` without connecting. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.then((p) => p.end()).catch(() => {});
  }

  private async read(what: string, sql: string, values: unknown[]): Promise<PlayerDoc | null> {
    const run = await this.withClient(what, (c) => c.query<DocRow>(sql, values));
    if (typeof run === 'string') return null;
    if (run.rows.length === 0) return null;
    const [row] = run.rows;
    return { version: row.version, data: row.data, savedAt: Math.round(row.saved_at) };
  }

  private async write(
    what: string,
    data: string,
    sql: string,
    values: unknown[],
  ): Promise<SaveResult> {
    const refusal = docRefusal(data);
    if (refusal !== null) return { ok: false, reason: refusal };
    const run = await this.withClient(what, (c) => c.query<{ version: number }>(sql, values));
    if (typeof run === 'string') return { ok: false, reason: run };
    if (run.rows.length === 0) return { ok: false, reason: 'stale' };
    return { ok: true, version: run.rows[0].version };
  }

  /** Runs `work` on a pooled connection; a database failure becomes `unavailable` (or `invalid`) and one log line. */
  private async withClient<T>(
    what: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T | 'unavailable' | 'invalid'> {
    if (this.disposed) return 'unavailable';
    let client: PoolClient | undefined;
    try {
      client = await (await this.connect()).connect();
      const result = await work(client);
      client.release();
      return result;
    } catch (error) {
      client?.release(true); // a connection that failed mid-call is not handed out again
      this.log(`player store: ${what} failed: ${describeError(error, this.url)}`);
      return isInvalidDoc(error) ? 'invalid' : 'unavailable';
    }
  }

  private connect(): Promise<Pool> {
    this.pool ??= loadPg().then((pg) => {
      const o = this.options;
      const pool = new pg.Pool({
        connectionString: this.url,
        max: o.poolSize ?? 4,
        statement_timeout: o.statementTimeoutMs ?? 5_000,
        connectionTimeoutMillis: o.connectTimeoutMs ?? 5_000,
        application_name: o.applicationName ?? 'aos-player-store',
      });
      // An idle connection the server drops emits here; without a listener it would crash the process.
      pool.on('error', (error) => {
        this.log(`player store: idle connection lost: ${describeError(error, this.url)}`);
      });
      return pool;
    });
    const pool = this.pool;
    // A Pool that could not even be built (no pg) is retried on the next call.
    pool.catch(() => {
      if (this.pool === pool) this.pool = null;
    });
    return pool;
  }
}

/**
 * A player store in Postgres at `url`; see {@link PostgresStore}. Connects on
 * first use, so it never throws here.
 *
 * @example
 * ```ts
 * import { migrate, postgresStore } from 'gameable/net/server';
 *
 * const url = process.env.GAMEABLE_PG_URL ?? '';
 * await migrate(url);
 * const store = postgresStore(url, { poolSize: 4, statementTimeoutMs: 5000 });
 * ```
 */
export function postgresStore(url: string, options: PostgresStoreOptions = {}): PostgresStore {
  return new PostgresStore(url, options);
}
