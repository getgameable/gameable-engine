/**
 * `RoomPlayer` — one seat: who holds it, its secret, and the input waiting
 * for the next tick.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';

import type { MutableInputSnapshot, PlayerSummary } from '../../protocol/types.js';
import { TextLimit, type TextLimitOptions } from '../inbound/TextLimit.js';

/**
 * A seat in a room. It outlives its connection: `conn` is null while the seat
 * is held for a reconnect.
 *
 * Input frames that arrive between two ticks are **coalesced** into
 * `pending` (the plan's Review Focus 1): held keys, held mouse buttons,
 * modifiers and focus are the newest frame's; key and button edges
 * (`pressed`, `released`) are OR-ed, so a key pressed and released inside one
 * tick still reaches the game as both edges; mouse deltas and the wheel are
 * summed. After the tick hands `pending` to the game, {@link RoomPlayer.consumed}
 * clears the edges and deltas and keeps what is held. Nothing here allocates.
 *
 * @example
 * ```ts
 * import { RoomPlayer } from 'gameable/net/server';
 *
 * const seat = new RoomPlayer(1, 'secret', 'Ana', 'conn-1', 0);
 * console.log(seat.summary()); // { id: 1, name: 'Ana', connected: true }
 * ```
 */
export class RoomPlayer {
  /** The input waiting for the next tick, coalesced. */
  readonly pending: MutableInputSnapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: false,
  };
  /** The newest input `seq` in `pending`. */
  pendingSeq = 0;
  /** Whether a frame arrived since the last tick. */
  hasPending = false;
  /** The last input `seq` handed to the game: what `cmd` and rows frames ack. */
  lastAck = 0;
  /** When rows were last sent to this seat, by the room's clock. */
  lastRowsAt = Number.NEGATIVE_INFINITY;
  /** The room tick that last had an input frame from this seat, by the room's clock. */
  lastInputAt: number;
  /** The seat's text budget and counts; it outlives a reconnect, so a resume is no refill. */
  readonly text: TextLimit;
  /** True once the held input was let go (a hold, or no frame for a while), until a frame comes. */
  private neutral = false;

  /**
   * @param id The player id.
   * @param secret The seat secret the client resumes with.
   * @param name The display name.
   * @param conn The connection holding the seat, or null.
   * @param lastSeen When the seat was last connected, by the room's clock.
   * @param text The text budget and `closeAfter`; defaults 40, +20 per 5 s, 100.
   */
  constructor(
    readonly id: number,
    readonly secret: string,
    public name: string,
    public conn: string | null,
    public lastSeen: number,
    text?: TextLimitOptions,
  ) {
    this.lastInputAt = lastSeen;
    this.text = new TextLimit(text);
  }

  /** @returns True while a connection holds the seat. */
  get connected(): boolean {
    return this.conn !== null;
  }

  /** @returns The seat as the `players` frame lists it. */
  summary(): PlayerSummary {
    return { id: this.id, name: this.name, connected: this.connected };
  }

  /**
   * Fold one decoded input frame into `pending`.
   *
   * @param seq The frame's sequence number.
   * @param frame The decoded frame; read during the call.
   */
  absorb(seq: number, frame: MutableInputSnapshot): void {
    const into = this.pending;
    for (let i = 0; i < KEY_WORDS; i += 1) {
      into.down[i] = frame.down[i];
      into.pressed[i] |= frame.pressed[i];
      into.released[i] |= frame.released[i];
    }
    const mods = into.mods;
    mods.shift = frame.mods.shift;
    mods.ctrl = frame.mods.ctrl;
    mods.alt = frame.mods.alt;
    mods.meta = frame.mods.meta;
    mods.capsLock = frame.mods.capsLock;
    mods.numLock = frame.mods.numLock;
    const mouse = into.mouse;
    mouse.dx += frame.mouse.dx;
    mouse.dy += frame.mouse.dy;
    mouse.wheel += frame.mouse.wheel;
    mouse.buttons = frame.mouse.buttons;
    mouse.pressed |= frame.mouse.pressed;
    mouse.released |= frame.mouse.released;
    into.focused = frame.focused;
    this.pendingSeq = seq;
    this.hasPending = true;
    this.neutral = false;
  }

  /**
   * Let go of everything held, as pending input: each held key and button
   * gets its `released` edge (edges that came in since the last tick are
   * kept), nothing is down, the modifiers are off and the player is
   * unfocused. The next tick hands that to the game. Nothing allocates.
   */
  release(): void {
    const pending = this.pending;
    for (let i = 0; i < KEY_WORDS; i += 1) {
      pending.released[i] |= pending.down[i];
      pending.down[i] = 0;
    }
    pending.mouse.released |= pending.mouse.buttons;
    pending.mouse.buttons = 0;
    const mods = pending.mods;
    mods.shift = mods.ctrl = mods.alt = mods.meta = mods.capsLock = mods.numLock = false;
    pending.focused = false;
    this.hasPending = true;
    this.neutral = true;
  }

  /**
   * Called by the room at each tick, before the input goes to the game. A
   * seat with a frame this tick is marked fresh; a seat with no frame for
   * `afterMs` has its input let go once (`release`), so a hidden tab or a
   * stalled link does not keep its keys held on the server.
   *
   * @param now The room's clock, ms.
   * @param afterMs How long without a frame; default 250 ms (15 steps at 60 Hz).
   */
  neutralIfIdle(now: number, afterMs = 250): void {
    if (this.neutral) return;
    if (this.hasPending) this.lastInputAt = now;
    else if (now - this.lastInputAt >= afterMs) this.release();
  }

  /** The game has the pending input: ack it, clear its edges and deltas, keep what is held. */
  consumed(): void {
    const into = this.pending;
    into.pressed.fill(0);
    into.released.fill(0);
    const mouse = into.mouse;
    mouse.dx = 0;
    mouse.dy = 0;
    mouse.wheel = 0;
    mouse.pressed = 0;
    mouse.released = 0;
    this.lastAck = this.pendingSeq;
    this.hasPending = false;
  }
}
