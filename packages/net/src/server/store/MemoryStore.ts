/**
 * `MemoryStore` — the player store in one process's memory: Play Solo, tests,
 * and a room server started without `GAMEABLE_PG_URL`. Nothing survives a restart.
 */
import { docRefusal, runApply } from './docCheck.js';
import type { ExchangeApply, ExchangeResult, PlayerDoc, PlayerStore, SaveResult } from './types.js';

/**
 * A {@link PlayerStore} in a `Map`. Every method does its check and its write
 * in one synchronous step, so concurrent calls settle exactly as they would
 * on a database: the first write at a version wins, the rest are `stale`.
 *
 * @example
 * ```ts
 * import { MemoryStore } from 'gameable/net/server';
 *
 * const store = new MemoryStore();
 * const saved = await store.save('steal', 'u1', '{"coins":10}', 0); // { ok: true, version: 1 }
 * ```
 */
export class MemoryStore implements PlayerStore {
  private readonly players = new Map<string, PlayerDoc>();
  private readonly games = new Map<string, PlayerDoc>();
  private disposed = false;

  load(game: string, player: string): Promise<PlayerDoc | null> {
    return Promise.resolve(copy(this.players.get(key(game, player))));
  }

  save(game: string, player: string, data: string, expectedVersion: number): Promise<SaveResult> {
    return Promise.resolve(this.write(this.players, key(game, player), data, expectedVersion));
  }

  exchange(
    game: string,
    a: string,
    b: string,
    apply: ExchangeApply,
    expected: { a: number; b: number },
  ): Promise<ExchangeResult> {
    return Promise.resolve(this.swap(game, a, b, apply, expected));
  }

  loadGame(game: string): Promise<PlayerDoc | null> {
    return Promise.resolve(copy(this.games.get(game)));
  }

  saveGame(game: string, data: string, expectedVersion: number): Promise<SaveResult> {
    return Promise.resolve(this.write(this.games, game, data, expectedVersion));
  }

  /** Drops every document; later writes answer `unavailable`. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.players.clear();
    this.games.clear();
    return Promise.resolve();
  }

  private write(
    docs: Map<string, PlayerDoc>,
    id: string,
    data: string,
    expectedVersion: number,
  ): SaveResult {
    if (this.disposed) return { ok: false, reason: 'unavailable' };
    const refusal = docRefusal(data);
    if (refusal !== null) return { ok: false, reason: refusal };
    if ((docs.get(id)?.version ?? 0) !== expectedVersion) return { ok: false, reason: 'stale' };
    const version = expectedVersion + 1;
    docs.set(id, { version, data, savedAt: Date.now() });
    return { ok: true, version };
  }

  private swap(
    game: string,
    a: string,
    b: string,
    apply: ExchangeApply,
    expected: { a: number; b: number },
  ): ExchangeResult {
    if (this.disposed) return { ok: false, reason: 'unavailable' };
    if (a === b) return { ok: false, reason: 'refused' };
    const docA = this.players.get(key(game, a));
    const docB = this.players.get(key(game, b));
    if ((docA?.version ?? 0) !== expected.a || (docB?.version ?? 0) !== expected.b) {
      return { ok: false, reason: 'stale' };
    }
    const next = runApply(apply, docA?.data ?? null, docB?.data ?? null);
    if (typeof next === 'string') return { ok: false, reason: next };
    const savedAt = Date.now();
    const versions = { a: expected.a + 1, b: expected.b + 1 };
    this.players.set(key(game, a), { version: versions.a, data: next.a, savedAt });
    this.players.set(key(game, b), { version: versions.b, data: next.b, savedAt });
    return { ok: true, versions };
  }
}

/**
 * A player store in this process's memory; see {@link MemoryStore}.
 *
 * @example
 * ```ts
 * import { memoryStore } from 'gameable/net/server';
 *
 * const store = memoryStore();
 * const doc = await store.load('steal', 'u1'); // null: nothing saved yet
 * ```
 */
export function memoryStore(): MemoryStore {
  return new MemoryStore();
}

/** The map key of one player in one game; the separator is U+0000, which a Postgres text id cannot hold either. */
function key(game: string, player: string): string {
  return `${game}\u0000${player}`;
}

function copy(doc: PlayerDoc | undefined): PlayerDoc | null {
  return doc === undefined ? null : { ...doc };
}
