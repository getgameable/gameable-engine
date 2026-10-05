/**
 * `LoopbackConnection` against a real room: the states it reports, a refusal
 * that ends it, and a leave that is never retried.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { flush, tinyRoomServer, type LoopbackRoomServer } from './clientTesting.js';
import { createLoopbackConnection } from './LoopbackConnection.js';
import type { ConnectionState, RoomConnectionEvents } from './RoomConnection.js';

/** @returns Events that record every state and count every frame. */
function recorder(): RoomConnectionEvents & {
  states: [ConnectionState, string][];
  texts: string[];
} {
  const states: [ConnectionState, string][] = [];
  const texts: string[] = [];
  return {
    states,
    texts,
    onText: (text) => texts.push(text),
    onRows: () => undefined,
    onState: (state, reason) => states.push([state, reason]),
  };
}

let server: LoopbackRoomServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('LoopbackConnection', () => {
  it('connects, says hello, and is open once the welcome arrives', async () => {
    server = await tinyRoomServer();
    const connection = createLoopbackConnection({ connect: server.connect, room: 'SOLO' });
    expect(connection.state).toBe('idle');
    const events = recorder();
    connection.join({ name: 'Ana' }, events);
    expect(connection.state).toBe('connecting');
    await flush();
    expect(connection.state).toBe('open');
    expect(connection.room).toBe('SOLO'); // the code the room's welcome names
    expect(server.inbound.get('c1')?.texts[0]).toEqual({
      t: 'hello',
      v: 1,
      room: 'SOLO',
      name: 'Ana',
    });
    expect(events.states).toEqual([
      ['connecting', ''],
      ['open', ''],
    ]);
    expect(JSON.parse(events.texts[0]) as { t: string }).toMatchObject({ t: 'welcome', player: 0 });
    connection.leave('bye');
    await flush();
    expect(connection.state).toBe('closed');
    expect(events.states.at(-1)).toEqual(['closed', 'bye']);
  }, 60_000);

  it('a refusal closes it for good, with the server error as the reason', async () => {
    server = await tinyRoomServer(1);
    let opened = 0;
    const connect = server.connect;
    const counting = (): ReturnType<typeof connect> => {
      opened += 1;
      return connect();
    };
    const first = createLoopbackConnection({ connect });
    first.join({ name: 'Ana' }, recorder());
    const second = createLoopbackConnection({ connect: counting, backoff: { baseMs: 1 } });
    const events = recorder();
    second.join({ name: 'Ben' }, events);
    await flush(20);
    expect(second.state).toBe('closed');
    expect(events.states.at(-1)).toEqual(['closed', 'full']);
    expect(opened).toBe(1);
    first.leave();
  }, 60_000);

  it('reconnect() reopens the transport and resumes the seat: a fresh welcome, same player', async () => {
    server = await tinyRoomServer();
    const connection = createLoopbackConnection({
      connect: server.connect,
      backoff: { baseMs: 1 },
    });
    const events = recorder();
    connection.join({ name: 'Ana' }, events);
    connection.reconnect('early'); // not open yet: ignored
    await flush();
    expect(connection.state).toBe('open');
    connection.reconnect('resync');
    expect(connection.state).toBe('reconnecting');
    await flush(20);
    expect(connection.state).toBe('open');
    expect(events.states).toEqual([
      ['connecting', ''],
      ['open', ''],
      ['reconnecting', 'resync'],
      ['open', ''],
    ]);
    const welcomes = events.texts
      .map((text) => JSON.parse(text) as { t: string; player?: number })
      .filter((frame) => frame.t === 'welcome');
    expect(welcomes.map((w) => w.player)).toEqual([0, 0]);
    expect(server.inbound.get('c2')?.texts[0]).toMatchObject({ t: 'hello', seat: { id: 0 } });
    connection.leave();
  }, 60_000);

  it('drops sends while it is not open', async () => {
    server = await tinyRoomServer();
    const connection = createLoopbackConnection({ connect: server.connect });
    connection.join({ name: 'Ana' }, recorder());
    connection.sendText('{"t":"ping","at":1}');
    connection.sendInput(new Uint8Array([1]));
    await flush();
    expect(server.inbound.get('c1')?.texts.map((t) => t.t)).toEqual(['hello']);
    expect(server.inbound.get('c1')?.inputs).toEqual([]);
    connection.leave();
  }, 60_000);
});
