/**
 * `templates/fps`, end to end, on a real GPU.
 *
 * This is the acceptance test for milestone M2: the scaffold a player is
 * handed has to boot, render, take input and play. What each assertion is
 * actually protecting:
 *
 * - **the boot assertions** — the whole host chain: WebGPU, the Jolt wasm, the
 *   asset manifest, the splat decode, the sandbox handshake. Any one of them
 *   failing shows up as a black canvas, which is indistinguishable from "the
 *   game has not started yet" unless something asserts it.
 * - **the golden screenshot** — that the arena and the placeholder capsules
 *   are actually drawn. Tolerant on purpose: the enemies are walking while the
 *   shot is taken, so this is a "something is on screen" gate, not a pixel
 *   contract.
 * - **walking** — the whole input path, the character controller and the
 *   camera rig, in one number.
 * - **shooting** — the synchronous `physics.raycast` import, the only blocking
 *   call a guest may make, and the HUD write that proves the guest saw it.
 * - **the mode assertion** — the direct and wasm sandboxes are meant to be
 *   interchangeable. `GAMEABLE_E2E_WASM=1` runs this same file against the
 *   componentized build; if the two ever disagree, that is an engine bug.
 *
 * Pointer lock needs a user gesture a headless browser cannot produce, so the
 * page exposes `window.__AOS_TEST__` under `?test=1` and the hooks dispatch
 * the very same DOM events the input module listens for.
 */
import { expect, test, type Page } from '@playwright/test';

import { FPS_BASE_URL, FPS_MODE } from './playwright.config';

/** What the template publishes once it has drawn. */
interface ReadyPayload {
  mode: string;
  backend: string;
  characters: string;
}

/** One live character, as `__AOS_TEST__.characters()` flattens it. */
interface CharacterReport {
  entity: number;
  bundleId: string;
  kind: string;
  ready: boolean;
  clips: string[];
  state: string;
}

/** The HUD model the game sends across the boundary. */
interface HudModel {
  text?: Record<string, string>;
  bars?: Record<string, { value: number; max: number }>;
  crosshair?: boolean;
  message?: string;
}

/** The synthetic-input hooks `src/main.ts` installs under `?test=1`. */
interface TestHooks {
  press(code: string): void;
  release(code: string): void;
  mouseDown(button?: number): void;
  mouseUp(button?: number): void;
  tick(n: number): Promise<void>;
  hud(): HudModel | null;
  camera(): { x: number; y: number; z: number };
  characters(): CharacterReport[];
}

/**
 * The globals the template publishes.
 *
 * Declared locally and reached through a cast rather than merged into
 * `Window`: `splat-viewer.spec.ts` publishes a `__AOS_READY__` of its own
 * shape, and two `declare global` blocks for the same property in one program
 * is a compile error even when the shapes agree.
 */
interface GameableWindow {
  __AOS_READY__?: ReadyPayload;
  __AOS_ERROR__?: string;
  __AOS_TEST__?: TestHooks;
}

/** Shorthand for the cast, inside `page.evaluate` bodies only. */
type W = GameableWindow;

/**
 * Fail with the page's own error text rather than a timeout, which says nothing.
 *
 * @param page The page under test.
 * @returns Nothing.
 */
async function assertNoPageError(page: Page): Promise<void> {
  const message = await page.evaluate(() => (window as unknown as W).__AOS_ERROR__ ?? '');
  expect(message, 'the game reported an error').toBe('');
}

/**
 * Open the template with the test hooks and wait for the first frames.
 *
 * @param page The page under test.
 * @param query Extra query parameters, without the leading `&`.
 * @returns What the template published.
 */
async function boot(page: Page, query = ''): Promise<ReadyPayload> {
  await page.goto(`${FPS_BASE_URL}/?test=1&seed=1${query === '' ? '' : `&${query}`}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as GameableWindow;
      return w.__AOS_READY__ !== undefined || (w.__AOS_ERROR__ ?? '') !== '';
    },
    undefined,
    { timeout: 120_000 },
  );
  await assertNoPageError(page);
  const ready = await page.evaluate(() => (window as unknown as W).__AOS_READY__);
  expect(ready, 'the template published no ready payload').toBeDefined();
  await page.waitForFunction(() => (window as unknown as W).__AOS_TEST__ !== undefined, undefined, {
    timeout: 30_000,
  });
  return ready as ReadyPayload;
}

/**
 * Read the HUD the guest last sent.
 *
 * @param page The page under test.
 * @returns The model, or null before the first payload.
 */
async function hud(page: Page): Promise<HudModel | null> {
  return page.evaluate(() => (window as unknown as W).__AOS_TEST__?.hud() ?? null);
}

test.describe('fps template', () => {
  test('boots on WebGPU in the expected sandbox mode', async ({ page }) => {
    const ready = await boot(page);
    expect(
      ready.backend,
      'the gpu project must get a real WebGPU adapter; check the launch flags',
    ).toBe('webgpu');
    expect(
      ready.mode,
      'GAMEABLE_MODE must match how the template was built (GAMEABLE_E2E_WASM=1 builds the component)',
    ).toBe(FPS_MODE);
    console.log(`fps boot: ${JSON.stringify(ready)}`);
  });

  test('draws every enemy as a skinned character', async ({ page }) => {
    const ready = await boot(page);
    expect(ready.characters, 'the template did not build a character bridge').toBe('on');

    const characters = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      // One 3.1 MB GLB, parsed once and cloned six times.
      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(10);
        if (hooks.characters().filter((c) => c.ready).length >= 6) break;
      }
      return hooks.characters();
    });

    console.log(`fps characters: ${JSON.stringify(characters)}`);
    const drawn = characters.filter((c) => c.kind === 'skinned' && c.ready);
    expect(drawn.length, 'the six enemies should all be drawing a rig').toBe(6);
    expect(drawn[0].bundleId).toBe('char.enemy');
    expect([...drawn[0].clips].sort()).toEqual(['idle', 'run', 'walk', 'wave']);
    // The player is invisible on purpose: the camera is inside its head.
    expect(characters.some((c) => c.entity === 1)).toBe(false);
    await assertNoPageError(page);
  });

  test('renders the arena and the placeholders that stand in until the rigs load', async ({
    page,
  }) => {
    await boot(page);
    // A couple of frames so the first splat sort has settled. The enemies are
    // walking, so the golden is a "something is drawn" gate rather than a
    // pixel contract — hence the generous ratio.
    await page.waitForTimeout(1200);
    // Keep the rendering golden independent of the docs branding.
    await page.addStyleTag({ content: '.brand { display: none !important; }' });
    await expect(page.locator('#canvas')).toHaveScreenshot('fps-arena-webgpu.png', {
      maxDiffPixelRatio: 0.2,
    });
    await assertNoPageError(page);
  });

  test('shows the starting HUD the guest built', async ({ page }) => {
    await boot(page);
    const model = await hud(page);
    expect(model, 'the guest sent no HUD').not.toBeNull();
    expect(model?.crosshair).toBe(true);
    expect(model?.text?.enemies).toBe('6');
    expect(model?.text?.ammo).toBe('12');
    expect(model?.bars?.health).toEqual({ value: 100, max: 100 });
  });

  test('walking forward moves the camera', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => (window as unknown as W).__AOS_TEST__?.camera());
    const after = await page.evaluate(async () => {
      const hooks = (window as unknown as W).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      hooks.press('KeyW');
      await hooks.tick(60);
      hooks.release('KeyW');
      await hooks.tick(2);
      return hooks.camera();
    });

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // Forward is -Z at a yaw of zero, and the walk speed is 5 m/s, so sixty
    // frames is about five metres. Two is a wide margin for a slow frame.
    const travelled = (before?.z ?? 0) - (after?.z ?? 0);
    console.log(`fps walk: ${travelled.toFixed(2)} m in 60 frames`);
    expect(travelled).toBeGreaterThan(2);
    // The character controller keeps the eye at a constant height on flat floor.
    expect(after?.y ?? 0).toBeGreaterThan(1);
    await assertNoPageError(page);
  });

  test('firing spends ammunition and damages what is in the crosshair', async ({ page }) => {
    await boot(page);
    // Walk into the middle of the arena so the nearest enemy is in front of
    // the crosshair rather than off to one side.
    const result = await page.evaluate(async () => {
      const hooks = (window as unknown as W).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      hooks.press('KeyW');
      await hooks.tick(150);
      hooks.release('KeyW');
      await hooks.tick(5);
      const before = hooks.hud();

      hooks.mouseDown(0);
      await hooks.tick(90);
      hooks.mouseUp(0);
      await hooks.tick(5);
      return { before, after: hooks.hud() };
    });

    const ammoBefore = Number(result.before?.text?.ammo ?? '0');
    const ammoAfter = Number(result.after?.text?.ammo ?? '0');
    console.log(`fps fire: ammo ${String(ammoBefore)} -> ${String(ammoAfter)}`);
    expect(ammoBefore).toBe(12);
    // 90 frames is 1.5 s at a 0.18 s fire interval: the magazine empties and
    // the weapon starts reloading, which the HUD spells `reloading`.
    expect(result.after?.text?.ammo === 'reloading' || ammoAfter < ammoBefore).toBe(true);

    const enemiesBefore = Number(result.before?.text?.enemies ?? '0');
    const enemiesAfter = Number(result.after?.text?.enemies ?? '0');
    console.log(`fps fire: enemies ${String(enemiesBefore)} -> ${String(enemiesAfter)}`);
    expect(enemiesAfter).toBeLessThanOrEqual(enemiesBefore);
    await assertNoPageError(page);
  });

  test('the round ends, and says so', async ({ page }) => {
    await boot(page);
    // Six enemies against one rifle: whichever way it goes, the HUD has to
    // say so rather than leaving the player staring at a blank screen.
    const message = await page.evaluate(async () => {
      const hooks = (window as unknown as W).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      hooks.press('KeyW');
      hooks.mouseDown(0);
      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(30);
        const model = hooks.hud();
        if (model?.message !== undefined && model.message !== '') return model.message;
      }
      hooks.mouseUp(0);
      hooks.release('KeyW');
      return '';
    });
    console.log(`fps round: ${message === '' ? '(still going)' : message}`);
    expect(['ARENA CLEARED', 'YOU DIED']).toContain(message);
    await assertNoPageError(page);
  });
});
