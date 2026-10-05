/**
 * `LocalLane` — this page's input as `frame-input.players`' one entry.
 *
 * A client-role guest reads `ctx.input` from its own seat's lane, so the
 * client loop passes the step's input there too, aliased from the encoder's
 * snapshot rather than copied.
 */
import type { InputState, PlayerInput } from '@gameable/sdk';
import type { InputSnapshot } from '@gameable/wasm-host';

/** No gamepads: the lane's default before the first step. */
const NO_GAMEPADS: InputState['gamepads'] = Object.freeze([]);

/** One reused `player-input` record, and the one-entry list that holds it. */
export class LocalLane {
  private readonly keys: InputState['keys'];
  private readonly input: InputState;
  private readonly lane: PlayerInput;
  private readonly list: readonly PlayerInput[];

  /** @param snapshot The encoder's snapshot, whose mods and mouse records are shared. */
  constructor(snapshot: InputSnapshot) {
    this.keys = { down: snapshot.down, pressed: snapshot.pressed, released: snapshot.released };
    this.input = {
      keys: this.keys,
      mods: snapshot.mods,
      mouse: snapshot.mouse,
      gamepads: NO_GAMEPADS,
      focused: true,
    };
    this.lane = { player: 0, seq: 0, input: this.input };
    this.list = [this.lane];
  }

  /**
   * Point the lane at this step's input. Allocates nothing.
   *
   * @param snapshot This step's input (its key sets are swapped each step).
   * @param player This page's player id.
   * @param seq This step's input sequence number.
   * @returns The one-entry players list.
   */
  read(snapshot: InputSnapshot, player: number, seq: number): readonly PlayerInput[] {
    const keys = this.keys;
    keys.down = snapshot.down;
    keys.pressed = snapshot.pressed;
    keys.released = snapshot.released;
    const input = this.input;
    input.mods = snapshot.mods;
    input.mouse = snapshot.mouse;
    input.gamepads = snapshot.gamepads ?? NO_GAMEPADS;
    input.focused = snapshot.focused;
    this.lane.player = player;
    this.lane.seq = seq;
    return this.list;
  }
}
