/**
 * `RoomInputs` — the server loop's `InputSource`, filled from the room.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';
import type { InputSource, PlayerInput } from '@gameable/wasm-host/server';

import type { MutableInputSnapshot } from '../../protocol/types.js';

/** One seat's input as the guest reads it. */
interface Slot {
  input: PlayerInput;
  seq: number;
  /** The seq a simulation step has read. */
  applied: number;
}

/**
 * @returns A neutral `PlayerInput`: nothing held, focused, mouse locked.
 */
function neutral(): PlayerInput {
  return {
    keys: {
      down: new Uint32Array(KEY_WORDS),
      pressed: new Uint32Array(KEY_WORDS),
      released: new Uint32Array(KEY_WORDS),
    },
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    // The wire has no pointer-lock bit; a client sends look deltas only while it plays, so locked.
    mouse: { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0, locked: true },
    gamepads: [],
    focused: true,
  };
}

/**
 * Each seated player's input, in the shape the server loop hands the guest.
 *
 * The room calls {@link RoomInputs.absorb} once per room tick with the
 * input it coalesced; a room tick can run zero, one or several simulation
 * steps, so this coalesces again (edges OR-ed, deltas summed, held state
 * replaced) and {@link RoomInputs.consumed} clears the edges and deltas after
 * each step has read them: an edge reaches exactly one step. `players()` is
 * ascending, as the WIT requires, and allocates nothing. Player 0 (the first
 * joiner) is also the frame's `input`; with no player 0 seated it is neutral.
 *
 * @example
 * ```ts
 * import { RoomInputs } from 'gameable/net/server';
 *
 * const inputs = new RoomInputs();
 * inputs.add(1);
 * inputs.players(); // [1]
 * ```
 */
export class RoomInputs implements InputSource {
  private readonly ids: number[] = [];
  /** `ids` without the held seats: what `players()` hands the guest. */
  private readonly listed: number[] = [];
  private readonly held = new Set<number>();
  /** The slots in `ids` order, so a step walks them without an iterator. */
  private readonly ordered: Slot[] = [];
  private readonly slots = new Map<number, Slot>();
  private readonly idle = neutral();

  /** @param player A seated player; their input starts neutral. */
  add(player: number): void {
    if (this.slots.has(player)) return;
    const slot: Slot = { input: neutral(), seq: 0, applied: 0 };
    this.slots.set(player, slot);
    let at = 0;
    while (at < this.ids.length && this.ids[at] < player) at += 1;
    this.ids.splice(at, 0, player);
    this.ordered.splice(at, 0, slot);
    this.relist();
  }

  /** @param player A player who left. */
  remove(player: number): void {
    if (!this.slots.delete(player)) return;
    const at = this.ids.indexOf(player);
    this.ids.splice(at, 1);
    this.ordered.splice(at, 1);
    this.held.delete(player);
    this.relist();
  }

  /**
   * Leave a seat out of `players()` while the room holds it for a player who
   * dropped; its input slot is kept for the resume.
   *
   * @param player A seated player.
   */
  hold(player: number): void {
    if (!this.slots.has(player) || this.held.has(player)) return;
    this.held.add(player);
    this.relist();
  }

  /** @param player A held player who is back. */
  resume(player: number): void {
    if (this.held.delete(player)) this.relist();
  }

  /**
   * @returns The seated players, held seats left out, ascending; the same
   *   array every call. The guest reads a seat missing from it as held.
   */
  players(): readonly number[] {
    return this.listed;
  }

  /** Rebuild `listed` in place. Seat changes only, never per step. */
  private relist(): void {
    this.listed.length = 0;
    for (const id of this.ids) if (!this.held.has(id)) this.listed.push(id);
  }

  /**
   * @param player A player id.
   * @returns Their input for the next step; neutral for anyone not seated.
   */
  snapshotFor(player: number): PlayerInput {
    return this.slots.get(player)?.input ?? this.idle;
  }

  /**
   * @param player A player id.
   * @returns The newest input `seq` folded in for them.
   */
  seqFor(player: number): number {
    return this.slots.get(player)?.seq ?? 0;
  }

  /**
   * @param player A player id.
   * @returns The newest input seq a simulation step has read for them.
   */
  appliedFor(player: number): number {
    return this.slots.get(player)?.applied ?? 0;
  }

  /**
   * Fold one room tick's coalesced input in.
   *
   * @param player The seated player.
   * @param seq The newest input `seq` in it.
   * @param from The room's snapshot; read during the call.
   */
  absorb(player: number, seq: number, from: MutableInputSnapshot): void {
    const slot = this.slots.get(player);
    if (slot === undefined) return;
    const { keys, mods, mouse } = slot.input;
    for (let i = 0; i < KEY_WORDS; i += 1) {
      keys.down[i] = from.down[i];
      keys.pressed[i] |= from.pressed[i];
      keys.released[i] |= from.released[i];
    }
    mods.shift = from.mods.shift;
    mods.ctrl = from.mods.ctrl;
    mods.alt = from.mods.alt;
    mods.meta = from.mods.meta;
    mods.capsLock = from.mods.capsLock;
    mods.numLock = from.mods.numLock;
    mouse.dx += from.mouse.dx;
    mouse.dy += from.mouse.dy;
    mouse.wheel += from.mouse.wheel;
    mouse.buttons = from.mouse.buttons;
    mouse.pressed |= from.mouse.pressed;
    mouse.released |= from.mouse.released;
    slot.input.focused = from.focused;
    slot.seq = seq;
  }

  /** One simulation step has read every input: mark its seq applied, clear the edges and deltas. */
  consumed(): void {
    const ordered = this.ordered;
    for (let i = 0; i < ordered.length; i += 1) {
      const slot = ordered[i];
      slot.applied = slot.seq;
      const { keys, mouse } = slot.input;
      keys.pressed.fill(0);
      keys.released.fill(0);
      mouse.dx = 0;
      mouse.dy = 0;
      mouse.wheel = 0;
      mouse.pressed = 0;
      mouse.released = 0;
    }
  }
}
