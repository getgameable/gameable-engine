/**
 * The rows frame's optional player trailer (Task 8.1): the receiving
 * player's own body as the authority has it, and the input seq it follows.
 */
import { describe, expect, it } from 'vitest';

import { PlayerRowFlag, PLAYER_TRAILER_BYTES, RowFlag, ROWS_HEADER_BYTES } from './constants.js';
import { decodeRows, encodeRows, rowsFrameBytes } from './rowsFunctions.js';
import type { PlayerRow, PlayerRowSource, RowSink, RowSource } from './types.js';

const position = new Float32Array([1.5, 0.25, -2]);
const rotation = new Float32Array([0, 0, 0, 1]);
const scale = new Float32Array([1, 1, 1]);

/**
 * @param player The trailer, or none.
 * @param count Rows (all entity 7).
 * @returns A source.
 */
function source(player: PlayerRowSource | null, count = 1): RowSource {
  return {
    count,
    entity: () => 7,
    flags: () => RowFlag.POSITION | RowFlag.ROTATION,
    position: () => position,
    rotation: () => rotation,
    scale: () => scale,
    player,
  };
}

const body: PlayerRowSource = {
  entity: 12,
  position: new Float32Array([3.25, 1.0625, -7.5]),
  velocity: new Float32Array([4, -0.5, 0]),
  flags: PlayerRowFlag.GROUNDED,
};

/** @returns A sink that keeps each row's entity and every trailer it is handed, copied. */
function recorder(): RowSink & { entities: number[]; players: PlayerRow[] } {
  const sink = {
    entities: [] as number[],
    players: [] as PlayerRow[],
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row(entity: number) {
      sink.entities.push(entity);
    },
    player(row: PlayerRow) {
      sink.players.push({
        ...row,
        position: Float32Array.from(row.position),
        velocity: Float32Array.from(row.velocity),
      });
    },
  };
  return sink;
}

const buffer = new ArrayBuffer(1024);
const view = new DataView(buffer);

describe('rows frame: the player trailer', () => {
  it('round-trips position, velocity, flags and the seq (the ack) exactly', () => {
    const written = encodeRows(view, 600, 41, source(body));
    expect(written).toBe(rowsFrameBytes(source(body)));
    expect(written).toBe(ROWS_HEADER_BYTES + 21 + PLAYER_TRAILER_BYTES);
    const sink = recorder();
    const header = decodeRows(new Uint8Array(buffer, 0, written), sink);
    expect(header?.count).toBe(1);
    expect(header?.player?.seq).toBe(41);
    expect(sink.entities).toEqual([7]);
    expect(sink.players).toHaveLength(1);
    const got = sink.players[0];
    expect(got.entity).toBe(12);
    expect(got.seq).toBe(41);
    expect(Array.from(got.position)).toEqual([3.25, 1.0625, -7.5]);
    expect(Array.from(got.velocity)).toEqual([4, -0.5, 0]);
    expect(got.flags).toBe(PlayerRowFlag.GROUNDED);
  });

  it('carries a trailer with no rows (the player stood still while the server held them)', () => {
    const written = encodeRows(view, 3, 9, source(body, 0));
    expect(written).toBe(ROWS_HEADER_BYTES + PLAYER_TRAILER_BYTES);
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)?.player?.entity).toBe(12);
    expect(sink.players[0].flags).toBe(PlayerRowFlag.GROUNDED);
  });

  it('is absent for a spectator: the frame is byte-for-byte the old one', () => {
    const without = encodeRows(view, 600, 41, source(null));
    const old = Array.from(new Uint8Array(buffer, 0, without));
    const legacy = source(null);
    delete (legacy as { player?: unknown }).player;
    expect(encodeRows(view, 600, 41, legacy)).toBe(without);
    expect(Array.from(new Uint8Array(buffer, 0, without))).toEqual(old);
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, without), sink)?.player).toBeNull();
    expect(sink.players).toEqual([]);
  });

  it('is ignored by a sink that does not ask for it (a client without prediction)', () => {
    const written = encodeRows(view, 600, 41, source(body));
    const rows: number[] = [];
    const plain: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: (entity) => rows.push(entity),
    };
    expect(decodeRows(new Uint8Array(buffer, 0, written), plain)?.count).toBe(1);
    expect(rows).toEqual([7]);
  });

  it('refuses a cut trailer, an unknown tag, unknown flags or a non-finite lane', () => {
    const written = encodeRows(view, 600, 41, source(body));
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written - 1), sink)).toBeNull();
    const at = written - PLAYER_TRAILER_BYTES;
    const bad = (edit: (bytes: Uint8Array, d: DataView) => void): unknown => {
      const bytes = new Uint8Array(buffer.slice(0, written));
      edit(bytes, new DataView(bytes.buffer));
      return decodeRows(bytes, sink);
    };
    expect(
      bad((b) => {
        b[at] = 9;
      }),
    ).toBeNull();
    expect(
      bad((b) => {
        b[written - 1] = 0x80;
      }),
    ).toBeNull();
    expect(
      bad((_b, d) => {
        d.setFloat32(at + 9, Number.NaN, true);
      }),
    ).toBeNull();
    expect(
      bad((_b, d) => {
        d.setFloat32(at + 25, Number.POSITIVE_INFINITY, true);
      }),
    ).toBeNull();
    expect(sink.entities).toEqual([]); // nothing reached the sink from a bad frame
    expect(sink.players).toEqual([]);
  });

  it('writes a non-finite source lane as 0, so the decoder never refuses its own frame', () => {
    const odd: PlayerRowSource = { ...body, velocity: [Number.NaN, 1, Number.POSITIVE_INFINITY] };
    const written = encodeRows(view, 1, 1, source(odd));
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)).not.toBeNull();
    expect(Array.from(sink.players[0].velocity)).toEqual([0, 1, 0]);
  });
});
