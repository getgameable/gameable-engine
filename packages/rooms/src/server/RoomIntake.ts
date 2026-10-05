/**
 * `RoomIntake` — what a client sends, checked by our own `InboundParser`
 * after the seat's `Budget`.
 */
import { InboundParser, type TextVerdict } from '@gameable/net/server';

import type { Seat } from './SeatMap.js';

/** What a text frame came to. */
export type TextOutcome =
  | { kind: 'msg'; name: string; payload: string }
  | { kind: 'ping'; at: number }
  | { kind: 'bad'; reason: string }
  | { kind: 'budget'; verdict: Exclude<TextVerdict, 'pass'> };

/** What an input frame came to: absorbed, refused by the parser, or over budget. */
export type InputOutcome = 'ok' | 'bad' | 'budget';

/** Counts of what came in and what was refused. */
export interface IntakeCounts {
  input: number;
  text: number;
  bad: number;
  budget: number;
}

/**
 * One room's inbound side. Colyseus has already stripped its
 * `ROOM_DATA_BYTES` header and routed the frame by its type, so INPUT frames
 * and text frames arrive apart. Each frame spends one token of the seat's
 * budget for its channel first (a refused frame still costs), then goes
 * through the parser: an input frame is coalesced into the seat
 * (`RoomPlayer.absorb`); a text frame must be a `msg` or a `ping`. Anything
 * else (an unknown `t`, a `hello`, bad JSON, the wrong channel) is refused
 * and counted (room-wide in `counts`, per player in `seat.text.counts`),
 * never handed to the game. An input `budget` means the room should drop the
 * client; a text `budget` carries the seat's `TextLimit` verdict (`tell`,
 * `refuse` or `close`). One parser per room: Node runs one frame at a time.
 *
 * @example
 * ```ts
 * import { createRoomIntake, createSeatMap } from 'gameable/rooms/server';
 *
 * const seat = createSeatMap().add('session-a', 'Ana', 0);
 * const intake = createRoomIntake();
 * const outcome = intake.text(seat, new TextEncoder().encode('{"t":"ping","at":1}'), 0);
 * // { kind: 'ping', at: 1 }
 * ```
 */
export class RoomIntake {
  /** What came in and what was refused. */
  readonly counts: IntakeCounts = { input: 0, text: 0, bad: 0, budget: 0 };
  private readonly parser = new InboundParser();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  /**
   * @param seat The sender's seat.
   * @param bytes The frame sent as `INPUT_TYPE`.
   * @param now The room's clock, ms.
   * @returns What it came to.
   */
  input(seat: Seat, bytes: Uint8Array, now: number): InputOutcome {
    if (!seat.input.take(now)) {
      this.counts.budget += 1;
      return 'budget';
    }
    const frame = this.parser.parse(bytes);
    if (frame.kind !== 'input') {
      this.counts.bad += 1;
      return 'bad';
    }
    seat.player.absorb(frame.seq, frame.snapshot);
    this.counts.input += 1;
    return 'ok';
  }

  /**
   * @param seat The sender's seat.
   * @param bytes The frame sent as `TEXT_TYPE`: UTF-8 JSON.
   * @param now The room's clock, ms.
   * @returns What it came to.
   */
  text(seat: Seat, bytes: Uint8Array, now: number): TextOutcome {
    const verdict = seat.text.spend(now);
    if (verdict !== 'pass') {
      this.counts.budget += 1;
      return { kind: 'budget', verdict };
    }
    const frame = this.parser.parse(this.decoder.decode(bytes));
    if (frame.kind === 'bad') return this.refuse(seat, frame.reason);
    if (frame.kind !== 'text') return this.refuse(seat, 'kind');
    const msg = frame.msg;
    if (msg.t === 'hello') return this.refuse(seat, 'hello'); // the join options carry the name
    this.counts.text += 1;
    if (msg.t === 'ping') return { kind: 'ping', at: msg.at };
    return { kind: 'msg', name: msg.name, payload: JSON.stringify(msg.payload) };
  }

  private refuse(seat: Seat, reason: string): TextOutcome {
    this.counts.bad += 1;
    seat.text.refused(reason);
    return { kind: 'bad', reason };
  }
}

/**
 * A new intake.
 *
 * @returns The intake.
 *
 * @example
 * ```ts
 * import { createRoomIntake } from 'gameable/rooms/server';
 *
 * const intake = createRoomIntake(); // intake.counts.bad counts refused frames
 * ```
 */
export function createRoomIntake(): RoomIntake {
  return new RoomIntake();
}
