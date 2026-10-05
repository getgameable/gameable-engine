/**
 * Test doubles for the room: a hand-stepped clock and timer list behind
 * `RoomPorts`, and a `RoomGame` that records what the room asked of it.
 * Used by the room's own tests only; not exported from the package.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';
import type { Command } from '@gameable/sdk';

import { INPUT_FRAME_BYTES } from '../../protocol/constants.js';
import { encodeInput } from '../../protocol/InputCodec.js';
import type { MutableInputSnapshot, RowSource, ServerText } from '../../protocol/types.js';
import { RoomGame, type RoomView, type ViewMessage } from './RoomGame.js';
import { createRoom, type Room } from './Room.js';
import type { RoomPorts } from './RoomPorts.js';

/** @returns A blank input snapshot. */
export function blankInput(): MutableInputSnapshot {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: true,
  };
}

/**
 * @param seq The frame's sequence number.
 * @param snapshot The input to encode.
 * @returns One encoded input frame.
 */
export function inputFrame(seq: number, snapshot: MutableInputSnapshot): Uint8Array {
  const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  encodeInput(out, seq, snapshot);
  return new Uint8Array(out.buffer);
}

/** Ports over a clock the test moves by hand. */
export class FakePorts implements RoomPorts {
  t = 0;
  readonly sent = new Map<string, (string | Uint8Array)[]>();
  readonly dropped: [string, string][] = [];
  readonly logs: string[] = [];
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  private seed = 1;

  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  random(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
  send(conn: string, data: string | Uint8Array): void {
    const list = this.sent.get(conn) ?? [];
    list.push(typeof data === 'string' ? data : data.slice());
    this.sent.set(conn, list);
  }
  drop(conn: string, reason: string): void {
    this.dropped.push([conn, reason]);
  }
  log(event: string): void {
    this.logs.push(event);
  }

  /**
   * Move the clock, firing every timer that comes due, in order.
   *
   * @param ms How far.
   */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at).at(0);
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }

  /**
   * @param conn A connection id.
   * @returns The text frames sent to it, parsed.
   */
  texts(conn: string): ServerText[] {
    const all = this.sent.get(conn) ?? [];
    return all.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as ServerText);
  }

  /**
   * @param conn A connection id.
   * @returns The binary frames sent to it.
   */
  binaries(conn: string): Uint8Array[] {
    return (this.sent.get(conn) ?? []).filter((d): d is Uint8Array => typeof d !== 'string');
  }
}

/** A row source of one fixed row: entity 5 at the origin. */
const ONE_ROW: RowSource = {
  count: 1,
  entity: () => 5,
  flags: () => 1,
  position: () => [0, 0, 0],
  rotation: () => [0, 0, 0, 1],
  scale: () => [1, 1, 1],
};

/** A game that records every call the room makes. */
export class FakeGame extends RoomGame {
  frame = 0;
  readonly calls: string[] = [];
  readonly inputs: {
    player: number;
    seq: number;
    down: number[];
    pressed: number[];
    released: number[];
    dx: number;
    wheel: number;
    buttons: number;
    mousePressed: number;
  }[] = [];
  commands: Command[] = [];
  messages: ViewMessage[] = [];
  refusal: string | null = null;
  disposed = false;
  /** The entity each player controls, as `entityOf` and the views report it. */
  readonly entities = new Map<number, number>();

  tick(): void {
    this.frame += 1;
    this.calls.push('tick');
  }
  join(player: number, name: string, data: string | null): void {
    this.calls.push(`join ${String(player)} ${name} ${String(data)}`);
  }
  leave(player: number, reason: string): void {
    this.calls.push(`leave ${String(player)} ${reason}`);
  }
  input(player: number, seq: number, snapshot: MutableInputSnapshot): void {
    this.inputs.push({
      player,
      seq,
      down: Array.from(snapshot.down),
      pressed: Array.from(snapshot.pressed),
      released: Array.from(snapshot.released),
      dx: snapshot.mouse.dx,
      wheel: snapshot.mouse.wheel,
      buttons: snapshot.mouse.buttons,
      mousePressed: snapshot.mouse.pressed,
    });
  }
  message(player: number, name: string, payload: string): void {
    this.calls.push(`message ${String(player)} ${name} ${payload}`);
  }
  viewFor(player: number): RoomView {
    this.calls.push(`view ${String(player)}`);
    return {
      frame: this.frame,
      entity: this.entityOf(player),
      commands: this.commands,
      messages: this.messages,
      takeRows: () => ONE_ROW,
    };
  }
  entityOf(player: number): number {
    return this.entities.get(player) ?? 0;
  }
  snapshotFor(player: number): string {
    return `{"for":${String(player)},"entities":[]}`;
  }
  dispose(): void {
    this.disposed = true;
  }

  /** End the game the way a dead guest does. */
  crash(): void {
    this.end('crashed');
  }
}

/** A {@link FakeGame} that says which input seq a step applied. */
export class AckingGame extends FakeGame {
  applied = 0;

  ackFor(): number {
    return this.applied;
  }
}

/** A {@link FakeGame} with an `admit` hook that refuses with `refusal` when set. */
export class AdmittingGame extends FakeGame {
  admit(): Promise<string | null> {
    return Promise.resolve(this.refusal);
  }
}

/** @returns A promise that settles after pending microtasks and one macrotask. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param options Seats, row rate, and the game to use.
 * @param options.maxPlayers Seats; default 4.
 * @param options.sendHz Rows per second; default 20.
 * @param options.game The game; default a new `FakeGame`.
 * @returns A room over a fake game and hand-stepped ports.
 */
export function roomSetup(options: { maxPlayers?: number; sendHz?: number; game?: FakeGame } = {}): {
  room: Room;
  game: FakeGame;
  ports: FakePorts;
} {
  const game = options.game ?? new FakeGame();
  const ports = new FakePorts();
  const room = createRoom({
    code: 'ABCD',
    game,
    ports,
    maxPlayers: options.maxPlayers ?? 4,
    sendHz: options.sendHz ?? 20,
  });
  return { room, game, ports };
}
