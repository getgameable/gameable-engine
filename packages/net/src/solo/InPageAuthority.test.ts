/**
 * Play Solo's authority over a stand-in wasm guest (an empty world): its
 * lifecycle. Driving, rates and boot order are in `InPageAuthority.drive.test.ts`;
 * the real tiny-game component runs in `tests/boundary/solo.test.ts`.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import { defineGame } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createNetClient, type NetClient } from '../client/NetClient.js';
import { createInPageAuthority, type InPageAuthority } from './InPageAuthority.js';
import { flush, standInGuest } from './soloTesting.js';

const DEFINITION = defineGame({ features: { multiplayer: { maxPlayers: 2 } } });
const open: InPageAuthority[] = [];

/**
 * @param prepareWorld The authority's `prepareWorld`, if any.
 * @returns An authority over the stand-in guest, not started.
 */
function authority(prepareWorld?: (world: PhysicsService) => void): InPageAuthority {
  const made = createInPageAuthority({
    guest: standInGuest(),
    definition: DEFINITION,
    seed: 7,
    prepareWorld,
  });
  open.push(made);
  return made;
}

/**
 * @param solo A started authority.
 * @returns A net client joined to it (the welcome lands on the next flush).
 */
function join(solo: InPageAuthority): NetClient {
  const net = createNetClient(solo.connection, { name: 'Ana', maxPlayers: 2 });
  net.start();
  return net;
}

/**
 * @param solo The authority.
 * @param steps How many page fixed steps, one per frame, letting frames land in between.
 */
async function frames(solo: InPageAuthority, steps: number): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    solo.step(1);
    await flush();
  }
}

afterEach(async () => {
  for (const solo of open.splice(0)) await solo.stop();
});

describe('createInPageAuthority', () => {
  it('starts a wasm-guest room in the page that a loopback connection joins', async () => {
    const solo = authority();
    await solo.start();
    expect(solo.game?.sandbox.mode).toBe('wasm');
    const net = join(solo);
    await flush();
    expect(net.state).toBe('joined');
    expect(net.room).toBe('SOLO');
    expect(net.localPlayer).toBe(0);
    expect(net.maxPlayers).toBe(2);
  }, 60_000);

  it('runs exactly one room tick per page step, and none without one', async () => {
    const solo = authority();
    await solo.start();
    const net = join(solo);
    await flush();
    // The room's first tick only ties its clock to the engine's (EngineRoomGame.tick).
    await frames(solo, 1);
    const before = solo.game?.frame ?? 0;
    const sent = net.stats.commandFrames;
    await flush(50); // wall time passes; nothing ticks
    expect(solo.game?.frame).toBe(before);
    await frames(solo, 30);
    expect((solo.game?.frame ?? 0) - before).toBe(30);
    expect(net.stats.commandFrames - sent).toBe(30);
  }, 60_000);

  it("stop() closes the connection with 'ended' and disposes the authority's Jolt world", async () => {
    const solo = authority();
    await solo.start();
    const net = join(solo);
    await flush();
    const world = solo.game?.engine.modules.get('physics');
    expect(world).toBeDefined();
    await solo.stop();
    await flush();
    expect(solo.game).toBeNull();
    expect(net.state).toBe('closed');
    expect(net.closeReason).toBe('ended');
    expect(() => world?.step(1 / 60)).toThrow(/disposed/);
  }, 60_000);

  it('start, stop, start: the second run is a fresh room with a fresh connection', async () => {
    const solo = authority();
    await solo.start();
    const first = solo.connection;
    const firstWorld = solo.game?.engine.modules.get('physics');
    join(solo);
    await flush();
    await solo.stop();
    await solo.start();
    expect(solo.connection).not.toBe(first);
    const net = join(solo);
    await flush();
    expect(net.state).toBe('joined');
    await frames(solo, 5);
    expect(net.stats.commandFrames).toBe(5);
    expect(solo.game?.engine.modules.get('physics')).not.toBe(firstWorld);
    expect(() => firstWorld?.step(1 / 60)).toThrow(/disposed/);
  }, 60_000);

  it('stop() during an in-flight start() ends the run that start makes', async () => {
    const solo = authority();
    const starting = solo.start();
    await solo.stop();
    await starting;
    expect(solo.game).toBeNull();
    expect(() => solo.connection).toThrow(/start\(\)/);
    solo.step(5);
    expect(solo.game).toBeNull();
    await solo.start(); // and it can start again
    expect(solo.game).not.toBeNull();
  }, 60_000);

  it('a prepareWorld that throws rejects start and disposes the engine; the next start works', async () => {
    const seen: { world: PhysicsService | null } = { world: null };
    let fail = true;
    const solo = authority((w) => {
      seen.world = w;
      if (fail) throw new Error('collider 404');
    });
    await expect(solo.start()).rejects.toThrow(/collider 404/);
    expect(() => seen.world?.step(1 / 60)).toThrow(/disposed/);
    expect(solo.game).toBeNull();
    fail = false;
    await solo.start();
    expect(solo.game).not.toBeNull();
  }, 60_000);

  it('a room that closes itself (its guest died) is dropped, and start works again', async () => {
    const solo = createInPageAuthority({ guest: standInGuest(4), definition: DEFINITION });
    open.push(solo);
    await solo.start(); // the warm-up runs two ticks
    const net = join(solo);
    await flush();
    await frames(solo, 5);
    expect(net.state).toBe('closed');
    expect(net.closeReason).toBe('ended: crashed');
    expect(solo.game).toBeNull();
    await solo.start();
    expect(solo.game).not.toBeNull();
  }, 60_000);

  it('refuses a sendHz the game declares out of range', async () => {
    const solo = createInPageAuthority({
      guest: standInGuest(),
      definition: defineGame({ features: { multiplayer: { sendHz: 0 } } }),
    });
    open.push(solo);
    await expect(solo.start()).rejects.toThrow(/sendHz must be a number from 1 to 60/);
  }, 60_000);

  it('refuses a second start while running, and has no connection before the first', async () => {
    const solo = authority();
    expect(() => solo.connection).toThrow(/start\(\)/);
    await solo.start();
    await expect(solo.start()).rejects.toThrow(/already running/);
  }, 60_000);
});
