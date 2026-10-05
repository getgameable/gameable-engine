/**
 * The player store's contract: a versioned JSON document per player per game,
 * one per game for the game itself, and an atomic exchange between two
 * players. Only the authority writes; a room that holds an older version than
 * the store is refused (`stale`) and never overwrites the newer document.
 */

/**
 * The largest document a store accepts, in UTF-8 bytes of its JSON text.
 *
 * @example
 * ```ts
 * import { MAX_DOC_BYTES } from 'gameable/net/server';
 *
 * const fits = new TextEncoder().encode(JSON.stringify({ coins: 10 })).length <= MAX_DOC_BYTES;
 * ```
 */
export const MAX_DOC_BYTES = 65536;

/** One stored document. */
export interface PlayerDoc {
  /** Starts at 1 and goes up by one on every write; 0 means "no document yet". */
  version: number;
  /** The game's JSON text. A store may re-format it (Postgres `jsonb` does); parse it, never compare the text. */
  data: string;
  /** When it was last written, in ms since the epoch, by the store's clock. */
  savedAt: number;
}

/**
 * Why a write was refused:
 * - `stale`: the expected version is not the stored one; nothing was written;
 * - `size`: a document is over {@link MAX_DOC_BYTES};
 * - `invalid`: a document is not JSON (or not JSON Postgres can store, such as `\u0000` in a string);
 * - `unavailable`: the store could not be reached or timed out. The write may not have happened.
 */
export type WriteRefusal = 'stale' | 'size' | 'invalid' | 'unavailable';

/** What a save returns: the new version, or why nothing was written. */
export type SaveResult = { ok: true; version: number } | { ok: false; reason: WriteRefusal };

/**
 * What an exchange returns: both new versions, or why neither document
 * changed. `refused` means the exchange's own `apply` said no (returned
 * `null` or threw), or `a` and `b` were the same player.
 */
export type ExchangeResult =
  | { ok: true; versions: { a: number; b: number } }
  | { ok: false; reason: WriteRefusal | 'refused' };

/**
 * The exchange's rule: given both current documents (`null` when a player has
 * none), the two new documents, or `null` to refuse. It must be synchronous
 * and pure: a store may call it while it holds both players' rows locked.
 */
export type ExchangeApply = (
  docA: string | null,
  docB: string | null,
) => { a: string; b: string } | null;

/** What an exchange was for, kept by stores that keep a ledger (Postgres's `exchanges` table). JSON text. */
export interface ExchangeNote {
  give: string;
  take: string;
}

/**
 * Where player documents live. Every method resolves; none rejects. A store
 * that cannot be reached answers `unavailable` (or `null` from a load, after
 * logging), so a room never crashes on it.
 */
export interface PlayerStore {
  /** The player's document in this game, or `null` when there is none (or the store is unreachable). */
  load(game: string, player: string): Promise<PlayerDoc | null>;
  /** Writes the document if the stored version is `expectedVersion` (0 for a new document). */
  save(game: string, player: string, data: string, expectedVersion: number): Promise<SaveResult>;
  /**
   * Changes two players' documents together, or neither: both stored versions
   * must equal `expected`, and `apply` decides the new documents.
   */
  exchange(
    game: string,
    a: string,
    b: string,
    apply: ExchangeApply,
    expected: { a: number; b: number },
    note?: ExchangeNote,
  ): Promise<ExchangeResult>;
  /** The game's own document, or `null`. */
  loadGame(game: string): Promise<PlayerDoc | null>;
  /** Writes the game's own document if its stored version is `expectedVersion`. */
  saveGame(game: string, data: string, expectedVersion: number): Promise<SaveResult>;
  /** Releases what the store holds (a connection pool). Later calls answer `unavailable`. */
  dispose(): Promise<void>;
}
