/**
 * `RoomWire` — the frames a room sends, built and handed to `ports.send`.
 */
import type { Command } from '@gameable/sdk';

import { AUTHORITY_SENDER, MAX_PAYLOAD_BYTES } from '../../protocol/constants.js';
import { RowsCodec } from '../../protocol/RowsCodec.js';
import { utf8ByteLength } from '../../protocol/textFrameFunctions.js';
import type { PlayerSummary, RowSource, ServerErrorCode } from '../../protocol/types.js';
import type { RoomPorts } from './RoomPorts.js';
import { SendBuffer } from './SendBuffer.js';

/**
 * Builds and sends a room's frames.
 *
 * Two of them embed JSON text the game already produced, without parsing it
 * again: the `welcome` snapshot and a `msg` payload (the guest's own
 * `JSON.stringify` output). The `cmd` frame is one reused envelope around the
 * view's command objects, stringified per send: the reliable path allocates
 * its JSON text, and that is accepted. A rows frame is encoded into the one
 * {@link SendBuffer} and handed over as a borrowed view: that path allocates
 * nothing.
 *
 * @example
 * ```ts
 * import { RoomWire } from 'gameable/net/server';
 *
 * const wire = new RoomWire(ports);
 * wire.error('conn-1', 'full');
 * ```
 */
export class RoomWire {
  private readonly codec = new RowsCodec();
  private readonly buffer = new SendBuffer();
  private readonly cmdFrame: {
    t: 'cmd';
    frame: number;
    ack: number;
    entity: number;
    commands: readonly Command[];
  } = { t: 'cmd', frame: 0, ack: 0, entity: 0, commands: [] };

  /** @param ports Where the frames go. */
  constructor(private readonly ports: RoomPorts) {}

  /**
   * @param conn The new or resumed seat's connection.
   * @param player Its id.
   * @param entity The entity it controls, or 0.
   * @param secret Its seat secret.
   * @param frame The authority's step counter.
   * @param snapshot `RoomGame.snapshotFor`'s JSON text.
   * @param players Everyone seated.
   * @param room The room's code, for the page to show and share.
   */
  welcome(
    conn: string,
    player: number,
    entity: number,
    secret: string,
    frame: number,
    snapshot: string,
    players: readonly PlayerSummary[],
    room?: string,
  ): void {
    const code = room === undefined ? '' : `"room":${JSON.stringify(room)},`;
    const text =
      `{"t":"welcome","player":${String(player)},"entity":${String(entity)},${code}` +
      `"secret":${JSON.stringify(secret)},` +
      `"frame":${String(frame)},"snapshot":${snapshot},"players":${JSON.stringify(players)}}`;
    this.ports.send(conn, text);
  }

  /**
   * @param conn The receiving connection.
   * @param frame The authority's step counter.
   * @param ack The last input seq applied for this player.
   * @param entity The entity this player controls, or 0.
   * @param commands The view's commands; stringified during the call.
   */
  cmd(
    conn: string,
    frame: number,
    ack: number,
    entity: number,
    commands: readonly Command[],
  ): void {
    const envelope = this.cmdFrame;
    envelope.frame = frame;
    envelope.ack = ack;
    envelope.entity = entity;
    envelope.commands = commands;
    this.ports.send(conn, JSON.stringify(envelope));
    envelope.commands = [];
  }

  /**
   * A message from the authority (`from: AUTHORITY_SENDER`).
   *
   * @param conn The receiving connection.
   * @param name The message name.
   * @param payload The payload as JSON text.
   * @returns False (and nothing sent) when the payload is over `MAX_PAYLOAD_BYTES`.
   */
  msg(conn: string, name: string, payload: string): boolean {
    if (utf8ByteLength(payload) > MAX_PAYLOAD_BYTES) return false;
    const head = `{"t":"msg","from":${String(AUTHORITY_SENDER)},"name":${JSON.stringify(name)}`;
    this.ports.send(conn, `${head},"payload":${payload}}`);
    return true;
  }

  /**
   * @param conn The receiving connection.
   * @param players Everyone seated, ascending by id.
   */
  players(conn: string, players: readonly PlayerSummary[]): void {
    this.ports.send(conn, JSON.stringify({ t: 'players', players }));
  }

  /**
   * @param conn The receiving connection.
   * @param code Why.
   * @param detail Words for the page, if any.
   */
  error(conn: string, code: ServerErrorCode, detail?: string): void {
    const frame = detail === undefined ? { t: 'error', code } : { t: 'error', code, detail };
    this.ports.send(conn, JSON.stringify(frame));
  }

  /**
   * @param conn The receiving connection.
   * @param at The client's `ping.at`, echoed.
   * @param server The room's clock.
   */
  pong(conn: string, at: number, server: number): void {
    this.ports.send(conn, JSON.stringify({ t: 'pong', at, server }));
  }

  /**
   * Encode and send one rows frame. Allocates nothing once the buffer has
   * seen a frame this size.
   *
   * @param conn The receiving connection.
   * @param frame The authority's step counter.
   * @param ack The last input seq applied for this player.
   * @param rows The rows, read in place, and the player's own body as the trailer.
   * @returns The bytes sent; 0 when there were no rows and no trailer (nothing is sent).
   */
  rows(conn: string, frame: number, ack: number, rows: RowSource): number {
    // A trailer goes out even with no rows: a predicting client is corrected
    // when the server held its body still (a frozen player sends no rows).
    if (rows.count === 0 && !rows.player) return 0;
    const size = this.codec.frameBytes(rows);
    const written = this.codec.encode(this.buffer.reserve(size), frame, ack, rows);
    if (written === 0) return 0;
    this.ports.send(conn, this.buffer.bytes(written));
    return written;
  }
}
