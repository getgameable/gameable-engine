/**
 * `templates/mystery`, two players, end to end: two pages against one
 * `gameable serve --direct` room server.
 *
 * What it protects:
 *
 * - **the join** — the page's whole room path: `?room=new` makes a room on the
 *   server, the welcome arrives, and the page reaches `joined`. A page that
 *   never leaves `connecting` is a wrong `?rooms=`, a refused origin or a
 *   catalog name the server does not know.
 * - **the second seat** — the copied code reaches the same room, and the
 *   second page's room list (`__AOS_TEST__.players()`, the server's own
 *   `players` list) names both players, in seats 0 and 1.
 * - **no errors** — neither page failed or logged an error.
 *
 * Both servers come from `playwright.config.ts`'s `webServer` list.
 * Run it on a machine with a GPU: `npm run test:e2e -- mystery`.
 */
import { expect, test, type Page } from '@playwright/test';

import { MYSTERY_BASE_URL, MYSTERY_ROOMS_URL } from './playwright.config';

/** One player in the room, as the page's test hook reports them. */
interface TestPlayer {
  id: number;
  name: string;
  connected: boolean;
}

/** What `templates/mystery/src/testHooks.ts` installs under `?test=1`. */
interface TestHooks {
  state(): string;
  room(): string | null;
  localPlayer(): number;
  players(): TestPlayer[];
}

/** The page globals this spec reads. */
interface W {
  __AOS_READY__?: { mode: string; backend: string; characters: string };
  __AOS_ERROR__?: string;
  __AOS_TEST__?: TestHooks;
}

/**
 * @param room `new`, or a room code.
 * @returns The page address that joins it on the suite's room server.
 */
function roomUrl(room: string): string {
  return `${MYSTERY_BASE_URL}/?room=${encodeURIComponent(room)}&rooms=${encodeURIComponent(MYSTERY_ROOMS_URL)}&test=1`;
}

/**
 * Collect console errors and page errors, so a failure says what went wrong.
 *
 * @param page The page.
 * @returns The list, filled as the page runs.
 */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * Wait until the page has joined its room.
 *
 * @param page The page.
 * @returns The room's code.
 */
async function joined(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      if (w.__AOS_ERROR__ !== undefined) return true;
      return w.__AOS_TEST__?.state() === 'joined';
    },
    undefined,
    { timeout: 120_000 },
  );
  const error = await page.evaluate(() => (window as unknown as W).__AOS_ERROR__);
  expect(error, 'the page reported an error').toBeUndefined();
  const room = await page.evaluate(() => (window as unknown as W).__AOS_TEST__?.room() ?? null);
  expect(room, 'the welcome carried no room code').toMatch(/^[A-Z0-9]{4}$/);
  return room as string;
}

test.describe('mystery, two players', () => {
  test('both pages join one room, and the second sees two players', async ({ browser }) => {
    const first = await browser.newPage();
    const second = await browser.newPage();
    const firstErrors = errorsOf(first);
    const secondErrors = errorsOf(second);
    try {
      await first.goto(roomUrl('new'));
      const code = await joined(first);
      expect(await first.evaluate(() => (window as unknown as W).__AOS_TEST__?.localPlayer())).toBe(
        0,
      );

      await second.goto(roomUrl(code));
      expect(await joined(second)).toBe(code);
      expect(
        await second.evaluate(() => (window as unknown as W).__AOS_TEST__?.localPlayer()),
      ).toBe(1);

      await second.waitForFunction(
        () => ((window as unknown as W).__AOS_TEST__?.players().length ?? 0) >= 2,
        undefined,
        { timeout: 30_000 },
      );
      const players = await second.evaluate(
        () => (window as unknown as W).__AOS_TEST__?.players() ?? [],
      );
      expect(players.map((p) => p.id).sort()).toEqual([0, 1]);
      expect(players.every((p) => p.connected)).toBe(true);

      expect(firstErrors, 'the first page logged errors').toEqual([]);
      expect(secondErrors, 'the second page logged errors').toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
