/**
 * End-to-end configuration for the browser-side packages.
 *
 * Two projects, because the engine has two backends and they fail differently:
 *
 * - **gpu** — real WebGPU in headless Chromium. Everything runs here.
 * - **webgl** — the `forceWebGL` fallback. Only the static path runs here today (the examples'
 *   characters run on the engine's WGSL path; dynamic splats on the fallback are covered by
 *   unit tests), and this project exists to prove the *static* path still renders for a player
 *   without WebGPU.
 *
 * Headless WebGPU needs care, and these flags are what was measured to work on Windows:
 *
 * - `channel: 'chromium'` is required. Playwright's default headless shell ships without
 *   WebGPU, so `navigator.gpu` is simply absent there.
 * - `--use-angle=vulkan` *kills* the adapter; do not add it back.
 * - vsync is off, otherwise every frame time reads 16.7 ms and the bench measures the
 *   compositor.
 *
 * Run it with `npx playwright test -c tests/e2e/playwright.config.ts` (a root `test:e2e`
 * script is still to be added). `npx playwright install chromium` first, once.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/** The repository root: `webServer.command` runs npm workspace scripts from there. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Port `vite preview` serves the example on. Matches `examples/splat-viewer/vite.config.ts`. */
const PORT = 4178;

/** Where the suite points the browser. */
export const BASE_URL = `http://localhost:${String(PORT)}`;

/** Port the FPS template previews on. Matches `templates/fps/vite.config.ts`. */
const FPS_PORT = 4179;

/**
 * Port the character showcase previews on. Matches
 * `examples/character-showcase/vite.config.ts`.
 */
const CHARACTER_PORT = 4180;

/**
 * Where `character-showcase.spec.ts` points the browser. Its own server, so its own
 * origin — the spec navigates with the absolute URL rather than with `baseURL`.
 */
export const CHARACTER_BASE_URL = `http://localhost:${String(CHARACTER_PORT)}`;

/** Where `fps.spec.ts` points the browser. It has its own server, so its own origin. */
export const FPS_BASE_URL = `http://localhost:${String(FPS_PORT)}`;

/**
 * Port the third-person template previews on. Matches
 * `templates/third-person/vite.config.ts`.
 */
const THIRD_PERSON_PORT = 4181;

/** Where `third-person.spec.ts` points the browser. Its own server, its own origin. */
export const THIRD_PERSON_BASE_URL = `http://localhost:${String(THIRD_PERSON_PORT)}`;

/** Port the mystery kit previews on. Matches `templates/mystery/vite.config.ts`. */
const MYSTERY_PORT = 4192;

/** Where `mystery.spec.ts` points both of its pages. */
export const MYSTERY_BASE_URL = `http://localhost:${String(MYSTERY_PORT)}`;

/**
 * Port `gameable serve --direct` runs the mystery room server on: not the
 * default 8790, so a dev's own room server can stay up beside the suite.
 */
const MYSTERY_ROOMS_PORT = 8792;

/** The room server the mystery pages join, passed as `?rooms=` (allowed on a local page). */
export const MYSTERY_ROOMS_URL = `http://127.0.0.1:${String(MYSTERY_ROOMS_PORT)}`;

/**
 * Which sandbox the FPS template is built with for this run.
 *
 * `direct` by default, because a `jco componentize` is about thirty seconds and
 * the parity test already proves the two modes agree. `GAMEABLE_E2E_WASM=1` builds
 * the component and runs exactly the same assertions against it, which is the
 * end-to-end half of that claim.
 */
export const FPS_MODE: 'direct' | 'wasm' =
  process.env.GAMEABLE_E2E_WASM === '1' ? 'wasm' : 'direct';

/** How the FPS template is built before it is previewed. */
const FPS_BUILD =
  FPS_MODE === 'wasm' ? 'npm run build -w templates/fps' : 'npm run build:direct -w templates/fps';

/**
 * Which sandbox the templates are built with. The same switch as {@link FPS_MODE}
 * under a name a second template can read without importing the first one's.
 */
export const TEMPLATE_MODE: 'direct' | 'wasm' = FPS_MODE;

/** How the third-person template is built before it is previewed. */
const THIRD_PERSON_BUILD =
  TEMPLATE_MODE === 'wasm'
    ? 'npm run build -w templates/third-person'
    : 'npm run build:direct -w templates/third-person';

/** How the mystery example is built before it is previewed. */
const MYSTERY_BUILD =
  TEMPLATE_MODE === 'wasm'
    ? 'npm run build -w templates/mystery'
    : 'npm run build:direct -w templates/mystery';

/**
 * The flags that get a real WebGPU adapter in headless Chromium.
 *
 * Exported so a spec can say in its failure message exactly what it asked for.
 */
export const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--no-sandbox',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];

export default defineConfig({
  testDir: '.',
  // A splat bench is 230 frames of real rendering; the default 30 s is not enough.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  // One worker: both projects drive the GPU, and two of them at once makes every timing
  // measurement noise.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  // Goldens live next to the suite, not in a per-spec directory, so they are easy to review.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',

  use: {
    baseURL: BASE_URL,
    // The golden is captured at this size; changing it invalidates every screenshot.
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'gpu',
      // Project selection is by file: the WebGL cases live in their own spec.
      testMatch: /(splat-viewer|fps|third-person|character-showcase|mystery)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 800, height: 600 },
        deviceScaleFactor: 1,
        channel: 'chromium',
        launchOptions: { args: WEBGPU_ARGS },
      },
    },
    {
      name: 'webgl',
      testMatch: /splat-viewer-webgl\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 800, height: 600 },
        deviceScaleFactor: 1,
        channel: 'chromium',
        launchOptions: { args: WEBGPU_ARGS },
      },
    },
  ],

  webServer: [
    {
      // Built, not dev-served: this is what a player downloads, and the dev server's module
      // graph hides bundling mistakes. `prebuild` regenerates the synthetic model, so a clean
      // clone works with no binary in the repository.
      command: 'npm run build -w examples/splat-viewer && npm run preview -w examples/splat-viewer',
      // Without this the command runs in `tests/e2e`, where `-w examples/splat-viewer` finds
      // no workspace.
      cwd: REPO_ROOT,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The character showcase. `prebuild` bakes the GNM pack from the aosRig source when
      // it is on this machine and writes a status file when it is not, so this server
      // starts either way and `character-showcase.spec.ts` skips itself rather than
      // failing on a machine without the licensed source data.
      command:
        'npm run build -w examples/character-showcase && npm run preview -w examples/character-showcase',
      cwd: REPO_ROOT,
      url: CHARACTER_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The FPS template, built the same way a player would build it. With
      // GAMEABLE_E2E_WASM=1 this also runs `jco componentize`, which is slow, hence
      // the longer timeout.
      command: `${FPS_BUILD} && npm run preview -w templates/fps`,
      cwd: REPO_ROOT,
      url: FPS_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The third-person template, same deal: built the way a player builds it,
      // and with GAMEABLE_E2E_WASM=1 through `jco componentize` as well.
      command: `${THIRD_PERSON_BUILD} && npm run preview -w templates/third-person`,
      cwd: REPO_ROOT,
      url: THIRD_PERSON_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The mystery page: the client every tab runs, built like the templates.
      command: `${MYSTERY_BUILD} && npm run preview -w templates/mystery`,
      cwd: REPO_ROOT,
      url: MYSTERY_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The mystery room server: `src/game.ts` as-is, one room. `npx gameable`
      // runs the CLI's built `dist/`, so the CLI is built first; `serve` takes
      // the game from its working directory.
      command: `npm run build -w packages/cli && cd templates/mystery && npx gameable serve --direct --port ${String(MYSTERY_ROOMS_PORT)}`,
      cwd: REPO_ROOT,
      url: `${MYSTERY_ROOMS_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
