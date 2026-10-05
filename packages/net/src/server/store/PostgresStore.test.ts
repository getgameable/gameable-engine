/**
 * The Postgres store against a real Postgres (embedded-postgres, or
 * GAMEABLE_PG_TEST_URL). Skips with one log line when none can start.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from './migrate.js';
import { postgresStore } from './PostgresStore.js';
import { storeContract } from './storeContract.js';
import { storeFromEnv } from './storeFromEnv.js';
import { startTestPostgres } from './testPostgres.js';

const server = await startTestPostgres();

if ('skip' in server) {
  // stderr, not console: vitest drops console output from a file whose tests all skip.
  process.stderr.write(
    `postgres store tests skipped: postgres could not start here (${server.skip})\n`,
  );
  describe.skip('postgres store', () => {
    it('needs a Postgres', () => {});
  });
} else {
  const { url } = server;
  beforeAll(async () => {
    await migrate(url);
  }, 60_000);
  afterAll(async () => {
    await server.stop();
  }, 60_000);

  storeContract('postgres', () => Promise.resolve(postgresStore(url)));

  describe('postgres store: storeFromEnv', () => {
    it('with GAMEABLE_PG_URL: migrates a fresh database and hands back a store that saves', async () => {
      const db = await server.fresh('aos_from_env');
      const store = await storeFromEnv({ GAMEABLE_PG_URL: db }, { log: () => undefined });
      expect(await store.save('g', 'u1', '{"coins":1}', 0)).toEqual({ ok: true, version: 1 });
      expect((await store.load('g', 'u1'))?.version).toBe(1);
      await store.dispose();
    });
  });

  describe('postgres store: migrations', () => {
    it('applies 001 once, records it in schema_migrations, and is a no-op the second time', async () => {
      const db = await server.fresh('aos_migrate_once');
      expect(await migrate(db)).toEqual({ applied: ['001_player_data.sql'] });
      expect(await migrate(db)).toEqual({ applied: [] });
      const client = new pg.Client({ connectionString: db });
      await client.connect();
      const rows = await client.query<{ name: string }>('select name from schema_migrations');
      const tables = await client.query<{ n: string }>(
        "select count(*)::text as n from information_schema.tables where table_name in ('player_data', 'game_data', 'exchanges')",
      );
      await client.end();
      expect(rows.rows.map((r) => r.name)).toEqual(['001_player_data.sql']);
      expect(tables.rows[0]?.n).toBe('3');
    });

    it('lets two servers starting at once both migrate, applying each file once', async () => {
      const db = await server.fresh('aos_migrate_race');
      const [one, two] = await Promise.all([migrate(db), migrate(db)]);
      expect([...one.applied, ...two.applied]).toEqual(['001_player_data.sql']);
    });
  });

  describe('postgres store: pool and timeouts', () => {
    it('answers unavailable when a statement outlives statementTimeoutMs, and stays usable', async () => {
      const store = postgresStore(url, { statementTimeoutMs: 300 });
      const game = `timeout-${String(Date.now())}`;
      expect(await store.save(game, 'p', '{"n":0}', 0)).toEqual({ ok: true, version: 1 });
      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      await holder.query('begin');
      await holder.query('select * from player_data where game = $1 for update', [game]);
      const started = Date.now();
      expect(await store.save(game, 'p', '{"n":1}', 1)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      await holder.query('rollback');
      await holder.end();
      expect(await store.save(game, 'p', '{"n":1}', 1)).toEqual({ ok: true, version: 2 });
      await store.dispose();
    });

    it('opens at most poolSize connections', async () => {
      const applicationName = `aos-pool-${String(Date.now())}`;
      const store = postgresStore(url, { poolSize: 2, applicationName });
      await Promise.all(Array.from({ length: 12 }, (_, i) => store.load('pool', `p${String(i)}`)));
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const open = await client.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where application_name = $1',
        [applicationName],
      );
      await client.end();
      await store.dispose();
      expect(open.rows[0]?.n).toBeGreaterThanOrEqual(1);
      expect(open.rows[0]?.n).toBeLessThanOrEqual(2);
    });

    it('stores the exchange in the ledger with what the room said it was for', async () => {
      const store = postgresStore(url);
      const game = `ledger-${String(Date.now())}`;
      const swap = (x: string | null, y: string | null) => ({ a: y ?? '{}', b: x ?? '{}' });
      await store.exchange(
        game,
        'a',
        'b',
        swap,
        { a: 0, b: 0 },
        { give: '{"coins":3}', take: '["gem"]' },
      );
      await store.dispose();
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const rows = await client.query('select a, b, give, take from exchanges where game = $1', [
        game,
      ]);
      await client.end();
      expect(rows.rows).toEqual([{ a: 'a', b: 'b', give: { coins: 3 }, take: ['gem'] }]);
    });
  });
}
