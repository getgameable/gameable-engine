/**
 * The heist: the authority's state between ticks. The documents themselves
 * live in `ctx.players.get(id).data`; this is only what a document does not
 * keep: who stands in whose base and for how long, the steals waiting for
 * their exchange result, the next payout, the brainrots on the belt, and the
 * server clock.
 *
 * Flat lanes indexed by player id or belt slot, sized once, so a quiet tick
 * reads and writes numbers and allocates nothing.
 */
import type { GameContext } from 'gameable';

/** Highest player id + 1 the heist tracks. Seats start at 0; six fit with room to spare. */
export const MAX_SEATS = 16;
/** The most brainrots on the belt at once. */
export const MAX_ON_BELT = 16;
/** "Nobody": a lane that names no seat. */
export const NOBODY = -1;

/** The one heist a room plays. */
export class Heist {
  /** The server's clock at `ctx.elapsed` 0, ms since the epoch; null until a join brings it. */
  clockAnchor: number | null = null;
  /** `ctx.elapsed` at which the belt spawns its next brainrot. */
  nextSpawn = 0;
  /** Brainrots spawned in this room, for their ids. */
  spawned = 0;

  /** Whose base each player stands in (not their own), or `NOBODY`. */
  readonly standingIn = new Int8Array(MAX_SEATS);
  /** Seconds each player has stood there. */
  readonly standing = new Float32Array(MAX_SEATS);
  /** The exchange each thief is waiting for; 0 for none. */
  readonly pendingExchange = new Int32Array(MAX_SEATS);
  /** Who that exchange steals from. */
  readonly pendingVictim = new Int8Array(MAX_SEATS);
  /** What it steals. */
  readonly pendingItem: string[] = new Array<string>(MAX_SEATS).fill('');
  /** `ctx.elapsed` of each player's next payout. */
  readonly nextPayout = new Float64Array(MAX_SEATS);

  /** The belt's brainrots, slots `0..onBelt`: entity, id and when it was spawned. */
  readonly beltEntity = new Int32Array(MAX_ON_BELT);
  readonly beltId: string[] = new Array<string>(MAX_ON_BELT).fill('');
  readonly beltSpawnedAt = new Float64Array(MAX_ON_BELT);
  onBelt = 0;

  /** Back to an empty room. Call from `defineGame({ init })`. */
  reset(): void {
    this.clockAnchor = null;
    this.nextSpawn = 0;
    this.spawned = 0;
    this.onBelt = 0;
    for (let seat = 0; seat < MAX_SEATS; seat += 1) this.clearSeat(seat);
  }

  /**
   * A seat was left or taken: whoever sits there starts with no timers.
   *
   * @param seat The player id.
   */
  clearSeat(seat: number): void {
    if (seat < 0 || seat >= MAX_SEATS) return;
    this.standingIn[seat] = NOBODY;
    this.standing[seat] = 0;
    this.pendingExchange[seat] = 0;
    this.pendingVictim[seat] = NOBODY;
    this.pendingItem[seat] = '';
    this.nextPayout[seat] = 0;
  }

  /**
   * Take a brainrot off the belt (grabbed, or fallen off the end). Swaps the last one in.
   *
   * @param slot A belt slot, `0..onBelt`.
   */
  removeFromBelt(slot: number): void {
    const last = this.onBelt - 1;
    this.beltEntity[slot] = this.beltEntity[last];
    this.beltId[slot] = this.beltId[last];
    this.beltSpawnedAt[slot] = this.beltSpawnedAt[last];
    this.onBelt = last;
  }

  /**
   * The server's clock now. Without a store the room sends no clock, and this
   * is room time from 0: a shield still lasts its 20 s, but nothing outlives the room.
   *
   * @param ctx The frame context.
   * @returns Ms since the epoch by the server's clock.
   */
  now(ctx: GameContext): number {
    return (this.clockAnchor ?? 0) + ctx.elapsed * 1000;
  }
}

/** This guest's heist. */
export const heist = new Heist();
