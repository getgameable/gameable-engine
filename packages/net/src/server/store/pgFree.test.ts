import { describe, expect, it, vi } from 'vitest';

// Counts every load of pg and lets the real module through.
const pgLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('pg', async (importOriginal) => {
  pgLoads.count += 1;
  return importOriginal();
});

describe('pg in the server entry', () => {
  it('is not loaded by importing the server entry or using the memory store', async () => {
    const server = await import('../index.js');
    const store = server.memoryStore();
    await store.save('g', 'p', '{}', 0);
    expect(typeof server.postgresStore).toBe('function');
    expect(pgLoads.count).toBe(0);
  }, 30_000); // a cold import of the server entry's graph: over 5 s in a loaded full run, as in wsFree.test.ts

  it("is loaded on a Postgres store's first call (positive control for the zero above)", async () => {
    const { postgresStore } = await import('../index.js');
    const store = postgresStore('postgres://127.0.0.1:1/none', {
      connectTimeoutMs: 200,
      log: () => {},
    });
    expect(pgLoads.count).toBe(0);
    await store.load('g', 'p');
    await store.dispose();
    expect(pgLoads.count).toBeGreaterThan(0);
  }, 30_000);
});
