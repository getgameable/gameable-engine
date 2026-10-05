/**
 * `NetClient` when the page stops stepping or the link goes quiet: the
 * neutral input a hidden tab sends, the bounded queues and their resync, the
 * reconnect after 2 s of silence, and the change listener the badge uses.
 */
import { describe, expect, it } from 'vitest';

import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { createInputCodec } from '../protocol/InputCodec.js';
import { blankInput } from '../server/room/roomTesting.js';
import { createNetClient } from './NetClient.js';
import type { NetClientOptions } from './NetClientOptions.js';
import { FakeConnection, rowsFrame } from './scriptedNet.js';

/**
 * @param player The seat.
 * @param frame The authority frame.
 * @returns A welcome frame with an empty world.
 */
function welcome(player: number, frame: number): object {
  const snapshot = { frame, entities: [] };
  return { t: 'welcome', player, entity: 0, secret: 's', frame, snapshot, players: [] };
}

/**
 * @param options The client's options.
 * @returns A joined client on a fake connection.
 */
function joined(options: NetClientOptions = {}) {
  const connection = new FakeConnection();
  const net = createNetClient(connection, { name: 'Ana', ...options });
  net.start();
  connection.text(welcome(0, 1));
  connection.state = 'open';
  return { net, connection };
}

/**
 * @param frame The frame.
 * @returns A `cmd` frame with no commands.
 */
function cmd(frame: number): object {
  return { t: 'cmd', frame, ack: 0, entity: 0, commands: [] };
}

const W_WORD = 0;
const W_BIT = 1 << 3;

describe('NetClient: a hidden tab lets go of its keys', () => {
  it('releaseInput sends one INPUT with nothing held and focused false, at the last seq', () => {
    const { net, connection } = joined();
    const held = blankInput();
    held.down[W_WORD] = W_BIT;
    expect(net.sendInput(7, held)).toBe(true);
    expect(net.releaseInput()).toBe(true);
    expect(connection.inputs).toHaveLength(2);
    const decoded = blankInput();
    const head = createInputCodec().decode(connection.inputs[1], decoded);
    expect(head?.seq).toBe(7);
    expect(Array.from(decoded.down)).toEqual(new Array<number>(KEY_WORDS).fill(0));
    expect(decoded.released[W_WORD] & W_BIT).toBe(W_BIT); // W came up
    expect(decoded.focused).toBe(false);
  });

  it('sends nothing before the welcome', () => {
    const connection = new FakeConnection();
    const net = createNetClient(connection);
    net.start();
    expect(net.releaseInput()).toBe(false);
    expect(connection.inputs).toEqual([]);
  });
});

describe('NetClient: bounded queues', () => {
  it('past 3 s of rows frames at 20 Hz it drops the queues and resyncs once, at the next step', () => {
    const { net, connection } = joined();
    for (let i = 0; i < 60; i += 1) connection.rows(rowsFrame(2 + i, []));
    expect(net.queued.rows).toBe(60);
    expect(net.stats.resyncs).toBe(0);
    connection.rows(rowsFrame(62, []));
    expect(net.queued).toEqual({ rows: 0, commandFrames: 0, messages: 0 });
    expect(net.stats.resyncs).toBe(1);
    // Nothing more is queued until the fresh welcome: the world is replaced anyway.
    for (let i = 0; i < 500; i += 1) connection.rows(rowsFrame(63 + i, []));
    connection.text(cmd(70));
    expect(net.queued).toEqual({ rows: 0, commandFrames: 0, messages: 0 });
    expect(connection.reconnects).toEqual([]); // a hidden tab does not reconnect
    net.watch(1000 / 60);
    expect(connection.reconnects).toEqual(['resync']);
    net.watch(1000 / 60);
    expect(connection.reconnects).toEqual(['resync']);
    expect(net.stats.resyncs).toBe(1);
    connection.text(welcome(0, 600));
    connection.rows(rowsFrame(601, []));
    expect(net.queued.rows).toBe(1);
  });

  it('caps cmd frames at 3 s of room ticks and messages at 256', () => {
    const a = joined();
    for (let i = 0; i < 181; i += 1) a.connection.text(cmd(2 + i));
    expect(a.net.stats.resyncs).toBe(1);
    const b = joined();
    for (let i = 0; i < 257; i += 1)
      b.connection.text({ t: 'msg', from: 0xffffffff, name: 'n', payload: i });
    expect(b.net.stats.resyncs).toBe(1);
  });

  it('a drain resets the count', () => {
    const { net, connection } = joined();
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 40; i += 1) connection.text(cmd(2 + round * 40 + i));
      net.drainCommands(() => undefined);
    }
    expect(net.stats.resyncs).toBe(0);
  });
});

describe('NetClient: a silent link', () => {
  it('reconnects after 2 s of steps with no server frame, and says reconnecting', () => {
    const { net, connection } = joined();
    for (let i = 0; i < 119; i += 1) net.watch(1000 / 60);
    expect(connection.reconnects).toEqual([]);
    connection.text(cmd(5)); // a frame: the clock starts again
    for (let i = 0; i < 119; i += 1) net.watch(1000 / 60);
    expect(connection.reconnects).toEqual([]);
    net.watch(1000 / 60);
    net.watch(1000 / 60);
    expect(connection.reconnects).toEqual(['silent']);
    expect(net.state).toBe('reconnecting');
    expect(net.stats.silences).toBe(1);
  });

  it('counts only steps: a tab that ran no steps for minutes is not silent', () => {
    const { net, connection } = joined();
    net.watch(1000 / 60); // the first step back
    expect(connection.reconnects).toEqual([]);
  });

  it('does nothing before the welcome or while reconnecting', () => {
    const connection = new FakeConnection();
    const net = createNetClient(connection);
    net.start();
    for (let i = 0; i < 300; i += 1) net.watch(1000 / 60);
    expect(connection.reconnects).toEqual([]);
  });

  it('takes its threshold from silenceMs', () => {
    const { net, connection } = joined({ silenceMs: 100 });
    for (let i = 0; i < 7; i += 1) net.watch(1000 / 60);
    expect(connection.reconnects).toEqual(['silent']);
  });
});

describe('NetClient: change listeners', () => {
  it('hears state, room and closeReason changes as they happen, outside any frame', () => {
    const connection = new FakeConnection();
    const net = createNetClient(connection);
    const seen: string[] = [];
    const off = net.onChange(() => seen.push(`${net.state}/${String(net.room)}`));
    net.start();
    connection.text({ ...welcome(0, 1), room: 'KQTX' });
    connection.text(cmd(2)); // no change: not heard
    connection.events?.onState('reconnecting', 'lost');
    off();
    connection.events?.onState('closed', 'lost');
    expect(seen).toEqual(['joined/KQTX', 'reconnecting/KQTX']);
  });
});
