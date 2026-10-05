/**
 * `Slab` — a rewindable pool of objects of one shape.
 *
 * `take()` hands out the pooled objects in order and makes a new one only
 * when the pool has never been this deep before; `rewind()` makes all of them
 * available again. After the first few ticks a steady game takes nothing but
 * objects it already has.
 */
export class Slab<T> {
  private readonly items: T[] = [];
  private used = 0;
  private readonly make: () => T;

  /** @param make Builds one more object when the pool runs out. */
  constructor(make: () => T) {
    this.make = make;
  }

  /**
   * The next free object. Its fields hold whatever the last user left.
   *
   * @returns A pooled object.
   */
  take(): T {
    if (this.used === this.items.length) this.items.push(this.make());
    const item = this.items[this.used];
    this.used += 1;
    return item;
  }

  /** Make every object free again. */
  rewind(): void {
    this.used = 0;
  }
}
