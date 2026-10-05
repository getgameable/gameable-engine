/**
 * `NetClient` over a connection whose server side the test speaks for: the
 * welcome's reset, the stale-rows boundary, the bad-frame count and the room code.
 */
import type { Command } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { RowFlag } from '../protocol/constants.js';
import type { RowSink } from '../protocol/types.js';
import { createNetClient } from './NetClient.js';
import { FakeConnection, rowsFrame } from './scriptedNet.js';

/**
 * @param player The seat.
 * @param frame The authority frame.
 * @param room The room code, if the server says.
 * @returns A welcome frame with an empty world.
 */
function welcome(player: number, frame: number, room?: string): object {
  return {
    t: 'welcome',
    player,
    entity: 0,
    secret: 's',
    frame,
    snapshot: { frame, entities: [] },
    players: [],
    room,
  };
}

/** @returns A sink that lists the rows' entities. */
function sink(): RowSink & { seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row: (entity) => seen.push(entity),
  };
}

/** @returns A started client on a fake connection. */
function client() {
  const connection = new FakeConnection();
  const net = createNetClient(connection, { name: 'Ana' });
  net.start();
  return { net, connection };
}

describe('NetClient', () => {
  it('a welcome throws away the commands and messages queued before it', () => {
    const { net, connection } = client();
    connection.text(welcome(0, 10));
    const despawn: Command = { tag: 'despawn', val: 7 };
    connection.text({ t: 'cmd', frame: 11, ack: 0, entity: 0, commands: [despawn] });
    connection.text({ t: 'msg', from: 0xffffffff, name: 'old', payload: {} });
    connection.text(welcome(0, 40));
    const commands: Command[] = [];
    net.drainCommands((c) => commands.push(c));
    const messages: string[] = [];
    net.drainMessages((_from, name) => messages.push(name));
    expect(commands).toEqual([]);
    expect(messages).toEqual([]);
    expect(net.welcomes).toBe(2);
  });

  it('applies two rows frames of the same frame; only an older one is stale', () => {
    const { net, connection } = client();
    connection.text(welcome(0, 1));
    const row = (entity: number) => ({
      entity,
      flags: RowFlag.POSITION,
      position: [0, 0, 0] as [number, number, number],
    });
    connection.rows(rowsFrame(9, [row(1)]));
    connection.rows(rowsFrame(9, [row(2)]));
    connection.rows(rowsFrame(8, [row(3)]));
    const s = sink();
    net.drainRows(s);
    expect(s.seen).toEqual([1, 2]);
    expect(net.stats.staleRows).toBe(1);
  });

  it('counts bad text and bad rows together, and keeps the count across frames', () => {
    const { net, connection } = client();
    connection.events?.onText('{"t":"nonsense"}');
    connection.rows(new Uint8Array([2, 0, 0]));
    connection.rows(rowsFrame(1, []));
    net.drainRows(sink());
    expect(net.stats.badFrames).toBe(2);
  });

  it('rows from a restarted room are not stale after its welcome', () => {
    const { net, connection } = client();
    connection.text(welcome(0, 1));
    connection.rows(rowsFrame(500, [{ entity: 1, flags: 1, position: [0, 0, 0] }]));
    net.drainRows(sink());
    connection.text(welcome(0, 3));
    connection.rows(rowsFrame(4, [{ entity: 2, flags: 1, position: [0, 0, 0] }]));
    const s = sink();
    net.drainRows(s);
    expect(s.seen).toEqual([2]);
  });

  it('learns the room code from the welcome', () => {
    const { net, connection } = client();
    expect(net.room).toBeNull();
    connection.text(welcome(0, 1, 'KQTX'));
    expect(net.room).toBe('KQTX');
  });
});
