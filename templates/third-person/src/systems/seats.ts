/**
 * Per-player state for the template's systems, keyed by player id.
 */
import type { Actor } from './actors';

/**
 * One state object per player seat. Seat 0's is the one given (the single
 * player's, exported by its system); the others are made the first time a
 * seat is seen, and cleared when the seat's hero changes (a new player in a
 * freed seat must not inherit the last one's conversation).
 *
 * @example
 * ```ts
 * const pockets = new SeatStore({ keys: 0 }, () => ({ keys: 0 }), (p) => { p.keys = 0; });
 * ```
 */
export class SeatStore<T> {
  readonly #seats: (T | undefined)[];
  readonly #entities: (number | undefined)[] = [];

  /**
   * @param first Seat 0's state.
   * @param make A fresh state for another seat.
   * @param clear Reset one seat's own fields (never shared ones).
   */
  constructor(
    first: T,
    private readonly make: () => T,
    private readonly clear: (state: T) => void,
  ) {
    this.#seats = [first];
  }

  /**
   * @param who The actor.
   * @returns Their state, cleared if their hero changed since last seen.
   */
  of(who: Actor): T {
    let state = this.#seats[who.id];
    if (state === undefined) {
      state = this.make();
      this.#seats[who.id] = state;
    }
    const known = this.#entities[who.id];
    if (known !== who.entity) {
      if (known !== undefined) this.clear(state);
      this.#entities[who.id] = who.entity;
    }
    return state;
  }

  /**
   * @param id A player id.
   * @returns That seat's state, or undefined before it was first seen.
   */
  get(id: number): T | undefined {
    return this.#seats[id];
  }

  /** Forget every seat but 0, and clear seat 0. Call from `init`. */
  reset(): void {
    const first = this.#seats[0];
    this.#seats.length = 1;
    this.#entities.length = 0;
    if (first !== undefined) this.clear(first);
  }
}
