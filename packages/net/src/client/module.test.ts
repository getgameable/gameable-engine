/**
 * The `net` service and the `multiplayer()` loader, over loopback transports
 * to a real `Room` running the tiny game.
 */
import type { Command } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeRows } from '../protocol/rowsFunctions.js';
import type { RowSink, RowSource } from '../protocol/types.js';
import { blankInput } from '../server/room/roomTesting.js';
import { flush, tinyRoomServer, type LoopbackRoomServer } from './clientTesting.js';
import { createLoopbackConnection } from './LoopbackConnection.js';
import { multiplayer } from './module.js';
import { createNetClient, type NetClient } from './NetClient.js';

/** @returns A rows sink that remembers each row's entity. */
function countingSink(): RowSink & { entities: number[] } {
  const entities: number[] = [];
  return {
    entities,
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row: (entity) => {
      entities.push(entity);
    },
  };
}

let server: LoopbackRoomServer | null = null;
const clients: NetClient[] = [];

/**
 * @param name The player's name.
 * @param now The client's clock.
 * @returns A started client on the room.
 */
function join(name: string, now: () => number = () => 0): NetClient {
  if (server === null) throw new Error('no server');
  const client = createNetClient(createLoopbackConnection({ connect: server.connect }), {
    name,
    now,
  });
  client.start();
  clients.push(client);
  return client;
}

/**
 * Run the room for `ticks` ticks, letting frames land after each.
 *
 * @param ticks How many 60 Hz ticks.
 */
async function run(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    server?.step();
    await flush();
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.leave('done');
  await server?.close();
  server = null;
});

describe('NetClient over loopback, against a real room', () => {
  it('is joined after the welcome: its seat, its players', async () => {
    server = await tinyRoomServer();
    const ana = join('Ana');
    expect(ana.state).toBe('connecting');
    expect(ana.localPlayer).toBe(-1);
    await flush();
    expect(ana.state).toBe('joined');
    expect(ana.localPlayer).toBe(0);
    expect(ana.welcomes).toBe(1);
    const ben = join('Ben');
    await flush();
    expect(ben.localPlayer).toBe(1);
    expect(ben.players.map((p) => p.name)).toEqual(['Ana', 'Ben']);
    // Ana hears about Ben through a `players` frame.
    expect(ana.players.map((p) => [p.id, p.name, p.connected])).toEqual([
      [0, 'Ana', true],
      [1, 'Ben', true],
    ]);
  }, 60_000);

  it('a pong updates rtt', async () => {
    server = await tinyRoomServer();
    let now = 100;
    const ana = join('Ana', () => now);
    await flush();
    ana.ping();
    now = 130;
    await flush();
    expect(ana.rtt).toBe(30);
  }, 60_000);

  it("send('vote', ...) reaches the room as a msg text frame", async () => {
    server = await tinyRoomServer();
    const ana = join('Ana');
    expect(ana.send('early', {})).toBe(false); // not joined yet: nothing goes out
    await flush();
    expect(ana.send('vote', { for: 1 })).toBe(true);
    await flush();
    const texts = server.inbound.get('c1')?.texts ?? [];
    expect(texts.map((t) => t.t)).toEqual(['hello', 'msg']);
    expect(texts[1]).toEqual({ t: 'msg', name: 'vote', payload: { for: 1 } });
  }, 60_000);

  it('queues the welcome world, then cmd commands, and drains them in order once', async () => {
    server = await tinyRoomServer();
    const ana = join('Ana');
    await flush();
    await run(3);
    const seen: Command[] = [];
    ana.drainCommands((c) => seen.push(c));
    const spawns: (string | undefined)[] = [];
    for (const c of seen) if (c.tag === 'spawn') spawns.push(c.val.name);
    // The welcome's three enemies first, then the stream's own spawn: Ana's player.
    expect(spawns).toEqual(['enemy', 'enemy', 'enemy', 'player']);
    expect(ana.stats.commandFrames).toBe(3);
    const again: Command[] = [];
    ana.drainCommands((c) => again.push(c));
    expect(again).toEqual([]);
  }, 60_000);

  it('knows its own entity from the frames, and the ack of its input', async () => {
    server = await tinyRoomServer();
    const ana = join('Ana');
    await flush();
    expect(ana.localEntity).toBe(0); // nobody has an entity before the guest's next step
    await run(2);
    expect(ana.localEntity).not.toBe(0);
    expect(ana.localEntity).toBe(server.game.entityOf(0));
    expect(ana.sendInput(5, blankInput())).toBe(true);
    await flush();
    await run(2);
    expect(ana.ack).toBe(5);
  }, 60_000);

  it('drops a rows frame older than the last one applied, and counts it', async () => {
    server = await tinyRoomServer();
    const ana = join('Ana');
    await flush();
    await run(12); // the player falls: rows flow at 20 Hz
    const sink = countingSink();
    ana.drainRows(sink);
    expect(ana.stats.rowsFrames).toBeGreaterThan(0);
    const applied = ana.frame;
    // A late frame from the past, the way a reordering link delivers one.
    const one: RowSource = {
      count: 1,
      entity: () => 99,
      flags: () => 1,
      position: () => [0, 0, 0],
      rotation: () => [0, 0, 0, 1],
      scale: () => [1, 1, 1],
    };
    const out = new DataView(new ArrayBuffer(64));
    const bytes = encodeRows(out, applied - 5, 0, one);
    server.ports.ends.get('c1')?.send(new Uint8Array(out.buffer, 0, bytes));
    await flush();
    sink.entities.length = 0;
    ana.drainRows(sink);
    expect(sink.entities).toEqual([]);
    expect(ana.stats.staleRows).toBe(1);
  }, 60_000);
});

describe('multiplayer()', () => {
  it('fails with a clear error without a room server connection', async () => {
    await expect(multiplayer({})).rejects.toThrow(/no room server connection/);
  });

  it('loads the net module, which is the net service and joins once started', async () => {
    server = await tinyRoomServer();
    const loaded = await multiplayer({
      maxPlayers: 4,
      name: 'Ana',
      connection: createLoopbackConnection({ connect: server.connect }),
    });
    expect(loaded.name).toBe('multiplayer');
    expect(loaded.modules.map((m) => [m.id, m.order])).toEqual([['net', -90]]);
    const service = (await loaded.modules[0].init({} as never)) as NetClient;
    clients.push(service);
    await flush();
    expect(service.state).toBe('connecting'); // init does not join: the client loop starts it
    service.start();
    await flush();
    expect(service.state).toBe('joined');
    expect(service.maxPlayers).toBe(4);
    expect(await loaded.bind?.({} as never)).toBe(service);
  }, 60_000);
});
