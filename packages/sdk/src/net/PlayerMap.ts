/**
 * `ctx.players`: the room's players by id, plus the host and a stable list.
 */
import type { PlayerHandle } from './PlayerHandle';

/**
 * The room's players: a read-only `Map` from id to {@link PlayerHandle}, plus
 * who the host is and a list to walk without allocating.
 *
 * A `for...of` over the map (or `keys()`, `values()`, `entries()`) makes an
 * iterator, and an entry pair per player, every call: fine in a join handler,
 * not in a system that runs every tick. Walk `list` with an index there.
 *
 * @example
 * ```ts
 * const players = ctx.players;
 * for (let i = 0; i < players.list.length; i += 1) {
 *   const p = players.list[i];
 *   if (p.isHost && p.input.pressed('Enter')) startRound();
 * }
 * const host = players.host === undefined ? undefined : players.get(players.host);
 * ```
 */
export interface Players extends ReadonlyMap<number, PlayerHandle> {
  /**
   * The host's seat id, or undefined while nobody is joined. The first
   * joiner is the host and stays host until they leave (`player-left`); only
   * then does it pass to the lowest seat still joined. A newcomer who takes a
   * lower, freed seat does not become host. Snapshots keep it.
   *
   * A host who drops counts as gone for this alone: while the room holds
   * their seat (they are still joined, but out of the frame's players list),
   * the role passes to the lowest seat in that list, and it stays there when
   * they come back. If nobody else is in the list, the held host keeps it.
   */
  readonly host: number | undefined;
  /**
   * The same players as the map, in id order. The same array for the whole
   * run, updated in place on a join or a leave; never per tick. Read it, do
   * not keep a copy of its contents across ticks.
   */
  readonly list: readonly PlayerHandle[];
}

/** The `Map` behind `ctx.players`; only the `PlayerTable` writes it. */
export class PlayerMap extends Map<number, PlayerHandle> implements Players {
  /** Every entry, in id order. */
  readonly list: PlayerHandle[] = [];
  private hostId: number | undefined = undefined;

  /** @returns The host's seat, or undefined. */
  get host(): number | undefined {
    return this.hostId;
  }

  /**
   * Rebuild from the slots: every connected or present one is listed. The
   * host keeps the role while it can hold it; otherwise the lowest seat that
   * can takes it. With a players list (`listed`), only a connected seat in it
   * can: a seat out of it is held (dropped, waiting to come back). If none
   * can, a connected host keeps it, else the lowest connected seat takes it.
   * Join, leave and players-list ticks only.
   *
   * @param slots Every slot, indexed by id.
   * @param listed True when this frame has a players list (a room), so a
   *   seat missing from it is held; false in a single-player frame.
   */
  rebuild(slots: readonly PlayerHandle[], listed = false): void {
    this.clear();
    this.list.length = 0;
    const kept = this.hostId;
    if (!canHost(slots, kept, listed)) {
      this.hostId =
        lowest(slots, listed) ?? (canHost(slots, kept, false) ? kept : lowest(slots, false));
    }
    for (let id = 0; id < slots.length; id += 1) {
      const slot = slots[id];
      slot.markHost(id === this.hostId);
      if (!slot.connected && !slot.present) continue;
      this.set(id, slot);
      this.list.push(slot);
    }
  }

  /**
   * Set the host a snapshot recorded, before the rebuild that follows a restore.
   *
   * @param host The recorded host, or undefined (an older snapshot: the lowest connected seat).
   */
  restoreHost(host: number | undefined): void {
    this.hostId = host;
  }

  /** Forget every player. */
  reset(): void {
    this.clear();
    this.list.length = 0;
    this.hostId = undefined;
  }
}

/**
 * @param slots Every slot, indexed by id.
 * @param id A seat, or undefined.
 * @param listed True when a seat must also be in the frame's players list.
 * @returns True when that seat is joined (and, with `listed`, in the list).
 */
function canHost(slots: readonly PlayerHandle[], id: number | undefined, listed: boolean): boolean {
  if (id === undefined || id >= slots.length) return false;
  const slot = slots[id];
  return slot.connected && (!listed || slot.present);
}

/**
 * @param slots Every slot, indexed by id.
 * @param listed True when a seat must also be in the frame's players list.
 * @returns The lowest seat that {@link canHost}, or undefined.
 */
function lowest(slots: readonly PlayerHandle[], listed: boolean): number | undefined {
  for (let id = 0; id < slots.length; id += 1) if (canHost(slots, id, listed)) return id;
  return undefined;
}
