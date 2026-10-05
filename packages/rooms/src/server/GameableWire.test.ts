import {
  AUTHORITY_SENDER,
  decodeRows,
  parseServerText,
  RowFlag,
  type RowSink,
  type RowSource,
} from '@gameable/net';
import { describe, expect, it } from 'vitest';

import { ROOM_STATE, ROOM_STATE_PATCH } from '../channels.js';
import { createAosWire } from './GameableWire.js';

const text = (bytes: Uint8Array): ReturnType<typeof parseServerText> =>
  parseServerText(new TextDecoder().decode(bytes.subarray(1)));

const position = new Float32Array([1.5, 0, -2]);
const rotation = new Float32Array([0, 0, 0, 1]);
const rows: RowSource = {
  count: 1,
  entity: () => 7,
  flags: () => RowFlag.POSITION | RowFlag.ROTATION,
  position: () => position,
  rotation: () => rotation,
  scale: () => [],
};

describe('GameableWire', () => {
  it('puts the welcome behind ROOM_STATE with the player and their entity', () => {
    const bytes = createAosWire().welcome(1, 9, 30, '{"frame":30,"entities":[]}', [
      { id: 1, name: 'Ben', connected: true },
    ]);
    expect(bytes[0]).toBe(ROOM_STATE);
    expect(text(bytes)).toEqual({
      t: 'welcome',
      player: 1,
      entity: 9,
      secret: '',
      frame: 30,
      snapshot: { frame: 30, entities: [] },
      players: [{ id: 1, name: 'Ben', connected: true }],
    });
  });

  it("names the room's code right after t, where a client reads it from the head", () => {
    const bytes = createAosWire().welcome(0, 2, 5, '{"frame":5,"entities":[]}', [], 'KQTX');
    const head = new TextDecoder().decode(bytes.subarray(1, 30));
    expect(head).toBe('{"t":"welcome","room":"KQTX",');
    expect(text(bytes)).toMatchObject({ t: 'welcome', room: 'KQTX', player: 0, entity: 2 });
  });

  it('puts every other frame behind ROOM_STATE_PATCH', () => {
    const wire = createAosWire();
    const cmd = wire.cmd(31, 4, 9, [{ tag: 'despawn', val: 3 }]);
    expect(cmd[0]).toBe(ROOM_STATE_PATCH);
    expect(text(cmd)).toEqual({
      t: 'cmd',
      frame: 31,
      ack: 4,
      entity: 9,
      commands: [{ tag: 'despawn', val: 3 }],
    });
    const msg = wire.msg('round', '{"n":2}');
    expect(msg === null ? null : text(msg)).toEqual({
      t: 'msg',
      from: AUTHORITY_SENDER,
      name: 'round',
      payload: { n: 2 },
    });
    expect(text(wire.players([]))).toEqual({ t: 'players', players: [] });
    expect(text(wire.pong(1, 2))).toEqual({ t: 'pong', at: 1, server: 2 });
    expect(text(wire.error('budget'))).toEqual({ t: 'error', code: 'budget' });
  });

  it('refuses a msg payload over the cap', () => {
    expect(createAosWire().msg('big', `"${'x'.repeat(3000)}"`)).toBeNull();
  });

  it('gives each rows frame its own bytes (ws holds a sent buffer by reference)', () => {
    const wire = createAosWire();
    const first = wire.rows(40, 2, rows);
    position[0] = 9;
    const second = wire.rows(41, 3, rows);
    if (first === null || second === null) throw new Error('no rows');
    expect(first[0]).toBe(ROOM_STATE_PATCH);
    const sink: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: () => undefined,
    };
    expect(decodeRows(first.subarray(1), sink)).toMatchObject({ frame: 40, ack: 2, count: 1 });
    expect(sink.position[0]).toBeCloseTo(1.5);
    expect(decodeRows(second.subarray(1), sink)).toMatchObject({ frame: 41 });
    expect(sink.position[0]).toBeCloseTo(9);
    expect(wire.rows(42, 3, { ...rows, count: 0 })).toBeNull();
  });
});
