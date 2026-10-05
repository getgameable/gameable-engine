/**
 * The room's state on the authority, beside the player documents: each seat's
 * pet bodies, who is mid-trade, the open offers and the exchanges in flight.
 * The documents themselves are `ctx.players.get(id).data` (`src/docs.ts`).
 *
 * Per-seat lanes are flat arrays sized once, so a quiet tick reads numbers
 * and allocates nothing. Offers are made and dropped on messages only.
 */
import type { TransferDoc } from 'gameable';

/** Seats in a room: `features.multiplayer.maxPlayers` in `src/game.ts`. */
export const MAX_PLAYERS = 8;
/** Highest player id + 1 the room tracks. Seats start at 0. */
export const MAX_SEATS = 16;
/** Pets shown following each player: the newest ones. */
export const VISIBLE_PETS = 3;
/** The most coins on the ground (`rules.coinCount` is capped to it). */
export const MAX_COINS = 64;

/** An open offer: `from` gives `give` and takes `take` from `to`, once `to` accepts. */
export interface OpenOffer {
  id: number;
  from: number;
  to: number;
  give: TransferDoc;
  take: TransferDoc;
}

/** The room's collection state. */
export class Collection {
  /** Pet entity per seat and slot (`seat * VISIBLE_PETS + slot`); 0 for none. */
  readonly petEntity = new Int32Array(MAX_SEATS * VISIBLE_PETS);
  /** The pet id each pet entity shows, so a change of pet re-tints it. */
  readonly petShown: string[] = new Array<string>(MAX_SEATS * VISIBLE_PETS).fill('');
  /** Where each pet entity is, x and z. */
  readonly petX = new Float32Array(MAX_SEATS * VISIBLE_PETS);
  readonly petZ = new Float32Array(MAX_SEATS * VISIBLE_PETS);
  /** 1 while a seat's document changed and its pets and HUD must catch up. */
  readonly dirty = new Uint8Array(MAX_SEATS);
  /** 1 while a seat is in an exchange that has not come back. */
  readonly busy = new Uint8Array(MAX_SEATS);
  /** Open offers by id; at most one per sender. */
  readonly offers = new Map<number, OpenOffer>();
  /** Exchanges in flight: `ctx.data.exchange` id to the two seats. */
  readonly inFlight = new Map<number, { a: number; b: number }>();
  /** The last offer each seat received, as HUD text; '' for none. */
  readonly offerText: string[] = new Array<string>(MAX_SEATS).fill('');
  /** The coin entities, spawned on the authority's first tick; `coinCount` are set. */
  readonly coins = new Int32Array(MAX_COINS);
  /** Where each coin lies, x and z: kept here, not read back from physics. */
  readonly coinX = new Float32Array(MAX_COINS);
  readonly coinZ = new Float32Array(MAX_COINS);
  /** How many coins are laid; 0 until the first tick. */
  coinCount = 0;
  /** The next offer id. */
  serial = 0;

  /** Back to an empty room. Call from `defineGame({ init })`. */
  reset(): void {
    this.petEntity.fill(0);
    this.petShown.fill('');
    this.petX.fill(0);
    this.petZ.fill(0);
    this.dirty.fill(0);
    this.busy.fill(0);
    this.offers.clear();
    this.inFlight.clear();
    this.offerText.fill('');
    this.coins.fill(0);
    this.coinCount = 0;
    this.serial = 0;
  }

  /**
   * Drop every open offer from or to a seat.
   *
   * @param seat The seat.
   */
  dropOffers(seat: number): void {
    for (const [id, offer] of this.offers) {
      if (offer.from !== seat && offer.to !== seat) continue;
      this.offers.delete(id);
      if (offer.to < MAX_SEATS) {
        this.offerText[offer.to] = '';
        this.dirty[offer.to] = 1;
      }
    }
  }
}

/** This guest's collection. */
export const collection = new Collection();
