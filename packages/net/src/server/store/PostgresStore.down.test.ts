/**
 * The Postgres store when Postgres is not there: every call resolves, nothing
 * throws, and the log never carries the URL's password. Needs no database.
 */
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { postgresStore } from './PostgresStore.js';

const DOWN = 'postgres://aos:hunter2-secret@127.0.0.1:1/aos';

describe('postgres store with no database behind it', () => {
  it('answers null and unavailable, never throws, and keeps the password out of its log', async () => {
    const lines: string[] = [];
    const store = postgresStore(DOWN, { connectTimeoutMs: 500, log: (line) => lines.push(line) });
    const swap = (x: string | null, y: string | null) => ({ a: y ?? '{}', b: x ?? '{}' });
    expect(await store.load('g', 'p')).toBeNull();
    expect(await store.save('g', 'p', '{}', 0)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await store.exchange('g', 'a', 'b', swap, { a: 0, b: 0 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await store.loadGame('g')).toBeNull();
    expect(await store.saveGame('g', '{}', 0)).toEqual({ ok: false, reason: 'unavailable' });
    await store.dispose();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('answers unavailable for a URL that is not a URL, without throwing', async () => {
    const store = postgresStore('not a url at all', { connectTimeoutMs: 500, log: () => {} });
    expect(await store.save('g', 'p', '{}', 0)).toEqual({ ok: false, reason: 'unavailable' });
    await store.dispose();
  });

  it('still refuses size and invalid documents before it reaches for the database', async () => {
    const store = postgresStore(DOWN, { connectTimeoutMs: 500, log: () => {} });
    expect(await store.save('g', 'p', '{', 0)).toEqual({ ok: false, reason: 'invalid' });
    expect(await store.save('g', 'p', JSON.stringify('x'.repeat(70_000)), 0)).toEqual({
      ok: false,
      reason: 'size',
    });
    await store.dispose();
  });

  it('answers unavailable after dispose', async () => {
    const store = postgresStore(DOWN, { log: () => {} });
    await store.dispose();
    expect(await store.save('g', 'p', '{}', 0)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('makes migrate reject with a clear error that carries no password', async () => {
    const error = await migrate(DOWN, { connectTimeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^player store migrations failed: /);
    expect((error as Error).message).not.toContain('hunter2');
  });
});
