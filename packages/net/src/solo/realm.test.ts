/**
 * Why Play Solo's authority is the wasm guest: with a direct-mode authority
 * and a direct-mode client guest in one realm, the SDK's one-direct-guest
 * check fires. This runs on the client tests' room harness (`tinyRoomServer`,
 * `TestPage`), not on `InPageAuthority`, which takes only a wasm guest. In
 * `tests/boundary/solo.test.ts` the same kind of direct client guest runs
 * beside the in-page wasm authority and nothing fires.
 */
import { createDirectSandbox } from '@gameable/wasm-host';
import { afterEach, describe, expect, it } from 'vitest';

import { TestPage } from '../client/clientPage.js';
import {
  flush,
  loadTinyGame,
  stubHost,
  tinyRoomServer,
  type LoopbackRoomServer,
} from '../client/clientTesting.js';

let server: LoopbackRoomServer | null = null;
let page: TestPage | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
  await server?.close();
  server = null;
});

describe('two direct guests in one realm (the control)', () => {
  it('a direct authority dies on its next tick once a direct client guest has started', async () => {
    server = await tinyRoomServer();
    const sandbox = createDirectSandbox({
      mode: 'direct',
      game: await loadTinyGame(),
      host: stubHost(),
    });
    page = await TestPage.open(server, sandbox);
    await flush();
    for (let i = 0; i < 5; i += 1) {
      server.step();
      await flush();
      page.frame();
      await flush();
    }
    expect(server.game.sandbox.dead).toBe(true);
    expect(server.game.sandbox.error?.message).toMatch(/two direct guests in one realm/);
  }, 60_000);
});
