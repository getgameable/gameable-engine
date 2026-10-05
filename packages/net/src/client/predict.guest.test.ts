/**
 * Task 8.2 with the real SDK as the client guest: a game whose movement
 * system runs `on: 'both'` walks only this page's player on the client, on
 * a body it spawns for itself, and the page predicts that body. The page is
 * the only SDK guest in this realm (a scripted room stands in for the
 * authority).
 */
import { createDirectSandbox } from '@gameable/wasm-host';
import { afterEach, describe, expect, it } from 'vitest';

import { stubHost } from './clientTesting.js';
import predictGame from './predictGame.js';
import { WalkerStub } from './predictTesting.js';
import { PredictPage, TruthServer } from './scriptedAuthority.js';

let page: PredictPage | null = null;
let server: TruthServer | null = null;

afterEach(async () => {
  await page?.close();
  server?.dispose();
  page = null;
  server = null;
});

describe('a real client guest, predicting', () => {
  it('adds one body for its own player, and that body moves on the step W goes down', async () => {
    const sandbox = createDirectSandbox({ mode: 'direct', game: predictGame, host: stubHost() });
    page = await PredictPage.open(sandbox);
    server = await TruthServer.create();
    for (let seq = 1; seq <= 10; seq += 1) {
      page.frame();
      server.step(seq, false);
    }
    page.net.pushFrame(server.frame(1, 10)); // the first trailer places the body
    page.frame();
    page.frame();
    expect(sandbox.dead).toBe(false);
    expect(page.adapter.adds).toBe(1);
    // A client guest makes no shared entity: its one spawn is its own body, in the local range.
    const spawns = page.adapter.by('spawn').map((c) => c.args[0] as number);
    expect(spawns.filter((e) => e < 4096)).toEqual([40]); // only the welcome's player
    const still = page.drawn();
    page.input.hold('W');
    page.frame();
    const moved = page.drawn();
    expect(still[2] - moved[2]).toBeCloseTo(4 / 60, 3);
  }, 60_000);

  it("takes only the first character body: a second one and a dynamic box stay the authority's", async () => {
    const guest = new WalkerStub();
    guest.extraBodies = true;
    page = await PredictPage.open(guest);
    page.frame();
    page.frame();
    expect(page.adapter.adds).toBe(1);
    expect(page.engine.get('physics').bodyCount).toBe(1);
  }, 60_000);
});
