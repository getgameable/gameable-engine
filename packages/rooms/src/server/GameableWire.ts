/**
 * `GameableWire` — our server frames as Colyseus-ready bytes.
 */
import {
  AUTHORITY_SENDER,
  createRowsCodec,
  MAX_PAYLOAD_BYTES,
  type PlayerSummary,
  type RowSource,
  type ServerErrorCode,
  utf8ByteLength,
} from '@gameable/net';
import type { Command } from '@gameable/sdk';

import { ROOM_STATE, ROOM_STATE_PATCH } from '../channels.js';

/**
 * Builds each of our frames behind its one Colyseus byte (`ROOM_STATE` for
 * the welcome, `ROOM_STATE_PATCH` for the rest). After that byte the frame is
 * exactly what `gameable/net`'s own `RoomWire` sends: the same JSON shapes,
 * `entity` in the welcome and every `cmd`, `from: AUTHORITY_SENDER` on a
 * `msg`, and the same rows codec.
 *
 * Every frame is a fresh `Buffer`, rows included: `ws` writes a server frame
 * to the socket by reference, so a reused buffer would be overwritten while a
 * slow socket still holds it (the spike's trap 3). That is one allocation per
 * frame sent.
 *
 * @example
 * ```ts
 * import { createAosWire } from 'gameable/rooms/server';
 *
 * const wire = createAosWire();
 * client.raw(wire.cmd(view.frame, ack, view.entity, view.commands));
 * ```
 */
export class GameableWire {
  private readonly codec = createRowsCodec();
  private readonly cmdFrame: {
    t: 'cmd';
    frame: number;
    ack: number;
    entity: number;
    commands: readonly Command[];
  } = { t: 'cmd', frame: 0, ack: 0, entity: 0, commands: [] };

  /**
   * @param player The seat's id.
   * @param entity The entity it controls, or 0.
   * @param frame The authority's step counter.
   * @param snapshot `RoomGame.snapshotFor`'s JSON text, embedded as is.
   * @param players Everyone seated.
   * @param room The room's code, or null to leave it out. It comes right after
   *   `t`, so a client can read it from the head of the text.
   * @returns The `ROOM_STATE` frame. `secret` is empty: the reconnection token is the secret.
   */
  welcome(
    player: number,
    entity: number,
    frame: number,
    snapshot: string,
    players: readonly PlayerSummary[],
    room: string | null = null,
  ): Buffer {
    const code = room === null ? '' : `"room":${JSON.stringify(room)},`;
    const text =
      `{"t":"welcome",${code}"player":${String(player)},"entity":${String(entity)},"secret":"",` +
      `"frame":${String(frame)},"snapshot":${snapshot},"players":${JSON.stringify(players)}}`;
    return this.text(ROOM_STATE, text);
  }

  /**
   * @param frame The authority's step counter.
   * @param ack The last input seq applied for this player.
   * @param entity The entity this player controls, or 0.
   * @param commands The view's commands; stringified during the call.
   * @returns The frame.
   */
  cmd(frame: number, ack: number, entity: number, commands: readonly Command[]): Buffer {
    const envelope = this.cmdFrame;
    envelope.frame = frame;
    envelope.ack = ack;
    envelope.entity = entity;
    envelope.commands = commands;
    const out = this.text(ROOM_STATE_PATCH, JSON.stringify(envelope));
    envelope.commands = [];
    return out;
  }

  /**
   * @param name The message name.
   * @param payload The payload as JSON text, embedded as is.
   * @returns The frame, or null when the payload is over `MAX_PAYLOAD_BYTES`.
   */
  msg(name: string, payload: string): Buffer | null {
    if (utf8ByteLength(payload) > MAX_PAYLOAD_BYTES) return null;
    const head = `{"t":"msg","from":${String(AUTHORITY_SENDER)},"name":${JSON.stringify(name)}`;
    return this.text(ROOM_STATE_PATCH, `${head},"payload":${payload}}`);
  }

  /**
   * @param players Everyone seated, ascending by id.
   * @returns The frame.
   */
  players(players: readonly PlayerSummary[]): Buffer {
    return this.text(ROOM_STATE_PATCH, JSON.stringify({ t: 'players', players }));
  }

  /**
   * @param at The client's `ping.at`, echoed.
   * @param server The room's clock.
   * @returns The frame.
   */
  pong(at: number, server: number): Buffer {
    return this.text(ROOM_STATE_PATCH, JSON.stringify({ t: 'pong', at, server }));
  }

  /**
   * @param code Why.
   * @param detail Words for the page, if any.
   * @returns The frame.
   */
  error(code: ServerErrorCode, detail?: string): Buffer {
    const frame = detail === undefined ? { t: 'error', code } : { t: 'error', code, detail };
    return this.text(ROOM_STATE_PATCH, JSON.stringify(frame));
  }

  /**
   * @param frame The authority's step counter.
   * @param ack The last input seq applied for this player.
   * @param rows The rows, read in place, and the player's own body as the trailer.
   * @returns The frame, or null when there are no rows and no trailer.
   */
  rows(frame: number, ack: number, rows: RowSource): Buffer | null {
    // The trailer goes out alone too: a predicting client is corrected while its body is held still.
    if (rows.count === 0 && !rows.player) return null;
    const size = this.codec.frameBytes(rows);
    const out = Buffer.allocUnsafe(1 + size);
    out[0] = ROOM_STATE_PATCH;
    const view = new DataView(out.buffer, out.byteOffset + 1, size);
    return this.codec.encode(view, frame, ack, rows) === 0 ? null : out;
  }

  private text(code: number, text: string): Buffer {
    const out = Buffer.allocUnsafe(1 + Buffer.byteLength(text));
    out[0] = code;
    out.write(text, 1, 'utf8');
    return out;
  }
}

/**
 * A new frame builder; one per room.
 *
 * @returns The wire.
 *
 * @example
 * ```ts
 * import { createAosWire } from 'gameable/rooms/server';
 *
 * const bytes = createAosWire().pong(12.5, 3000); // [ROOM_STATE_PATCH, ...'{"t":"pong",...}']
 * ```
 */
export function createAosWire(): GameableWire {
  return new GameableWire();
}
