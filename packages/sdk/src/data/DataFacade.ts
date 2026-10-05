/**
 * `ctx.data`: the authority's way to keep player documents and the game's own
 * document in the room's store, and to trade between two players.
 */
import { requireRuntime, type RuntimeState } from '../state';
import type { ExchangeResultEvent, GameEvent } from '../types';
import type { TransferDoc } from './transfer';

/** An exchange the guest asked for and has not heard back about. */
interface PendingExchange {
  a: number;
  b: number;
  give: TransferDoc;
  take: TransferDoc;
}

/**
 * The `ctx.data` facade, one per guest. Only the authority writes: on a
 * client every call is a no-op (logged once).
 *
 * Saving is not free: `save` serialises the document. Call it when the
 * document changed, not every tick; the room writes at most one per player
 * every 6 s anyway, and always when the player leaves or the room closes.
 *
 * @example
 * ```ts
 * function earn(ctx: GameContext): void {
 *   for (const [id, p] of ctx.players) {
 *     const doc = (p.data ?? { coins: 0 }) as { coins: number };
 *     if (ctx.frame % 600 === 0) ctx.data.save(id, { ...doc, coins: doc.coins + 1 });
 *   }
 *   for (const r of ctx.data.results()) if (!r.ok) ctx.net.send('trade-failed', { id: r.id, why: r.reason });
 * }
 * ```
 */
export class DataFacade {
  private readonly pending = new Map<number, PendingExchange>();
  private readonly done: Pick<ExchangeResultEvent, 'id' | 'ok' | 'reason'>[] = [];
  private gameValue: unknown = null;
  private serial = 0;
  private warned = false;

  /** @param rt The runtime this facade belongs to. */
  constructor(private readonly rt: RuntimeState) {}

  /** @returns The game's own saved document, once the room has handed it over; else `null`. */
  get game(): unknown {
    return this.gameValue;
  }

  /**
   * Keep a player's document. `ctx.players.get(player).data` is the new
   * document at once; the room writes it to its store (throttled).
   *
   * @param player A joined player.
   * @param doc Any JSON value; at most 64 KB as JSON.
   */
  save(player: number, doc: unknown): void {
    if (!this.writable()) return;
    const handle = this.rt.players.handle(player);
    if (handle === undefined || !handle.connected) return;
    handle.setData(doc);
    requireRuntime().commands.savePlayerData(player, JSON.stringify(doc));
  }

  /**
   * Keep the game's own document (one per game, shared by every room).
   *
   * @param doc Any JSON value; at most 64 KB as JSON.
   */
  saveGame(doc: unknown): void {
    if (!this.writable()) return;
    this.gameValue = doc;
    requireRuntime().commands.saveGameData(JSON.stringify(doc));
  }

  /**
   * Trade between two players, all or nothing: `a` gives `b` everything in
   * `give` and takes from `b` everything in `take` (numbers move amounts,
   * lists move items; see `applyTransfer`). The result arrives as an
   * `exchange-result` event a tick or more later, in {@link DataFacade.results};
   * on success both players' `data` already show the trade.
   *
   * @param a The first player.
   * @param b The second player.
   * @param give What a gives b, such as `{ coins: 5 }`.
   * @param take What a takes from b, such as `{ owned: ['gem'] }`.
   * @returns The exchange's id, or 0 on a client.
   */
  exchange(a: number, b: number, give: TransferDoc, take: TransferDoc): number {
    if (!this.writable()) return 0;
    this.serial += 1;
    const id = this.serial;
    this.pending.set(id, { a, b, give, take });
    requireRuntime().commands.exchange(id, a, b, JSON.stringify(give), JSON.stringify(take));
    return id;
  }

  /** @returns This tick's exchange results, in arrival order; reused, read during the tick. */
  results(): readonly Pick<ExchangeResultEvent, 'id' | 'ok' | 'reason'>[] {
    return this.done;
  }

  /**
   * Read this tick's `exchange-result` and `game-data` events. A successful
   * exchange is applied to both players' `data` and saved for both.
   *
   * @internal
   * @param events `frame-input.events`.
   */
  beginTick(events: readonly GameEvent[]): void {
    this.done.length = 0;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.tag === 'game-data') this.gameValue = parse(event.val.data);
      else if (event.tag === 'exchange-result') this.finish(event.val);
    }
  }

  /**
   * Forget everything; `init` calls it.
   *
   * @internal
   */
  reset(): void {
    this.pending.clear();
    this.done.length = 0;
    this.gameValue = null;
    this.serial = 0;
    this.warned = false;
  }

  /** @param result One exchange's outcome. */
  private finish(result: ExchangeResultEvent): void {
    this.done.push({ id: result.id, ok: result.ok, reason: result.reason });
    const trade = this.pending.get(result.id);
    this.pending.delete(result.id);
    if (!result.ok || trade === undefined) return;
    // The store's documents, not a re-derived trade: a save made while the trade was in flight
    // is dropped by the room, so re-applying to the guest's newer copy could disagree with the store.
    this.save(trade.a, parse(result.aData));
    this.save(trade.b, parse(result.bData));
  }

  /** @returns True on the authority; logs once on a client. */
  private writable(): boolean {
    if (this.rt.net.role !== 'client') return true;
    if (!this.warned) {
      this.warned = true;
      this.rt.host.log(
        'warn',
        'ctx.data writes on the authority only; this client call does nothing',
      );
    }
    return false;
  }
}

/**
 * @param json A document.
 * @returns It parsed, or null when it is not JSON.
 */
function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
