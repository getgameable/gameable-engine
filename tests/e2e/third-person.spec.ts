/**
 * `templates/third-person`, end to end, on a real GPU.
 *
 * This is the acceptance test for milestone M4: the second scaffold a player is
 * handed has to boot, render, take input and play, with no more configuration
 * than the first one. What each assertion is actually protecting:
 *
 * - **the boot assertions** — the whole host chain: WebGPU, the Jolt wasm, the
 *   asset manifest, the splat decode, the sandbox handshake. Any one of them
 *   failing shows up as a black canvas, which is indistinguishable from "the
 *   game has not started yet" unless something asserts it.
 * - **the golden screenshot** — that the arena, the hero and the props are
 *   actually drawn, from behind the hero rather than out of its eyes.
 * - **the camera assertions** — the whole third-person path: the guest states an
 *   orbit through `camera-state`, and the host's spring arm turns it into a
 *   camera that is *behind* and *above* the hero. If the rig is not wired up the
 *   camera sits on the hero's head and this is the test that notices.
 * - **walking and interacting** — input, the character controller, the interact
 *   cone and the HUD write, in one sequence a player would actually perform.
 * - **the conversation** — that a dialogue script read out of a JSON file
 *   survives the trip into the wasm guest, which is the one thing about this
 *   template that a bundler could quietly break.
 * - **the characters** — the hero and both NPCs reach the `skinned` path and
 *   register all four clips out of the GLB. A rig that never becomes `ready` is
 *   a missing LFS file or a broken skin, and looks like a capsule on screen.
 * - **no errors** — nothing on the page failed, and nothing logged an error.
 *   `set-expression` warns on a skinned rig, which has no blendshapes; a
 *   warning is expected and an error is not.
 * - **the mode assertion** — the direct and wasm sandboxes are meant to be
 *   interchangeable. `GAMEABLE_E2E_WASM=1` runs this same file against the
 *   componentized build; if the two ever disagree, that is an engine bug.
 *
 * Pointer lock needs a user gesture a headless browser cannot produce, so the
 * page exposes `window.__AOS_TEST__` under `?test=1` and the hooks dispatch
 * the very same DOM events the input module listens for. Without pointer lock
 * the look accumulator never moves, so the orbit stays at yaw 0 — which is why
 * every route below is walked with `W`, `A`, `S` and `D` alone.
 *
 * The tap counts asserted below are the regression test for dropped input
 * edges: this browser renders dozens of frames per fixed simulation step, and
 * the input capture accumulates edges until a step consumes one, so a single
 * synthetic press must be enough.
 */
import { expect, test, type Page } from '@playwright/test';

import { TEMPLATE_MODE, THIRD_PERSON_BASE_URL } from './playwright.config';

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
  expressionPeak: number;
  gazePeak: number;
  aimPeak: number;
}

/** Where the opt-in GNM pack is served from when someone has copied one in. */
const GNM_PACK_PATH = '/generated/myra_head.e64.aosrig';

/** The HUD model the game sends across the boundary. */
interface HudModel {
  text?: Record<string, string>;
  bars?: Record<string, { value: number; max: number }>;
  crosshair?: boolean;
  message?: string;
}

/** A point in the world. */
interface Point {
  x: number;
  y: number;
  z: number;
}

/** What the host recorded of a `set-character-state` / `set-anim` pair. */
interface AnimationState {
  bundle: number;
  state: string;
  velocity: Point;
  grounded: boolean;
  clip: string;
}

/** The synthetic-input hooks `src/main.ts` installs under `?test=1`. */
interface TestHooks {
  press(code: string): void;
  release(code: string): void;
  tap(code: string): Promise<void>;
  tick(n: number): Promise<void>;
  hud(): HudModel | null;
  camera(): Point;
  hero(): Point;
  animation(entity?: number): AnimationState | null;
  characters(): CharacterReport[];
}

/**
 * The globals the template publishes.
 *
 * Declared locally and reached through a cast rather than merged into
 * `Window`: the other specs publish a `__AOS_READY__` of their own shape, and
 * two `declare global` blocks for the same property in one program is a compile
 * error even when the shapes agree.
 */
interface GameableWindow {
  __AOS_READY__?: ReadyPayload;
  __AOS_ERROR__?: string;
  __AOS_TEST__?: TestHooks;
}

/** Shorthand for the cast, inside `page.evaluate` bodies only. */
type W = GameableWindow;

/**
 * Collect everything the page logs as an error, and everything it throws.
 *
 * @param page The page under test.
 * @returns The live list; it fills up as the page runs.
 */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // Chromium logs a bare "Failed to load resource" with no URL; the response
    // listener below reports the same thing with enough detail to act on.
    if (message.type() !== 'error') return;
    if (message.text().startsWith('Failed to load resource')) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  page.on('response', (response) => {
    // A `vite preview` page has no favicon, and Chromium asks for one anyway.
    // That 404 is the browser's, not the game's.
    if (response.status() < 400 || response.url().includes('favicon')) return;
    errors.push(`HTTP ${String(response.status())} ${response.url()}`);
  });
  return errors;
}

/**
 * Fail with the page's own error text rather than a timeout, which says nothing.
 *
 * @param page The page under test.
 * @param errors The list from {@link watchForErrors}, when there is one.
 * @returns Nothing.
 */
async function assertNoPageError(page: Page, errors: string[] = []): Promise<void> {
  const message = await page.evaluate(() => (window as unknown as W).__AOS_ERROR__ ?? '');
  expect(message, 'the game reported an error').toBe('');
  expect(errors, 'the page logged an error').toEqual([]);
}

/**
 * Open the template with the test hooks and wait for the first frames.
 *
 * @param page The page under test.
 * @param query Extra query parameters, without the leading `&`.
 * @returns What the template published.
 */
async function boot(page: Page, query = ''): Promise<ReadyPayload> {
  await page.goto(`${THIRD_PERSON_BASE_URL}/?test=1&seed=1${query === '' ? '' : `&${query}`}`, {
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

/**
 * Hold a key until the HUD prompt says what you are waiting for.
 *
 * A fixed number of frames would be a guess about the walk speed, the frame
 * budget and the collision response all at once. Walking until the game says
 * you have arrived is the assertion a player would make.
 *
 * @param page The page under test.
 * @param code The key to hold, by DOM code.
 * @param prompt The prompt to wait for.
 * @param steps How many 15-step batches to give it.
 * @returns The prompt that was on screen when it stopped.
 */
async function walkUntilPrompt(
  page: Page,
  code: string,
  prompt: string,
  steps = 24,
): Promise<string> {
  return page.evaluate(
    async ([key, wanted, batches]) => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      hooks.press(key as string);
      let seen = '';
      for (let i = 0; i < Number(batches); i += 1) {
        await hooks.tick(15);
        seen = hooks.hud()?.text?.prompt ?? '';
        if (seen === wanted) break;
      }
      hooks.release(key as string);
      await hooks.tick(4);
      return seen;
    },
    [code, prompt, steps] as const,
  );
}

test.describe('third-person template', () => {
  test('boots on WebGPU in the expected sandbox mode', async ({ page }) => {
    const errors = watchForErrors(page);
    const ready = await boot(page);
    expect(
      ready.backend,
      'the gpu project must get a real WebGPU adapter; check the launch flags',
    ).toBe('webgpu');
    expect(
      ready.mode,
      'GAMEABLE_MODE must match how the template was built (GAMEABLE_E2E_WASM=1 builds the component)',
    ).toBe(TEMPLATE_MODE);
    console.log(`third-person boot: ${JSON.stringify(ready)}`);
    await assertNoPageError(page, errors);
  });

  test('renders the arena, the hero and the props', async ({ page }) => {
    await boot(page);
    // A moment so the first splat sort has settled and the props have landed.
    await page.waitForTimeout(1200);
    // Keep the rendering golden independent of the docs branding.
    await page.addStyleTag({ content: '.brand { display: none !important; }' });
    await expect(page.locator('#canvas')).toHaveScreenshot('third-person-arena-webgpu.png', {
      maxDiffPixelRatio: 0.2,
    });
    await assertNoPageError(page);
  });

  test('shows the starting HUD the guest built', async ({ page }) => {
    await boot(page);
    const model = await hud(page);
    expect(model, 'the guest sent no HUD').not.toBeNull();
    expect(model?.text?.keys).toBe('0');
    expect(model?.text?.state).toBe('idle');
    // Third person: nothing to aim, so no crosshair and no message yet.
    expect(model?.crosshair).toBe(false);
    expect(model?.message).toBe('');
  });

  test('puts the camera behind and above the hero', async ({ page }) => {
    await boot(page);
    const view = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      await hooks.tick(10);
      return { camera: hooks.camera(), hero: hooks.hero() };
    });

    // The orbit starts at yaw 0, which puts the boom out along +Z, and the rig
    // lifts the pivot to 1.5 m. The arm is 4.5 m unless a wall shortens it.
    const behind = view.camera.z - view.hero.z;
    const above = view.camera.y - view.hero.y;
    console.log(
      `third-person camera: ${behind.toFixed(2)} m behind, ${above.toFixed(2)} m above the hero`,
    );
    expect(behind).toBeGreaterThan(1);
    expect(above).toBeGreaterThan(0);
    expect(Math.abs(view.camera.x - view.hero.x)).toBeLessThan(0.5);
    await assertNoPageError(page);
  });

  test('walks to a chest, opens it and picks up the key', async ({ page }) => {
    const errors = watchForErrors(page);
    await boot(page);

    const prompt = await walkUntilPrompt(page, 'KeyW', 'E: open chest');
    console.log(`third-person prompt: "${prompt}"`);
    expect(prompt).toBe('E: open chest');

    const travelled = await page.evaluate(() => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      return hooks ? hooks.hero().z : 0;
    });
    console.log(`third-person walk: hero is at z = ${travelled.toFixed(2)}`);
    expect(travelled).toBeLessThan(4);

    const after = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');

      /**
       * Tap a key until the game reacts, counting how many taps it took.
       *
       * `input.pressed(...)` is a one-step edge, and the input capture now
       * accumulates its edges until a fixed simulation step consumes them, so
       * one tap is enough however many frames a vsync-free headless browser
       * draws per step. The count is returned rather than hidden: a regression
       * in the capture shows up here as "it took nine taps", not as a flake.
       *
       * @param code The key, by DOM code.
       * @param done True once the effect has happened.
       * @returns How many taps it took, or 0 when it never happened.
       */
      const tapUntil = async (code: string, done: () => boolean): Promise<number> => {
        for (let i = 1; i <= 40; i += 1) {
          await hooks.tap(code);
          if (done()) return i;
        }
        return 0;
      };

      const opened = await tapUntil('KeyE', () => {
        const text = hooks.hud()?.text;
        return text?.prompt === 'E: take key' || text?.keys === '1';
      });
      const promptAfterOpening = hooks.hud()?.text?.prompt ?? '';
      const taken = await tapUntil('KeyE', () => hooks.hud()?.text?.keys === '1');
      await hooks.tick(4);
      return { opened, taken, promptAfterOpening, hud: hooks.hud() };
    });

    expect(after.opened, 'the chest never opened').toBeGreaterThan(0);
    expect(after.taken, 'the key was never picked up').toBeGreaterThan(0);
    // One tap, one press edge, one action. More than that means the capture is
    // dropping edges between rendered frames again.
    console.log(
      `third-person taps: open took ${String(after.opened)}, take took ${String(after.taken)}`,
    );
    expect(after.opened, 'opening the chest needed more than one press').toBe(1);
    expect(after.taken, 'taking the key needed more than one press').toBe(1);
    expect(after.hud?.text?.keys).toBe('1');
    console.log(`third-person chest: prompt after opening "${after.promptAfterOpening}"`);
    console.log(`third-person key: keys = ${after.hud?.text?.keys ?? '?'}`);
    await assertNoPageError(page, errors);
  });

  test('draws the hero and both NPCs as skinned characters', async ({ page }) => {
    const errors = watchForErrors(page);
    const ready = await boot(page);
    expect(ready.characters, 'the template did not build a character bridge').toBe('on');

    const characters = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      // One 3.1 MB GLB, parsed once and cloned three times.
      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(10);
        if (hooks.characters().filter((c) => c.ready).length >= 3) break;
      }
      return hooks.characters();
    });

    console.log(`third-person characters: ${JSON.stringify(characters)}`);
    const drawn = characters.filter((c) => c.kind === 'skinned' && c.ready);
    expect(drawn.length, 'the hero and both NPCs should be drawing a rig').toBe(3);
    // The hero is entity 1, from the declarative `player` block.
    expect(drawn.map((c) => c.entity)).toContain(1);
    for (const report of drawn) {
      expect([...report.clips].sort(), `clips of entity ${String(report.entity)}`).toEqual([
        'idle',
        'run',
        'walk',
        'wave',
      ]);
    }
    await assertNoPageError(page, errors);
  });

  test('reports the locomotion state the animator will blend from', async ({ page }) => {
    await boot(page);
    const states = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      await hooks.tick(4);
      const idle = hooks.animation()?.state ?? '';

      hooks.press('KeyW');
      await hooks.tick(10);
      const walk = hooks.animation()?.state ?? '';

      hooks.press('ShiftLeft');
      await hooks.tick(10);
      const run = hooks.animation()?.state ?? '';

      hooks.release('ShiftLeft');
      hooks.release('KeyW');
      await hooks.tick(10);
      return { idle, walk, run, grounded: hooks.animation()?.grounded ?? false };
    });

    console.log(`third-person locomotion: ${JSON.stringify(states)}`);
    expect(states.idle).toBe('idle');
    expect(states.walk).toBe('walk');
    expect(states.run).toBe('run');
    expect(states.grounded).toBe(true);
    await assertNoPageError(page);
  });

  test('talks to the guide, and the conversation came out of the JSON', async ({ page }) => {
    const errors = watchForErrors(page);
    await boot(page);

    // Strafe across to the guide's line, then walk up to it. No pointer lock in
    // a headless browser means no orbit, so the route has to be axis-aligned.
    const talking = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');

      hooks.press('KeyD');
      for (let i = 0; i < 20 && hooks.hero().x < 2.4; i += 1) await hooks.tick(8);
      hooks.release('KeyD');
      await hooks.tick(4);

      hooks.press('KeyW');
      let prompt = '';
      for (let i = 0; i < 24; i += 1) {
        await hooks.tick(12);
        prompt = hooks.hud()?.text?.prompt ?? '';
        if (prompt === 'E: talk') break;
      }
      hooks.release('KeyW');
      await hooks.tick(4);

      // One tap per line: see the chest test. The count is returned so a
      // regression in the input capture fails here rather than passing slowly.
      const tapUntil = async (code: string, done: () => boolean): Promise<number> => {
        for (let i = 1; i <= 40; i += 1) {
          await hooks.tap(code);
          if (done()) return i;
        }
        return 0;
      };

      const taps: number[] = [];
      taps.push(await tapUntil('KeyE', () => (hooks.hud()?.text?.speaker ?? '') !== ''));
      const first = hooks.hud();
      taps.push(await tapUntil('KeyE', () => hooks.hud()?.text?.['1'] === 'yes'));
      const question = hooks.hud();
      taps.push(await tapUntil('Digit1', () => (hooks.hud()?.text?.['1'] ?? '') === ''));
      const answer = hooks.hud();
      return { prompt, first, question, answer, taps };
    });

    console.log(`third-person dialogue taps: ${JSON.stringify(talking.taps)}`);
    // The first `E` opens the conversation; the rest advance it. Every one of
    // them is a single press.
    expect(talking.taps[0], 'starting the conversation needed more than one press').toBe(1);
    expect(talking.prompt).toBe('E: talk');
    expect(talking.first?.text?.speaker).toBe('Guide');
    // The first line of the `guide` script in src/dialogue.json.
    expect(talking.first?.text?.say).toContain('You are awake');
    console.log(`third-person dialogue: "${talking.first?.text?.say ?? ''}"`);

    // The lines run out and the yes/no branch is offered on 1 and 2.
    expect(talking.question?.text?.['1']).toBe('yes');
    expect(talking.question?.text?.['2']).toBe('no');
    expect(talking.answer?.text?.say).toContain('middle of the floor');
    await assertNoPageError(page, errors);
  });
});

/**
 * The guide NPC with a real GNM splat head, under `?gnm=1`.
 *
 * The pack is licensed source data baked by
 * `npm run gen:pack -w examples/character-showcase` and copied into
 * `templates/third-person/public/generated/` by hand — see the template's
 * README. It is not in the repository, so this whole group skips itself rather
 * than failing on a machine that does not have one.
 */
test.describe('third-person template with a GNM NPC', () => {
  test.beforeEach(async ({ request }) => {
    const probe = await request.get(`${THIRD_PERSON_BASE_URL}${GNM_PACK_PATH}`, {
      headers: { range: 'bytes=0-15' },
    });
    test.skip(
      !probe.ok(),
      `no GNM pack at ${GNM_PACK_PATH}: bake one with ` +
        '`npm run gen:pack -w examples/character-showcase` and copy it into ' +
        'templates/third-person/public/generated/. See the template README.',
    );
  });

  test('gives the guide a splat head driven by the real rig', async ({ page }) => {
    const errors = watchForErrors(page);
    const ready = await boot(page, 'gnm=1');
    expect(ready.characters, 'the template did not take the gnm path').toBe('gnm');

    const characters = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      // The pack is 7.8 MB and the rig builds its GPU buffers after it lands.
      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(10);
        if (hooks.characters().some((c) => c.ready)) break;
      }
      return hooks.characters();
    });

    console.log(`third-person characters: ${JSON.stringify(characters)}`);
    expect(characters.length, 'no NPC ever spawned a character').toBeGreaterThan(0);
    const drawn = characters.filter((c) => c.kind === 'gnm-rig' && c.ready);
    expect(drawn.length, 'no NPC reached the GNM rig path').toBeGreaterThan(0);
    expect(drawn[0].bundleId).toBe('char.guide');
    await assertNoPageError(page, errors);
  });

  test('renders the NPC head', async ({ page }) => {
    await boot(page, 'gnm=1');
    await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(10);
        if (hooks.characters().some((c) => c.ready)) break;
      }
      // Walk up to the guide so the head is big enough to see.
      hooks.press('KeyD');
      for (let i = 0; i < 20 && hooks.hero().x < 2.4; i += 1) await hooks.tick(8);
      hooks.release('KeyD');
      hooks.press('KeyW');
      for (let i = 0; i < 24; i += 1) {
        await hooks.tick(12);
        if (hooks.hud()?.text?.prompt === 'E: talk') break;
      }
      hooks.release('KeyW');
      await hooks.tick(8);
      // The spring arm sits directly behind the hero, which is directly in
      // front of the NPC — so step aside, or the golden is a picture of a
      // capsule with a head somewhere behind it.
      hooks.press('KeyA');
      await hooks.tick(22);
      hooks.release('KeyA');
      await hooks.tick(10);
    });
    await page.waitForTimeout(1200);
    // Keep the rendering golden independent of the docs branding.
    await page.addStyleTag({ content: '.brand { display: none !important; }' });
    await expect(page.locator('#canvas')).toHaveScreenshot('third-person-npc-gnm.png', {
      maxDiffPixelRatio: 0.25,
    });
    await assertNoPageError(page);
  });

  test('the head reacts to the dialogue expression and looks at the hero', async ({ page }) => {
    const errors = watchForErrors(page);
    await boot(page, 'gnm=1');

    const seen = await page.evaluate(async () => {
      const hooks = (window as unknown as GameableWindow).__AOS_TEST__;
      if (!hooks) throw new Error('no test hooks');
      /**
       * The first NPC that is actually drawing a rig.
       *
       * @returns The report, or undefined.
       */
      const drawn = (): CharacterReport | undefined =>
        hooks.characters().find((c) => c.kind === 'gnm-rig' && c.ready);

      for (let i = 0; i < 40; i += 1) {
        await hooks.tick(10);
        if (drawn() !== undefined) break;
      }
      const idle = drawn();

      // Walk to the guide and start the conversation. `show()` sends a smile
      // through `set-expression` and aims `look-at` at the hero's head.
      hooks.press('KeyD');
      for (let i = 0; i < 20 && hooks.hero().x < 2.4; i += 1) await hooks.tick(8);
      hooks.release('KeyD');
      await hooks.tick(4);
      hooks.press('KeyW');
      let prompt = '';
      for (let i = 0; i < 24; i += 1) {
        await hooks.tick(12);
        prompt = hooks.hud()?.text?.prompt ?? '';
        if (prompt === 'E: talk') break;
      }
      hooks.release('KeyW');
      await hooks.tick(4);

      for (let i = 0; i < 40; i += 1) {
        if ((hooks.hud()?.text?.speaker ?? '') !== '') break;
        await hooks.tap('KeyE');
      }
      // The head aim eases towards its target rather than snapping.
      await hooks.tick(60);
      const talking = drawn();
      return { prompt, idle, talking, speaker: hooks.hud()?.text?.speaker ?? '' };
    });

    console.log(`third-person npc face: ${JSON.stringify(seen)}`);
    expect(seen.prompt).toBe('E: talk');
    expect(seen.speaker).toBe('Guide');
    expect(seen.idle, 'no NPC reached the GNM rig path').toBeDefined();
    // A neutral face is the zero vector; the dialogue smile is not.
    expect(seen.idle?.expressionPeak).toBeCloseTo(0, 5);
    expect(seen.talking?.expressionPeak ?? 0).toBeGreaterThan(0);
    // And the head has turned towards the hero. The eyes only take what the
    // neck could not reach, so `gazePeak` stays at zero for a target the neck
    // can face squarely — which is what "the hero walked up to it" means.
    expect(seen.idle?.aimPeak).toBeCloseTo(0, 5);
    expect(seen.talking?.aimPeak ?? 0).toBeGreaterThan(0.01);
    await assertNoPageError(page, errors);
  });
});
