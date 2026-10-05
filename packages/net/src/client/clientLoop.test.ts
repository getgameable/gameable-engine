/**
 * The client loop on a headless engine, joined over loopback to a real
 * `Room` running the tiny game. Both sides are stepped by hand.
 */
import type { EngineModule } from '@gameable/core';
import type { Command } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { AUTHORITY_SENDER } from '../protocol/constants.js';
import type { Transport } from '../transport/Transport.js';
import { inputSeqs, spawned, TestPage } from './clientPage.js';
import {
  flush,
  StubSandbox,
  testClientAdapter,
  tinyRoomServer,
  type LoopbackRoomServer,
} from './clientTesting.js';

let server: LoopbackRoomServer | null = null;
const pages: TestPage[] = [];

/**
 * Step the room and the page once each, letting frames land in between.
 *
 * @param page The page.
 * @param ticks How many steps.
 */
async function both(page: TestPage, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    server?.step();
    await flush();
    page.frame();
    await flush();
  }
}

afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
  await server?.close();
  server = null;
});

describe('createClientLoop over loopback, against a real room', () => {
  it('joins, and after 30 steps on both sides has applied spawns and rows', async () => {
    server = await tinyRoomServer();
    const page = await TestPage.open(server);
    pages.push(page);
    await flush();
    await both(page, 30);
    expect(page.net.state).toBe('joined');
    expect(spawned(page, 'enemy')).toBe(3);
    expect(spawned(page, 'player')).toBe(1);
    expect(page.net.stats.rowsFrames).toBeGreaterThan(0);
    const own = page.net.localEntity;
    expect(own).toBe(server.game.entityOf(0));
    expect(page.adapter.rows.some((row) => row.entity === own)).toBe(true);
  }, 60_000);

  it('sends no INPUT before the welcome', async () => {
    server = await tinyRoomServer();
    const room = server;
    // The room's frames reach the page a macrotask late, so the page steps
    // before its welcome (the join starts inside the attach, whose awaits
    // would otherwise deliver it first).
    const late = (): Transport => {
      const link = room.connect();
      return {
        send: (data) => {
          link.send(data);
        },
        close: (reason) => {
          link.close(reason);
        },
        onClose: (fn) => {
          link.onClose(fn);
        },
        onMessage: (fn) => {
          link.onMessage((data) => {
            setTimeout(() => {
              fn(data);
            }, 0);
          });
        },
      } as Transport;
    };
    const page = await TestPage.open({ connect: late } as unknown as LoopbackRoomServer);
    pages.push(page);
    expect(page.net.state).toBe('connecting');
    for (let i = 0; i < 5; i += 1) page.frame();
    await flush();
    await flush();
    expect(page.net.state).toBe('joined');
    expect(inputSeqs(server)).toEqual([]);
    page.frame();
    await flush();
    expect(inputSeqs(server)).toEqual([1]);
  }, 60_000);

  it('sends one INPUT per fixed step, not one per rendered frame', async () => {
    server = await tinyRoomServer();
    const page = await TestPage.open(server);
    pages.push(page);
    await flush();
    page.frame(); // seq 1
    page.frame(50); // a slow frame: three fixed steps
    page.frame(1); // a fast frame: no fixed step
    page.frame(1);
    await flush();
    expect(inputSeqs(server)).toEqual([1, 2, 3, 4]);
    expect(page.net.stats.inputsSent).toBe(4);
  }, 60_000);

  it('applies the queued commands and rows after the step begins', async () => {
    server = await tinyRoomServer();
    const page = await TestPage.open(server);
    pages.push(page);
    await flush();
    await both(page, 12);
    const log = page.adapter.log;
    expect(log.filter((m) => m === 'row').length).toBeGreaterThan(0);
    // A rendered frame runs a fixed step or none, and a step begins
    // before anything the authority sent is applied: a spawn or a row never
    // lands between the frame starting and the step beginning.
    for (let i = 0; i < log.length; i += 1) {
      if (log[i] === 'frame' && i + 1 < log.length)
        expect(['begin', 'frame']).toContain(log[i + 1]);
    }
    expect(log.slice(0, 3)).toEqual(['frame', 'begin', 'spawn']);
  }, 60_000);

  it('ticks a client-role guest: it learns its seat, hears the authority, and its send goes up', async () => {
    server = await tinyRoomServer();
    const sandbox = new StubSandbox();
    const ping: Command = { tag: 'send', val: { name: 'ping', payload: '{}', reliable: true } };
    const stray: Command = {
      tag: 'spawn',
      val: {
        entity: 1,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        name: 'stray',
      },
    };
    sandbox.output.commands = [ping, stray];
    const page = await TestPage.open(server, sandbox);
    pages.push(page);
    await flush();
    expect(sandbox.inits).toEqual([]); // the seat is unknown until the welcome
    await both(page, 1);
    sandbox.output.commands = [];
    expect(sandbox.inits).toHaveLength(1);
    expect(JSON.parse(sandbox.inits[0].options ?? '{}')).toEqual({
      net: { role: 'client', localPlayer: 0, maxPlayers: 4 },
    });
    await both(page, 4);
    // The guest's `send` reached the authority as a msg frame.
    expect(server.inbound.get('c1')?.texts.some((t) => t.t === 'msg' && t.name === 'ping')).toBe(
      true,
    );
    // The authority's `pong` reached the guest as a message event from the authority.
    const heard: [number, string][] = [];
    for (const e of sandbox.events.flat())
      if (e.tag === 'message') heard.push([e.val.player, e.val.name]);
    expect(heard).toEqual([[AUTHORITY_SENDER, 'pong']]);
    // The guest's input lane is its own seat.
    expect(sandbox.inputs.at(-1)?.players.map((p) => p.player)).toEqual([0]);
    // The guest's own entity 1 is drawn as 4097, beside the authority's entity 1.
    const strays = page.adapter
      .by('spawn')
      .filter((c) => (c.args[5] as { name?: string }).name === 'stray');
    expect(strays.map((c) => c.args[0])).toEqual([4097]);
    expect(page.adapter.by('spawn').some((c) => c.args[0] === 1)).toBe(true);
    // The authority's camera for this player wins over the guest's own (fov 33).
    const last = page.adapter.cameras.at(-1);
    expect(last).toBeDefined();
    expect(last?.fovYDeg).not.toBe(33);
  }, 60_000);

  it('never reads physics, even with a physics module on the page', async () => {
    server = await tinyRoomServer();
    let reads = 0;
    const physics = {
      movingBodyCount: 1,
      readBodies: () => {
        reads += 1;
        return 0;
      },
      drainContacts: () => {
        reads += 1;
        return 0;
      },
    };
    const module: EngineModule = { id: 'physics', init: () => physics, dispose: () => undefined };
    const page = await TestPage.open(server, null, testClientAdapter(), [module]);
    pages.push(page);
    expect(page.engine.modules.tryGet('physics')).toBe(physics);
    await flush();
    await both(page, 3);
    const events = page.engine.events as unknown as { emit(type: string, payload: unknown): void };
    events.emit('physics:stepped', { dt: 1 / 60, movingBodyCount: 1, contacts: 0 });
    await both(page, 1);
    expect(reads).toBe(0);
    expect(page.adapter.bodyRows).toBe(0);
  }, 60_000);

  it('a loop with no guest handles its own death: once, then nothing', async () => {
    server = await tinyRoomServer();
    const adapter = testClientAdapter();
    const boom = new Error('spawn failed');
    adapter.spawn = () => {
      throw boom;
    };
    const page = await TestPage.open(server, null, adapter);
    pages.push(page);
    await flush();
    await both(page, 3);
    expect(page.deaths).toEqual([boom]);
    expect(inputSeqs(server)).toEqual([]);
    expect(adapter.log.filter((m) => m === 'begin')).toHaveLength(1);
  }, 60_000);

  it('a guest whose init throws is reported dead once', async () => {
    server = await tinyRoomServer();
    const sandbox = new StubSandbox();
    sandbox.failInit = new Error('init failed: bad options');
    const page = await TestPage.open(server, sandbox);
    pages.push(page);
    await flush();
    await both(page, 3);
    expect(page.deaths).toEqual([sandbox.failInit]);
    expect(sandbox.inputs).toEqual([]);
  }, 60_000);

  it('reconnects over loopback to the same seat and entity; the ack may go backwards', async () => {
    server = await tinyRoomServer();
    const page = await TestPage.open(server);
    pages.push(page);
    await flush();
    await both(page, 30);
    const entity = page.net.localEntity;
    const ackBefore = page.net.ack;
    expect(entity).not.toBe(0);
    expect(ackBefore).toBeGreaterThan(10);
    server.cut('c1');
    await flush();
    expect(page.net.state).toBe('reconnecting');
    await flush(30); // the retry (5 ms backoff) opens c2 and resumes the seat
    expect(server.lastConn).toBe('c2');
    expect(server.inbound.get('c2')?.texts[0]).toMatchObject({ t: 'hello', seat: { id: 0 } });
    expect(page.net.state).toBe('joined');
    expect(page.net.welcomes).toBe(2);
    expect(page.net.localPlayer).toBe(0);
    expect(page.net.localEntity).toBe(entity);
    await both(page, 5);
    expect(page.net.localEntity).toBe(entity);
    // The sequence restarted at 1 after the new welcome, so the ack went backwards.
    expect(inputSeqs(server, 'c2')[0]).toBe(1);
    expect(page.net.ack).toBeLessThan(ackBefore);
    expect(page.deaths).toEqual([]);
    // The old world was taken down before the welcome's was built.
    expect(page.adapter.log).toContain('despawn');
    expect(spawned(page, 'player')).toBe(2);
  }, 60_000);
});
