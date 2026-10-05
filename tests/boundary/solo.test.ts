/**
 * Play Solo with the real tiny-game component: the authority runs the wasm
 * guest in this process (the page), a `multiplayer()` client joins it over
 * loopback, and the client's own guest is a direct-mode guest of the same
 * game, the way `npm run dev` runs a page. Both sides are stepped by hand.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts solo
 * ```
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { HeadlessEngine } from '@gameable/core/headless';
import type { NetService } from '@gameable/net/client';
import type { InPageAuthority } from '@gameable/net/solo';
import type { Sandbox } from '@gameable/wasm-host';

import {
  BOUNDARY_ENABLED,
  ensureFixtureBuilt,
  FIXTURE_ASSETS,
  loadGameDefinition,
} from './harness.ts';

const MANIFEST = {
  version: 1,
  assets: FIXTURE_ASSETS.map((id) => ({ id, type: 'gltf', src: `${id}.glb` })),
};
const MS = 1000 / 60;

/** A client page: a headless engine with the `multiplayer()` feature and the client loop. */
interface Page {
  engine: HeadlessEngine;
  net: NetService;
  sandbox: Sandbox;
  adapter: Awaited<ReturnType<typeof clientTesting>>['adapter'];
  deaths: (Error | null)[];
}

/** @returns The client test helpers, loaded lazily so a skipped run imports nothing. */
async function clientTesting() {
  const testing = await import('../../packages/net/src/client/clientTesting.ts');
  return { testing, adapter: testing.testClientAdapter() };
}

/** @returns The Play Solo authority over the built component, not started. */
async function soloAuthority(): Promise<InPageAuthority> {
  const { createInPageAuthority } = await import('@gameable/net/solo');
  const { guestDir, guestEntry } = await ensureFixtureBuilt();
  return createInPageAuthority({
    guest: {
      guestModuleUrl: pathToFileURL(guestEntry).href,
      getCoreModule: async (path) => WebAssembly.compile(await readFile(`${guestDir}/${path}`)),
    },
    definition: await loadGameDefinition(),
    manifest: MANIFEST,
    seed: 7,
  });
}

/**
 * @param solo A started authority.
 * @returns A page joined to it through `multiplayer()`, its client guest direct.
 */
async function openPage(solo: InPageAuthority): Promise<Page> {
  const { multiplayer, createClientLoop } = await import('@gameable/net/client');
  const { createHeadlessEngine } = await import('@gameable/core/headless');
  const { createGameSlot, createDirectSandbox } = await import('@gameable/wasm-host');
  const { testing, adapter } = await clientTesting();
  const definition = await loadGameDefinition();
  const feature = await multiplayer({ connection: solo.connection, name: 'Ana', maxPlayers: 4 });
  const slot = createGameSlot();
  const engine = await createHeadlessEngine({
    modules: [...feature.modules, slot.module],
    fixedHz: 60,
  });
  const net = (await feature.bind(engine)) as NetService;
  const sandbox = createDirectSandbox({
    mode: 'direct',
    game: definition,
    host: testing.stubHost(),
  });
  const deaths: (Error | null)[] = [];
  const loop = createClientLoop(engine, adapter, net, sandbox, { onDead: (e) => deaths.push(e) });
  await slot.attach(loop, engine.ctx);
  engine.step(0);
  return { engine, net, sandbox, adapter, deaths };
}

/**
 * One page frame for both: one authority step, then the page's step.
 *
 * @param solo The authority.
 * @param page The page.
 * @param frames How many frames.
 */
async function both(solo: InPageAuthority, page: Page, frames: number): Promise<void> {
  let t = 0;
  for (let i = 0; i < frames; i += 1) {
    t += MS;
    solo.step(1);
    await wait(0);
    page.engine.step(t);
    await wait(0);
  }
}

describe.skipIf(!BOUNDARY_ENABLED)('Play Solo over the real tiny-game component', () => {
  it('after 30 steps of both, the multiplayer() client has applied a spawn and a ROWS frame', async () => {
    const solo = await soloAuthority();
    await solo.start();
    const page = await openPage(solo);
    await both(solo, page, 30);
    expect(page.net.state).toBe('joined');
    expect(page.adapter.log.filter((entry) => entry === 'spawn').length).toBeGreaterThanOrEqual(1);
    expect(page.net.stats.rowsFrames).toBeGreaterThanOrEqual(1);
    expect(page.adapter.rows.length).toBeGreaterThan(0);
    // The client guest is direct and the authority is wasm: the SDK's
    // one-direct-guest-per-realm check has nothing to refuse.
    expect(page.sandbox.mode).toBe('direct');
    expect(page.sandbox.dead).toBe(false);
    expect(page.deaths).toEqual([]);
    expect(solo.game?.sandbox.dead).toBe(false);
    expect(solo.game?.ended).toBeNull();
    expect(solo.game?.sandbox.mode).toBe('wasm');
    await page.engine.dispose();
    await solo.stop();
  }, 120_000);

  it("stop() disposes the authority's Jolt world, and start/stop/start runs again", async () => {
    const solo = await soloAuthority();
    await solo.start();
    const world = solo.game?.engine.modules.get('physics');
    await solo.stop();
    expect(() => world?.step(1 / 60)).toThrow(/disposed/);
    await solo.start();
    const page = await openPage(solo);
    await both(solo, page, 30);
    expect(page.net.state).toBe('joined');
    expect(page.net.stats.rowsFrames).toBeGreaterThanOrEqual(1);
    expect(page.deaths).toEqual([]);
    await page.engine.dispose();
    await solo.stop();
  }, 120_000);
});
