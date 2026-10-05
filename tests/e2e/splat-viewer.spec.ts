/**
 * The splat viewer, end to end, on a real GPU.
 *
 * What each assertion is actually protecting:
 *
 * - **the golden screenshot** — the whole static pipeline: SPZ decode, the covariance repack,
 *   the sort, the TSL material. Every one of those can fail silently into a black canvas or a
 *   grey fog, and none of them has a unit test that would notice.
 * - **`sortsPerFrame === 1` in dynamic mode** — `markGaussiansChanged`. Without it a moving
 *   avatar in front of a still camera renders in a stale depth order, which looks *almost*
 *   right, which is the worst kind of wrong.
 * - **`writeBufferPerFrame`** — the claim the fork exists to make. A producer that silently
 *   fell back to uploading gaussians from the CPU would still render correctly.
 * - **zero validation errors** — WebGPU validation failures are silent by default.
 * - **the WebGL project** — a player without WebGPU still sees the world.
 */
import { expect, test, type Page } from '@playwright/test';

/** What `?bench=1` publishes on `window`. */
interface BenchPayload {
  mode: string;
  backend: string;
  count: number;
  frames: number;
  sortMsP50: number;
  gpuMsP50: number;
  animateMsP50: number;
  sortCpuMsP50: number;
  frameMsP50: number;
  frameMsP95: number;
  sortsPerFrame: number;
  writeBufferPerFrame: number;
  writeBufferBytesPerFrame: number;
  validationErrors: string[];
  url: string;
}

/** What the viewer publishes once it has drawn. */
interface ReadyPayload {
  mode: string;
  backend: string;
  splats: number;
}

declare global {
  interface Window {
    __AOS_BENCH__?: BenchPayload;
    __AOS_READY__?: ReadyPayload;
    __AOS_ERROR__?: string;
  }
}

/**
 * Fail with the page's own error text rather than a timeout, which says nothing.
 *
 * @param page The page under test.
 * @returns Nothing.
 */
async function assertNoPageError(page: Page): Promise<void> {
  const message = await page.evaluate(() => window.__AOS_ERROR__ ?? '');
  expect(message, 'the viewer reported an error').toBe('');
}

/**
 * Wait for the viewer to have rendered.
 *
 * @param page The page under test.
 * @returns What the viewer published.
 */
async function waitForReady(page: Page): Promise<ReadyPayload> {
  await page.waitForFunction(
    () => window.__AOS_READY__ !== undefined || (window.__AOS_ERROR__ ?? '') !== '',
    undefined,
    { timeout: 90_000 },
  );
  await assertNoPageError(page);
  const ready = await page.evaluate(() => window.__AOS_READY__);
  expect(ready).toBeDefined();
  return ready as ReadyPayload;
}

/**
 * Run a `?bench=1` URL and return the numbers.
 *
 * @param page The page under test.
 * @param query Query string, without the leading `?`.
 * @returns The published report.
 */
async function runBench(page: Page, query: string): Promise<BenchPayload> {
  await page.goto(`/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__AOS_BENCH__ !== undefined || (window.__AOS_ERROR__ ?? '') !== '',
    undefined,
    { timeout: 150_000 },
  );
  await assertNoPageError(page);
  const report = await page.evaluate(() => window.__AOS_BENCH__);
  expect(report, 'the bench published no report').toBeDefined();
  return report as BenchPayload;
}

test.describe('gpu', () => {
  test('the browser actually got a WebGPU adapter', async ({ page }) => {
    await page.goto('/');
    const adapter = await page.evaluate(async () => {
      if (!('gpu' in navigator)) return { ok: false, why: 'navigator.gpu is missing' };
      const gpuAdapter = await navigator.gpu.requestAdapter();
      if (gpuAdapter === null) return { ok: false, why: 'requestAdapter() returned null' };
      return { ok: true, why: JSON.stringify(gpuAdapter.info ?? {}) };
    });
    expect(
      adapter.ok,
      `no WebGPU adapter (${adapter.why}). The gpu project needs channel "chromium" ` +
        '(the default headless shell has no WebGPU) and must not pass --use-angle=vulkan.',
    ).toBe(true);
    console.log(`gpu adapter: ${adapter.why}`);
  });

  test('static: the synthetic SPZ renders', async ({ page }) => {
    // ?orbit=0 freezes the camera at its initial pose, so the golden is a fixed view. The
    // camera path exists to force a re-sort every frame, which is a bench concern, not a
    // pixel-comparison one.
    await page.goto('/?orbit=0', { waitUntil: 'load' });
    const ready = await waitForReady(page);

    expect(ready.mode).toBe('static');
    expect(ready.backend).toContain('webgpu');
    expect(ready.splats).toBe(150_000);

    // A few frames so the first sort has settled.
    await page.waitForTimeout(1500);
    // The overlay sits over the canvas and an element screenshot includes whatever overlaps
    // it, so the frame counter and fps would make the golden differ on every run.
    await page.addStyleTag({ content: '#stats, .brand { display: none !important; }' });
    await expect(page.locator('#canvas')).toHaveScreenshot('static-spz-webgpu.png', {
      maxDiffPixelRatio: 0.02,
    });
    await assertNoPageError(page);
  });

  test('static: the sort runs on every frame when the camera turns past the threshold', async ({
    page,
  }) => {
    const report = await runBench(page, 'bench=1&frames=120');

    expect(report.mode).toBe('static');
    expect(report.backend).toBe('webgpu');
    expect(report.count).toBe(150_000);
    expect(report.validationErrors).toEqual([]);
    // 2 degrees per frame is past SORT_DIRECTION_THRESHOLD, so every frame re-sorts.
    expect(report.sortsPerFrame).toBeGreaterThan(0.99);
    expect(report.sortMsP50).toBeGreaterThan(0);
    console.log(`static bench: ${JSON.stringify(report)}`);
  });

  test('dynamic: renders, sorts every frame and uploads no gaussians', async ({ page }) => {
    const report = await runBench(page, 'bench=1&mode=dynamic&n=250000&frames=120');

    expect(report.mode).toBe('dynamic');
    expect(report.backend).toBe('webgpu');
    expect(report.count).toBe(250_000);

    // The three claims the dynamic path exists to make.
    expect(report.validationErrors, 'WebGPU validation errors').toEqual([]);
    expect(report.sortsPerFrame, 'markGaussiansChanged should force one sort per frame').toBe(1);
    expect(
      report.writeBufferPerFrame,
      'a dynamic splat must not upload gaussians from the CPU; three uploads a couple of its ' +
        'own small uniform buffers per frame and nothing else',
    ).toBeLessThanOrEqual(4);
    expect(report.writeBufferBytesPerFrame, 'per-frame CPU->GPU bytes').toBeLessThan(4096);

    // Sanity on the measurements themselves: a bench that reports 0 ms measured nothing.
    expect(report.sortMsP50).toBeGreaterThan(0);
    expect(report.animateMsP50).toBeGreaterThan(0);
    expect(Number.isFinite(report.frameMsP50)).toBe(true);
    console.log(`dynamic bench: ${JSON.stringify(report)}`);
  });

  test('dynamic: the interactive path runs through createEngine too', async ({ page }) => {
    await page.goto('/?mode=dynamic&n=100000&orbit=0', { waitUntil: 'load' });
    const ready = await waitForReady(page);
    expect(ready.mode).toBe('dynamic');
    expect(ready.splats).toBe(100_000);

    await page.waitForTimeout(1200);
    const stats = (await page.locator('#stats').textContent()) ?? '';
    // The producer moves the gaussians every frame, so the sort must run every frame even
    // though the camera is frozen.
    expect(stats).toMatch(/sorts\/frame\s+1\.00/);
    expect(stats).toMatch(/slots\s+100000 used, 0 free/);
    await assertNoPageError(page);
  });
});
