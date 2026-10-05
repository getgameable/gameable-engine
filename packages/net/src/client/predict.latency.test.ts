/**
 * Task 8.2: with `predict` on, the page's own character body moves on the
 * fixed step its key goes down, 150 ms of link latency each way or not.
 * Our Room runs the tiny game as the authority; the page's client guest is
 * a stand-in that walks its own body (so it shares no SDK realm with it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RowFlag } from '../protocol/constants.js';
import { latencyPair } from '../transport/LatencyTransport.js';
import { TestPage } from './clientPage.js';
import { tinyRoomServer, type LoopbackRoomServer } from './clientTesting.js';
import { bodyAdapter, fakeInput, pagePhysics, WALK, WalkerStub } from './predictTesting.js';

let server: LoopbackRoomServer | null = null;
let page: TestPage | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await page?.close();
  await server?.close();
  page = null;
  server = null;
});

const STEP_MS = 1000 / 60;

/**
 * @param predict The page option.
 * @returns A page joined to the tiny game's room over a 150 ms link, its input module and its guest.
 */
async function slowPage(
  predict: boolean,
): Promise<{ page: TestPage; input: ReturnType<typeof fakeInput> }> {
  server = await tinyRoomServer();
  server.pair = () => latencyPair({ ms: 150 });
  const input = fakeInput();
  let opened: TestPage | null = null;
  const adapter = bodyAdapter(() => (opened as TestPage).engine.get('physics'));
  const modules = predict ? [input, pagePhysics()] : [input];
  // Before the join: the link's 150 ms are the test's to move.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  opened = await TestPage.open(server, new WalkerStub(), adapter, modules, { predict });
  return { page: opened, input };
}

/** One 60 Hz tick of both ends, and the link's time. */
async function tick(): Promise<void> {
  server?.step();
  await vi.advanceTimersByTimeAsync(STEP_MS);
  page?.frame();
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * @param target The page.
 * @param entity The entity.
 * @param step A fixed step.
 * @returns The z the page last wrote for the entity at or before that step.
 */
function zAt(target: TestPage, entity: number, step: number): number {
  const rows = target.adapter.rows.filter((r) => r.entity === entity && r.step <= step);
  const last = rows.filter((r) => (r.flags & RowFlag.POSITION) !== 0).at(-1);
  return last?.position[2] ?? Number.NaN;
}

describe('prediction over a 150 ms link', () => {
  it('the local body moves on the step W goes down', async () => {
    const opened = await slowPage(true);
    page = opened.page;
    for (let i = 0; i < 90; i += 1) await tick(); // welcome, first trailers: the body is synced
    const me = page.net.localEntity;
    expect(me).toBeGreaterThan(0);
    const before = page.adapter.log.filter((l) => l === 'begin').length;
    opened.input.hold('W');
    await tick();
    const z0 = zAt(page, me, before);
    const z1 = zAt(page, me, before + 1);
    expect(z1).toBeLessThan(z0);
    expect(z0 - z1).toBeCloseTo(WALK / 60, 3);
    expect(page.deaths).toEqual([]);
  }, 60_000);

  it('without predict the same key moves nothing for at least 150 ms', async () => {
    const opened = await slowPage(false);
    page = opened.page;
    for (let i = 0; i < 90; i += 1) await tick();
    const me = page.net.localEntity;
    const before = page.adapter.log.filter((l) => l === 'begin').length;
    const zStill = zAt(page, me, before);
    opened.input.hold('W');
    for (let i = 0; i < 9; i += 1) await tick(); // 150 ms
    expect(zAt(page, me, before + 9)).toBeCloseTo(zStill, 5);
  }, 60_000);
});
