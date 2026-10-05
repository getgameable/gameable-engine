/**
 * `RoomData` — a room's player documents and game document in its store:
 * loaded at join, saved behind a throttle, flushed on leave and dispose, and
 * traded between two players. It is the server adapter's data sink.
 *
 * Every store call is ordered per store key (a rejoin's load waits for the
 * leave's write) and nothing here throws or rejects: a store that refuses or
 * fails is logged and the room keeps running.
 */
import { applyTransfer, type ExchangeCmd, type GameEvent } from '@gameable/sdk';
import type { DataSink } from '@gameable/wasm-host/server';

import type { ExchangeApply, PlayerStore } from '../../store/index.js';
import { DocSlot, type SlotPorts } from './DocSlot.js';

/**
 * At most one write per document per this many ms.
 *
 * @example
 * ```ts
 * import { SAVE_THROTTLE_MS } from 'gameable/net/server';
 *
 * const perMinute = 60_000 / SAVE_THROTTLE_MS; // 10 writes a minute per player, at most
 * ```
 */
export const SAVE_THROTTLE_MS = 6000;

/** The key the game's own document is queued under; no player id has a `#`. */
const GAME_KEY = '#game';

/**
 * What a room's data takes.
 *
 * @example
 * ```ts
 * import { memoryStore, type RoomDataOptions } from 'gameable/net/server';
 *
 * const options: RoomDataOptions = { store: memoryStore(), game: 'steal' };
 * ```
 */
export interface RoomDataOptions {
  /** Where the documents live. */
  readonly store: PlayerStore;
  /** The game's name: documents are kept per game. */
  readonly game: string;
  /** Where refusals and failures are logged. Default `console.warn`. */
  readonly log?: (line: string) => void;
  /** Ms between two writes of one document. Default {@link SAVE_THROTTLE_MS}. */
  readonly throttleMs?: number;
  /** The server's clock, ms since the epoch, stamped on every join as `now`. Default `Date.now`. */
  readonly now?: () => number;
}

/** {@link RoomDataOptions} plus where events for the guest's next step go. */
export interface RoomDataPorts extends RoomDataOptions {
  /** Hand an event to the guest's next step. */
  readonly push: (event: GameEvent) => void;
}

/**
 * @param json A document or null.
 * @returns It parsed, or null.
 */
function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * A room's documents. `EngineRoomGame` builds one from its `data` option and
 * hands it to the server adapter as the data sink.
 *
 * @example
 * ```ts
 * import { memoryStore, RoomData } from 'gameable/net/server';
 *
 * const data = new RoomData({ store: memoryStore(), game: 'steal', push: (e) => adapter.events.push(e) });
 * const envelope = await data.join(0, 'u1'); // '{"doc":{...},"savedAt":...,"now":...}'
 * data.savePlayer(0, '{"coins":11}');
 * await data.leave(0); // written
 * ```
 */
export class RoomData implements DataSink {
  private readonly seats = new Map<number, DocSlot>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly ports: SlotPorts;
  private readonly gameSlot: DocSlot;
  private readonly log: (line: string) => void;
  private closed = false;

  /** @param options The store, the game's name, the event push and the log. */
  constructor(private readonly options: RoomDataPorts) {
    this.log =
      options.log ??
      ((line) => {
        console.warn(line);
      });
    this.ports = {
      throttleMs: options.throttleMs ?? SAVE_THROTTLE_MS,
      queue: (key, work) => this.queue(key, work),
      write: (slot, doc) => this.write(slot, doc),
    };
    this.gameSlot = new DocSlot(GAME_KEY, this.ports);
  }

  /**
   * Load the game's own document; when there is one, the guest gets a `game-data` event.
   *
   * @returns Settles once loaded (or failed, logged).
   */
  start(): Promise<void> {
    return this.queue(GAME_KEY, async () => {
      const doc = await this.options.store.loadGame(this.options.game);
      this.gameSlot.version = doc?.version ?? 0;
      if (doc !== null) this.push({ tag: 'game-data', val: { data: doc.data } });
    });
  }

  /**
   * A player took a seat: load their document.
   *
   * @param player The seat.
   * @param key Their store key (identity id, or a per-seat key).
   * @returns `{ doc, savedAt, now }` as JSON: `doc` and `savedAt` are `null` for
   *   no document (or an unreachable store), and `now` is the server's clock
   *   once loaded, so the guest can measure offline time. Undefined when the
   *   seat was left before the load finished.
   */
  async join(player: number, key: string): Promise<string | undefined> {
    const slot = new DocSlot(key, this.ports);
    this.seats.set(player, slot);
    let doc: unknown = null;
    let savedAt: number | null = null;
    await this.queue(key, async () => {
      const stored = await this.options.store.load(this.options.game, key);
      slot.version = stored?.version ?? 0;
      if (stored !== null) {
        doc = JSON.parse(stored.data) as unknown;
        savedAt = stored.savedAt;
      }
    });
    if (this.seats.get(player) !== slot) return undefined;
    return JSON.stringify({ doc, savedAt, now: (this.options.now ?? Date.now)() });
  }

  /**
   * A seat was freed: write what is pending.
   *
   * @param player The seat.
   * @returns Settles once written.
   */
  leave(player: number): Promise<void> {
    const slot = this.seats.get(player);
    this.seats.delete(player);
    return slot?.flush() ?? Promise.resolve();
  }

  /**
   * @param player A seated player.
   * @param data Their document as JSON.
   */
  savePlayer(player: number, data: string): void {
    const slot = this.seats.get(player);
    if (slot === undefined)
      this.log(`gameable: store: save for seat ${String(player)} dropped: no player there`);
    else slot.save(data);
  }

  /** @param data The game's document as JSON. */
  saveGame(data: string): void {
    this.gameSlot.save(data);
  }

  /**
   * Trade between two seats' documents in the store, all or nothing. Pending
   * saves are written first; saves made while it runs predate the guest's
   * view of the result and are dropped (the guest saves the traded documents).
   *
   * @param cmd The guest's command, read now (it is pooled).
   */
  exchange(cmd: ExchangeCmd): void {
    const { id, give, take } = cmd;
    const a = this.seats.get(cmd.a);
    const b = this.seats.get(cmd.b);
    if (a === undefined || b === undefined) {
      queueMicrotask(() => {
        this.result(id, false, 'unknown-player', null);
      });
      return;
    }
    // The documents the store wrote, handed back so the guest adopts them as they are.
    let written: { a: string; b: string } | null = null;
    const apply: ExchangeApply = (docA, docB) => {
      const out = applyTransfer(parse(docA), parse(docB), parse(give), parse(take));
      written = out === null ? null : { a: JSON.stringify(out.a), b: JSON.stringify(out.b) };
      return written;
    };
    const flushed = Promise.all([a.flush(), b.flush()]);
    const run = flushed
      .then(async () => {
        const store = this.options.store;
        const expected = { a: a.version, b: b.version };
        const out = await store.exchange(this.options.game, a.key, b.key, apply, expected, {
          give,
          take,
        });
        if (out.ok) {
          a.version = out.versions.a;
          b.version = out.versions.b;
          a.drop();
          b.drop();
        } else {
          this.log(`gameable: store: exchange ${String(id)} refused (${out.reason})`);
        }
        this.result(id, out.ok, out.ok ? '' : out.reason, out.ok ? written : null);
      })
      .catch((error: unknown) => {
        this.log(`gameable: store: exchange ${String(id)} failed: ${String(error)}`);
        this.result(id, false, 'unavailable', null);
      });
    this.tails.set(a.key, run);
    this.tails.set(b.key, run);
  }

  /**
   * The room is closing: write everything pending. Events stop.
   *
   * @returns Settles once every write has.
   */
  async dispose(): Promise<void> {
    this.closed = true;
    const slots = [...this.seats.values(), this.gameSlot];
    this.seats.clear();
    await Promise.all(slots.map((slot) => slot.flush()));
  }

  /** @param event For the guest's next step, unless the room has closed. */
  private push(event: GameEvent): void {
    if (!this.closed) this.options.push(event);
  }

  /**
   * @param id The exchange.
   * @param ok Whether it happened.
   * @param reason Why not; empty when it did.
   * @param docs Both documents as written, when it happened.
   */
  private result(
    id: number,
    ok: boolean,
    reason: string,
    docs: { a: string; b: string } | null,
  ): void {
    const aData = docs?.a ?? '';
    const bData = docs?.b ?? '';
    this.push({
      tag: 'exchange-result',
      val: { id, ok: ok && docs !== null, reason, aData, bData },
    });
  }

  /**
   * @param key A store key.
   * @param work Store calls for that key.
   * @returns Settles after `work` and everything queued before it; never rejects.
   */
  private queue(key: string, work: () => Promise<void>): Promise<void> {
    const tail = (this.tails.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      this.log(
        `gameable: store: ${key === GAME_KEY ? 'the game document' : 'a player document'} failed: ${String(error)}`,
      );
    });
    this.tails.set(key, tail);
    return tail;
  }

  /**
   * @param slot The document.
   * @param doc Its new JSON.
   * @returns Settles once the store answered.
   */
  private async write(slot: DocSlot, doc: string): Promise<void> {
    const { store, game } = this.options;
    const out =
      slot.key === GAME_KEY
        ? await store.saveGame(game, doc, slot.version)
        : await store.save(game, slot.key, doc, slot.version);
    if (out.ok) slot.version = out.version;
    else
      this.log(
        `gameable: store: save of ${slot.key === GAME_KEY ? 'the game document' : 'a player document'} refused (${out.reason})`,
      );
  }
}
