/**
 * `storeContract` — the shared tests every {@link PlayerStore} must pass.
 * Saves are here; exchanges are in `contractExchanges.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractExchanges } from './contractExchanges.js';
import { MAX_DOC_BYTES, type PlayerStore } from './types.js';

/** What each contract test gets: a fresh store and a game name no other test uses. */
export interface ContractScope {
  store: PlayerStore;
  game: string;
}

let games = 0;

/** Parses a stored document's text; stores may re-format JSON, so tests compare values. */
export function parsed(doc: { data: string } | null): unknown {
  return doc === null ? null : JSON.parse(doc.data);
}

/**
 * Registers the store contract as a `describe` block. `make` is called before
 * every test and the store is disposed after it; every test uses its own game
 * name, so a store backed by a shared database needs no cleaning between tests.
 *
 * Not exported from any entry: it imports vitest, which no published bundle
 * should carry. A new store in this package runs it from its own test file.
 *
 * @example
 * ```ts
 * import { memoryStore } from './MemoryStore.js';
 * import { storeContract } from './storeContract.js';
 *
 * storeContract('memory', async () => memoryStore());
 * ```
 */
export function storeContract(name: string, make: () => Promise<PlayerStore>): void {
  describe(`player store contract: ${name}`, () => {
    const scope = {} as ContractScope;
    beforeEach(async () => {
      scope.store = await make();
      games += 1;
      scope.game = `g${String(process.pid)}-${String(Date.now())}-${String(games)}`;
    });
    afterEach(async () => {
      await scope.store.dispose();
    });

    it('loads null for a player it has never seen', async () => {
      expect(await scope.store.load(scope.game, 'nobody')).toBeNull();
    });

    it('creates version 1 from a save at expected version 0', async () => {
      const before = Date.now();
      expect(await scope.store.save(scope.game, 'p1', '{"coins":10}', 0)).toEqual({
        ok: true,
        version: 1,
      });
      const doc = await scope.store.load(scope.game, 'p1');
      expect(doc?.version).toBe(1);
      expect(parsed(doc)).toEqual({ coins: 10 });
      expect(doc?.savedAt).toBeGreaterThanOrEqual(before - 1000);
    });

    it('refuses a stale save and keeps the newer document (Review Focus 4)', async () => {
      await scope.store.save(scope.game, 'p1', '{"coins":10}', 0);
      expect(await scope.store.save(scope.game, 'p1', '{"coins":0}', 0)).toEqual({
        ok: false,
        reason: 'stale',
      });
      expect(await scope.store.save(scope.game, 'p1', '{"coins":0}', 7)).toEqual({
        ok: false,
        reason: 'stale',
      });
      const doc = await scope.store.load(scope.game, 'p1');
      expect(doc?.version).toBe(1);
      expect(parsed(doc)).toEqual({ coins: 10 });
      expect(await scope.store.save(scope.game, 'p1', '{"coins":11}', 1)).toEqual({
        ok: true,
        version: 2,
      });
    });

    it('refuses a save at a version for a player with no document', async () => {
      expect(await scope.store.save(scope.game, 'p1', '{}', 1)).toEqual({
        ok: false,
        reason: 'stale',
      });
      expect(await scope.store.load(scope.game, 'p1')).toBeNull();
    });

    it('refuses a 70 KB document with size and writes nothing', async () => {
      const big = JSON.stringify({ blob: 'x'.repeat(70 * 1024) });
      expect(await scope.store.save(scope.game, 'p1', big, 0)).toEqual({
        ok: false,
        reason: 'size',
      });
      expect(await scope.store.load(scope.game, 'p1')).toBeNull();
      const edge = JSON.stringify({ b: 'é'.repeat((MAX_DOC_BYTES - 8) / 2 + 1) }); // under the cap in chars, over it in bytes
      expect(await scope.store.save(scope.game, 'p1', edge, 0)).toEqual({
        ok: false,
        reason: 'size',
      });
    });

    it('refuses text that is not JSON with invalid', async () => {
      expect(await scope.store.save(scope.game, 'p1', '{coins', 0)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(await scope.store.save(scope.game, 'p1', '"a\\u0000b"', 0)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(await scope.store.load(scope.game, 'p1')).toBeNull();
    });

    it('keeps games apart: the same player id in two games is two documents', async () => {
      await scope.store.save(scope.game, 'p1', '{"in":"one"}', 0);
      expect(await scope.store.load(`${scope.game}-other`, 'p1')).toBeNull();
      expect(await scope.store.loadGame(scope.game)).toBeNull();
    });

    it('lets exactly one of two saves in flight at the same version win', async () => {
      await scope.store.save(scope.game, 'p1', '{"n":0}', 0);
      const results = await Promise.all([
        scope.store.save(scope.game, 'p1', '{"n":1}', 1),
        scope.store.save(scope.game, 'p1', '{"n":2}', 1),
      ]);
      expect(results.filter((r) => r.ok)).toEqual([{ ok: true, version: 2 }]);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'stale' }]);
      const winner = results[0].ok ? { n: 1 } : { n: 2 };
      expect(parsed(await scope.store.load(scope.game, 'p1'))).toEqual(winner);
    });

    it('lets exactly one of two first saves in flight win', async () => {
      const results = await Promise.all([
        scope.store.save(scope.game, 'p1', '{"n":1}', 0),
        scope.store.save(scope.game, 'p1', '{"n":2}', 0),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await scope.store.load(scope.game, 'p1'))?.version).toBe(1);
    });

    it("versions the game's own document the same way", async () => {
      expect(await scope.store.loadGame(scope.game)).toBeNull();
      expect(await scope.store.saveGame(scope.game, '{"day":1}', 0)).toEqual({
        ok: true,
        version: 1,
      });
      expect(await scope.store.saveGame(scope.game, '{"day":9}', 0)).toEqual({
        ok: false,
        reason: 'stale',
      });
      const big = JSON.stringify({ blob: 'x'.repeat(70 * 1024) });
      expect(await scope.store.saveGame(scope.game, big, 1)).toEqual({ ok: false, reason: 'size' });
      const doc = await scope.store.loadGame(scope.game);
      expect(doc?.version).toBe(1);
      expect(parsed(doc)).toEqual({ day: 1 });
      expect(await scope.store.load(scope.game, '')).toBeNull();
    });

    contractExchanges(scope);
  });
}
