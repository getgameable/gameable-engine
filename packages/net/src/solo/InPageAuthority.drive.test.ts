/**
 * Play Solo's authority, driven: lockstep with the page's fixed steps through
 * `drive`, the game's send rate, the boot order, and a client leaving. The
 * guest is the tiny game behind a wasm-mode stand-in (`tinyStandIn.ts`), so
 * its enemies fall and rows flow.
 */
import type { EngineModule } from '@gameable/core';
import { createHeadlessEngine, type HeadlessEngine } from '@gameable/core/headless';
import { defineGame } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { TINY_MANIFEST } from '../client/clientTesting.js';
import { createNetClient, type NetClient } from '../client/NetClient.js';
import { createInPageAuthority, type InPageAuthority } from './InPageAuthority.js';
import { flush, standInGuest, tinyStandInGuest } from './soloTesting.js';
import { bootLog } from './tinyStandIn.js';

const open: InPageAuthority[] = [];
/** A rows sink that reads nothing. */
const SINK = {
  position: new Float32Array(3),
  rotation: new Float32Array(4),
  scale: new Float32Array(3),
  row: (): void => undefined,
};
const engines: HeadlessEngine[] = [];

/** A page whose fixed steps are counted. */
interface Page {
  engine: HeadlessEngine;
  steps: () => number;
}

/** @returns A headless page engine (60 Hz, the default 5 substeps a frame) that counts its fixed steps. */
async function countingPage(): Promise<Page> {
  let steps = 0;
  const counter: EngineModule = {
    id: 'counter',
    init: () => undefined,
    dispose: () => undefined,
    fixedUpdate: () => {
      steps += 1;
    },
  };
  const engine = await createHeadlessEngine({ modules: [counter], fixedHz: 60 });
  engines.push(engine);
  engine.step(0);
  return { engine, steps: () => steps };
}

/**
 * @param sendHz The game's declared rows rate, or undefined for the default.
 * @returns A started authority over the tiny game.
 */
async function tinyAuthority(sendHz?: number): Promise<InPageAuthority> {
  const multiplayer = sendHz === undefined ? { maxPlayers: 4 } : { maxPlayers: 4, sendHz };
  const solo = createInPageAuthority({
    guest: tinyStandInGuest(),
    definition: defineGame({ features: { multiplayer } }),
    manifest: TINY_MANIFEST,
    seed: 7,
  });
  open.push(solo);
  await solo.start();
  return solo;
}

/**
 * @param solo A started authority.
 * @returns A joined net client (after one flush).
 */
async function join(solo: InPageAuthority): Promise<NetClient> {
  const net = createNetClient(solo.connection, { name: 'Ana', maxPlayers: 4 });
  net.start();
  await flush();
  return net;
}

afterEach(async () => {
  for (const solo of open.splice(0)) await solo.stop();
  for (const engine of engines.splice(0)) await engine.dispose();
});

describe('InPageAuthority.drive: lockstep with the page', () => {
  it('at a steady 10 fps the authority runs exactly as many steps as the page', async () => {
    const solo = createInPageAuthority({ guest: standInGuest(), definition: defineGame({}) });
    open.push(solo);
    await solo.start();
    const page = await countingPage();
    solo.step(1); // the room's first tick only ties its clock to the engine's
    solo.drive(page.engine);
    const before = solo.game?.frame ?? 0;
    for (let i = 1; i <= 30; i += 1) page.engine.step(i * 100);
    expect(page.steps()).toBe(150); // 6 due per frame, capped at 5
    expect((solo.game?.frame ?? 0) - before).toBe(page.steps());
  }, 60_000);

  it('a 250 ms hitch costs the authority the same capped steps as the page, no more', async () => {
    const solo = createInPageAuthority({ guest: standInGuest(), definition: defineGame({}) });
    open.push(solo);
    await solo.start();
    const page = await countingPage();
    solo.step(1);
    solo.drive(page.engine);
    const before = solo.game?.frame ?? 0;
    page.engine.step(1000 / 60);
    page.engine.step(1000 / 60 + 250);
    page.engine.step(2000 / 60 + 250);
    expect(page.steps()).toBe(7); // 1, then the cap of 5, then 1
    expect((solo.game?.frame ?? 0) - before).toBe(7);
  }, 60_000);
});

describe('InPageAuthority over the tiny game', () => {
  it("sends rows at the game's declared sendHz", async () => {
    const counts: number[] = [];
    for (const sendHz of [10, undefined]) {
      const solo = await tinyAuthority(sendHz);
      const net = await join(solo);
      for (let i = 0; i < 60; i += 1) {
        solo.step(1);
        await flush();
        net.drainRows(SINK); // the client loop's job: rowsFrames counts drained frames
      }
      counts.push(net.stats.rowsFrames);
      await solo.stop();
    }
    expect(counts[0]).toBeGreaterThanOrEqual(9);
    expect(counts[0]).toBeLessThanOrEqual(11);
    expect(counts[1]).toBeGreaterThanOrEqual(19); // the default, 20
  }, 60_000);

  it("runs prepareWorld before the guest's init", async () => {
    bootLog.length = 0;
    const solo = createInPageAuthority({
      guest: tinyStandInGuest(),
      definition: defineGame({ features: { multiplayer: { maxPlayers: 4 } } }),
      prepareWorld: () => {
        bootLog.push('prepare');
      },
    });
    open.push(solo);
    await solo.start();
    expect(bootLog).toEqual(['prepare', 'init']);
  }, 60_000);

  it('a client that leaves reaches the room: its seat is held, not connected', async () => {
    const solo = await tinyAuthority();
    const net = await join(solo);
    expect(solo.room?.players[0]?.conn).not.toBeNull();
    net.leave('bye');
    await flush();
    expect(solo.room?.players.length).toBe(1);
    expect(solo.room?.players[0]?.conn).toBeNull();
  }, 60_000);
});
