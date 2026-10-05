/**
 * The multi-player tape: every seat's input, and the joins, leaves and
 * messages a room hands its authority, in host-side shapes.
 *
 * A room builds `frame-input.players` from the seats joined this step,
 * ascending by id, and puts `player-joined` / `player-left` in the same
 * step's events. A seat that leaves is out of that step's `players`; one that
 * joins is in it. {@link PlayersInput} does exactly that, so a test drives
 * an authority the way a room does without a room.
 */
import { createInputState, endFrame } from './frame-input';
import type { MutableInputState } from './frame-input';
import type { Command, GameEvent, PlayerInput } from '@gameable/sdk';

/** One step's room lanes: `frame-input.players` and the room's events. */
export interface PlayerLanes {
  /** The joined seats, ascending by id. */
  players: PlayerInput[];
  /** The joins, leaves and messages queued since the last step, in call order. */
  events: GameEvent[];
}

/**
 * Seats `0..count-1`, each with its own mutable input, and the room events
 * queued for the next step.
 *
 * @example
 * ```ts
 * import { createPlayersInput, press } from 'gameable/test';
 *
 * const tape = createPlayersInput(2);
 * tape.join(0);
 * press(tape.input(0), 'W');
 * const { players, events } = tape.frame();
 * ```
 */
export class PlayersInput {
  private readonly inputs: MutableInputState[] = [];
  private readonly seqs: number[] = [];
  private readonly seated: boolean[] = [];
  private readonly entities: number[] = [];
  private queued: GameEvent[] = [];

  /** @param count How many seats; ids are `0..count-1`. */
  constructor(readonly count: number) {
    for (let seat = 0; seat < count; seat += 1) {
      this.inputs.push(createInputState());
      this.seqs.push(0);
      this.seated.push(false);
      this.entities.push(0);
    }
  }

  /**
   * @param seat A seat id.
   * @returns That seat's input, the same object every step; mutate it with `press` and friends.
   */
  input(seat: number): MutableInputState {
    return this.inputs[this.check(seat)];
  }

  /**
   * Seat a player from the next step on, with a `player-joined` event.
   *
   * @param seat The seat id.
   * @param name The display name; default `p<seat>`.
   * @param data The saved document as JSON, if any.
   */
  join(seat: number, name = `p${String(seat)}`, data?: string): void {
    this.push({ tag: 'player-joined', val: { player: seat, name, data } });
  }

  /**
   * Free a seat on the next step, with a `player-left` event.
   *
   * @param seat The seat id.
   * @param reason Why; default `left`.
   */
  leave(seat: number, reason = 'left'): void {
    this.push({ tag: 'player-left', val: { player: seat, reason } });
  }

  /**
   * Queue a game message from a player.
   *
   * @param seat The sender.
   * @param name The message name.
   * @param payload JSON; default `null`.
   */
  message(seat: number, name: string, payload = 'null'): void {
    this.push({ tag: 'message', val: { player: seat, name, payload } });
  }

  /**
   * Queue any room event. A `player-joined` seats its player and a
   * `player-left` frees the seat, exactly as {@link join} and {@link leave}.
   *
   * @param event The event.
   * @throws {Error} On a seat out of range, a join to a taken seat, or a leave from an empty one.
   */
  push(event: GameEvent): void {
    if (event.tag === 'player-joined') {
      const seat = this.check(event.val.player);
      if (this.seated[seat]) throw new Error(`seat ${String(seat)} is already joined`);
      this.seated[seat] = true;
      this.seqs[seat] = 0;
    } else if (event.tag === 'player-left') {
      const seat = this.check(event.val.player);
      if (!this.seated[seat]) throw new Error(`seat ${String(seat)} is not joined`);
      this.seated[seat] = false;
      this.entities[seat] = 0;
    }
    this.queued.push(event);
  }

  /**
   * @param seat A seat id.
   * @returns True while that seat is joined.
   */
  isJoined(seat: number): boolean {
    return this.seated[this.check(seat)];
  }

  /** @returns The joined seats, ascending. */
  joined(): number[] {
    const out: number[] = [];
    for (let seat = 0; seat < this.count; seat += 1) if (this.seated[seat]) out.push(seat);
    return out;
  }

  /**
   * @param seat A seat id.
   * @returns The entity the authority last said that seat controls (`set-player-entity`), or 0.
   */
  entityOf(seat: number): number {
    return this.entities[this.check(seat)];
  }

  /**
   * Take this step's lanes: every joined seat's input (its `seq` counts its
   * steps since it joined, from 1) and the queued events, which are cleared.
   *
   * @returns The lanes for `createFrameInput`.
   */
  frame(): PlayerLanes {
    const players: PlayerInput[] = [];
    for (let seat = 0; seat < this.count; seat += 1) {
      if (!this.seated[seat]) continue;
      this.seqs[seat] += 1;
      players.push({ player: seat, seq: this.seqs[seat], input: this.inputs[seat] });
    }
    const events = this.queued;
    this.queued = [];
    return { players, events };
  }

  /**
   * Read a step's commands for the `set-player-entity`s, so
   * {@link entityOf} follows spawns and `possess`.
   *
   * @param commands The step's `frame-output.commands`.
   */
  observe(commands: readonly Command[]): void {
    for (const c of commands) {
      if (c.tag !== 'set-player-entity') continue;
      const seat = c.val.player;
      if (seat >= 0 && seat < this.count) this.entities[seat] = c.val.entity;
    }
  }

  /** Clear every seat's per-frame edges, keeping held keys held. Call it after each step. */
  endFrame(): void {
    for (const input of this.inputs) endFrame(input);
  }

  /**
   * @param seat A seat id.
   * @returns The seat.
   * @throws {Error} When it is not a seat of this tape.
   */
  private check(seat: number): number {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) {
      throw new Error(`seat ${String(seat)} is not one of seats 0..${String(this.count - 1)}`);
    }
    return seat;
  }
}

/**
 * Make a multi-player tape with `count` seats, all empty.
 *
 * @param count How many seats; ids are `0..count-1`.
 * @returns The tape.
 *
 * @example
 * ```ts
 * import { createFrameInput, createPlayersInput } from 'gameable/test';
 *
 * const tape = createPlayersInput(3);
 * tape.join(0);
 * tape.join(1);
 * const out = guest.tick(createFrameInput({ frame: 0, ...tape.frame() }));
 * tape.observe(out.commands);
 * tape.endFrame();
 * ```
 */
export function createPlayersInput(count: number): PlayersInput {
  return new PlayersInput(count);
}
