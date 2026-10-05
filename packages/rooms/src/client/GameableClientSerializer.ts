/**
 * `GameableClientSerializer` — the `@colyseus/sdk` side of the room server's
 * `GameableSerializer`. Colyseus hands it every `ROOM_STATE` (our welcome) and
 * `ROOM_STATE_PATCH` (our rows and text frames) with its one-byte header
 * already read; it passes our frames on, untouched, to a sink.
 *
 * The SDK builds a serializer itself (`new (getSerializer(id))()`, no
 * arguments) when JOIN_ROOM names our id, so the sink is attached after the
 * join; frames that arrive first wait in a queue.
 */
import { registerSerializer } from '@colyseus/sdk';

import { SERIALIZER_ID, TEXT_FIRST_BYTE } from '../channels.js';

/**
 * Where our frames go.
 *
 * @example
 * ```ts
 * import type { GameableFrameSink } from 'gameable/rooms/client';
 * const sink: GameableFrameSink = {
 *   welcome: (text) => console.log('welcome', text.length),
 *   text: (text) => console.log('text', text.length),
 *   rows: (bytes) => console.log('rows', bytes.byteLength),
 * };
 * ```
 */
export interface GameableFrameSink {
  /** @param text Our `welcome` text frame (after the first join, and after every resume). */
  welcome(text: string): void;
  /** @param text One of our other server text frames (`cmd`, `players`, `msg`, `pong`, `error`). */
  text(text: string): void;
  /** @param bytes One rows frame, kind byte first: a copy, the sink's to keep. */
  rows(bytes: Uint8Array): void;
}

/** The SDK's read position in a frame. */
interface Iterator {
  offset: number;
}

/**
 * The SDK serializer for our frames, registered under `SERIALIZER_ID` when
 * this module loads. A `ColyseusConnection` attaches itself to it.
 *
 * @example
 * ```ts
 * import { GameableClientSerializer } from 'gameable/rooms/client';
 * declare const room: { serializer: unknown };
 * if (room.serializer instanceof GameableClientSerializer) {
 *   room.serializer.attach({ welcome: console.log, text: console.log, rows: () => undefined });
 * }
 * ```
 */
export class GameableClientSerializer {
  private sink: GameableFrameSink | null = null;
  private readonly early: ((sink: GameableFrameSink) => void)[] = [];
  private readonly decoder = new TextDecoder();

  /** @param sink Receives every frame from now on, after any queued ones. */
  attach(sink: GameableFrameSink): void {
    this.sink = sink;
    for (const deliver of this.early.splice(0)) deliver(sink);
  }

  /**
   * @param data The `ROOM_STATE` frame.
   * @param it Where our bytes start.
   */
  setState(data: Uint8Array, it?: Iterator): void {
    const text = this.decoder.decode(data.subarray(it?.offset ?? 1));
    this.deliver((sink) => {
      sink.welcome(text);
    });
  }

  /**
   * @param data The `ROOM_STATE_PATCH` frame.
   * @param it Where our bytes start.
   */
  patch(data: Uint8Array, it?: Iterator): void {
    const body = data.subarray(it?.offset ?? 1);
    if (body[0] === TEXT_FIRST_BYTE) {
      const text = this.decoder.decode(body);
      this.deliver((sink) => {
        sink.text(text);
      });
      return;
    }
    // Over WebSocket each message is its own buffer, so this copy (20 a second)
    // is for the rule that the sink keeps what it gets: a queued frame waits
    // across the attach, and the SDK's H3 transport has not been checked for reuse.
    const copy = body.slice();
    this.deliver((sink) => {
      sink.rows(copy);
    });
  }

  /** @returns Nothing: our state lives in the page's engine, not in the SDK. */
  getState(): undefined {
    return undefined;
  }

  /** The room is gone: nothing more is delivered. */
  teardown(): void {
    this.sink = null;
    this.early.length = 0;
  }

  /** @param fn Deliver one frame now, or once a sink is attached. */
  private deliver(fn: (sink: GameableFrameSink) => void): void {
    if (this.sink !== null) fn(this.sink);
    else this.early.push(fn);
  }
}

registerSerializer(SERIALIZER_ID, GameableClientSerializer);
