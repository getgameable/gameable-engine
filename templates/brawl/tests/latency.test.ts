/**
 * The fight over a slow link: our `Room` runs the game as the authority, two
 * pages join it with 150 ms of latency each way (`latencyPair`), and each
 * page predicts its own fighter (`features.multiplayer.predict`).
 *
 * - The page's own fighter moves on the step its key goes down, not 300 ms
 *   later.
 * - A punch is the authority's: it lands where the authority has the two
 *   fighters, both pages are told, and the victim's own page ends up where
 *   the authority knocked them, though it predicted no knockback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openPage, type Page } from './page';
import { startAuthority, STEP_MS, type Authority } from './room';

let authority: Authority | null = null;
const pages: Page[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const page of pages.splice(0)) await page.close();
  await authority?.close();
  authority = null;
});

/** One 60 Hz step of the room, the link and every page. */
async function tick(): Promise<void> {
  authority?.ports.advance(STEP_MS);
  await vi.advanceTimersByTimeAsync(STEP_MS);
  for (const page of pages) page.frame(STEP_MS);
  await vi.advanceTimersByTimeAsync(0);
}

/** @param n Steps to run. */
async function run(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick();
}

/** @returns Two pages in seats 0 and 1, over 150 ms each way, a second and a half after joining. */
async function twoFighters(): Promise<[Page, Page]> {
  authority = await startAuthority(150);
  // Before the joins: the link's 150 ms are the test's to move.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const a = await openPage(authority.connect, 'Ana');
  pages.push(a);
  await run(30);
  const b = await openPage(authority.connect, 'Bo');
  pages.push(b);
  await run(90);
  expect([a.seat, b.seat]).toEqual([0, 1]);
  expect(a.entity).toBeGreaterThan(0);
  return [a, b];
}

describe('brawl over 150 ms each way', () => {
  it("moves the page's own fighter on the step D goes down", async () => {
    const [a] = await twoFighters();
    const before = a.drawn(a.entity);
    a.hold('D');
    await tick();
    const after = a.drawn(a.entity);
    expect(before).not.toBeNull();
    // walkSpeed 4.5 m/s: one step is 7.5 cm, on this page, at once.
    expect((after?.x ?? 0) - (before?.x ?? 0)).toBeCloseTo(4.5 / 60, 2);
    expect(a.deaths).toEqual([]);
  }, 120_000);

  it('a punch lands where the authority says, on both pages', async () => {
    const [a, b] = await twoFighters();
    const victim = authority?.entityOf(1) ?? 0;
    // Seat 0 starts at x -3 facing +x, seat 1 at x 3: walk up to arm's length.
    a.hold('D');
    while ((a.drawn(a.entity)?.x ?? 0) < 1.7) await tick();
    a.hold('D', false);
    await run(30); // the authority catches up with the walk
    const start = authority?.position(victim).x ?? 0;
    expect(start).toBeCloseTo(3, 1);

    a.tap('J');
    await run(90); // up, the hit, down again, and the knockback fades
    expect(a.hits()).toBe(1);
    expect(b.hits()).toBe(1);
    const server = authority?.position(victim);
    // The authority knocked the victim back along +x.
    expect((server?.x ?? 0) - start).toBeGreaterThan(0.3);
    // The victim's own page predicted no knockback (it would still be at x 3); it is drawn
    // where the authority has them, within the 2 cm a page tolerates before it corrects.
    const drawn = b.drawn(b.entity);
    expect(Math.abs((drawn?.x ?? 0) - (server?.x ?? 0))).toBeLessThanOrEqual(0.0201);
    expect(Math.abs((drawn?.z ?? 0) - (server?.z ?? 0))).toBeLessThanOrEqual(0.0201);
    expect([...a.deaths, ...b.deaths]).toEqual([]);
  }, 120_000);
});
