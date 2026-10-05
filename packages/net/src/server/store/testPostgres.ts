/**
 * A Postgres for the store's tests: `GAMEABLE_PG_TEST_URL` when it is set (never
 * `GAMEABLE_PG_URL`, which is a real server's database), else a throwaway
 * `embedded-postgres` cluster in a temp folder on a free port. When neither
 * can start (no binaries for this platform, or running as root, which
 * Postgres refuses), it says why in one line and the tests skip.
 * Test-only: nothing exports it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/** A running test database server. */
export interface TestPostgres {
  /** The URL of the shared test database. */
  url: string;
  /** Creates an empty database and returns its URL. */
  fresh(name: string): Promise<string>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function createDb(url: string, name: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`drop database if exists "${name}"`);
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
  return withDatabase(url, name);
}

/** Starts (or finds) a test Postgres, or answers why it cannot. */
export async function startTestPostgres(): Promise<TestPostgres | { skip: string }> {
  const given = process.env['GAMEABLE_PG_TEST_URL'];
  if (given) {
    return { url: given, fresh: (name) => createDb(given, name), stop: async () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), 'aos-pg-'));
  let server: EmbeddedPostgres | undefined;
  try {
    const { default: Embedded } = await import('embedded-postgres');
    const port = await freePort();
    server = new Embedded({
      databaseDir: dir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
    const running = server;
    const root = `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`;
    const url = await createDb(root, 'aos_store_test');
    return {
      url,
      fresh: (name) => createDb(root, name),
      stop: async () => {
        await running.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    return {
      skip: error instanceof Error ? (error.message.split('\n')[0] ?? 'unknown') : String(error),
    };
  }
}
