import { describe, expect, it } from 'vitest';

import { MemoryStore } from './MemoryStore.js';
import { storeFromEnv } from './storeFromEnv.js';

describe('storeFromEnv', () => {
  it('without GAMEABLE_PG_URL: a memory store, and one warning that says so', async () => {
    const lines: string[] = [];
    const store = await storeFromEnv({}, { log: (line) => lines.push(line) });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/GAMEABLE_PG_URL is not set.*memory/);
  });

  it('with a database it cannot reach: rejects with a clear message and never the password', async () => {
    const url = 'postgres://aos:s3cr3t-pa55@127.0.0.1:1/rooms';
    const error = await storeFromEnv(
      { GAMEABLE_PG_URL: url },
      { log: () => undefined, connectTimeoutMs: 2000 },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/player store migrations failed/);
    expect(error?.message).not.toContain('s3cr3t-pa55');
  });

  it('refuses an GAMEABLE_PG_URL that is not a postgres URL, without echoing it', async () => {
    await expect(
      storeFromEnv({ GAMEABLE_PG_URL: 'db.internal:5432' }, { log: () => undefined }),
    ).rejects.toThrow(/GAMEABLE_PG_URL must be a postgres:\/\/ URL/);
  });
});
