/**
 * Remote motion on the client: the room sends rows at 20 Hz and the page
 * steps at 60 Hz, so a moving entity must be blended between rows on every
 * step, not jump on one step in three (3.9a review I1).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { spawned, TestPage } from './clientPage.js';
import { flush, tinyRoomServer, type LoopbackRoomServer } from './clientTesting.js';

let server: LoopbackRoomServer | null = null;
let page: TestPage | null = null;

afterEach(async () => {
  await page?.close();
  await server?.close();
  page = null;
  server = null;
});

describe('remote motion between rows', () => {
  it('moves a falling remote entity on every 60 Hz step, with rows at 20 Hz', async () => {
    server = await tinyRoomServer();
    page = await TestPage.open(server);
    await flush();
    for (let i = 0; i < 40; i += 1) {
      server.step();
      await flush();
      page.frame();
      await flush();
    }
    expect(spawned(page, 'enemy')).toBe(3);
    // The enemies fall from y = 1 under gravity (the tiny game has no floor).
    const enemy = page.adapter
      .by('spawn')
      .find((c) => (c.args[5] as { name?: string }).name === 'enemy');
    const id = enemy?.args[0] as number;
    const rows = page.adapter.rows.filter((row) => row.entity === id);
    const last = rows.at(-1)?.step ?? 0;
    const window = rows.filter((row) => row.step > last - 15);
    const steps = new Set(window.map((row) => row.step));
    // Every one of the last 15 steps wrote the enemy, each lower than the step before.
    expect(steps.size).toBe(15);
    for (let i = 1; i < window.length; i += 1) {
      expect(window[i].position[1]).toBeLessThan(window[i - 1].position[1]);
    }
  }, 60_000);
});
