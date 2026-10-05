/**
 * The WebGL fallback, end to end.
 *
 * Its own file rather than a skipped block, because project selection in
 * `playwright.config.ts` is by file: the `webgl` project runs only this, and the `gpu`
 * project runs only `splat-viewer.spec.ts`.
 *
 * The fallback is a real shipping target for the static path — a player without WebGPU still
 * gets the world — and an explicit, named failure for the dynamic one.
 */
import { expect, test, type Page } from '@playwright/test';

/** What the viewer publishes once it has drawn. */
interface ReadyPayload {
  mode: string;
  backend: string;
  splats: number;
}

declare global {
  interface Window {
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
 * Wait for the viewer to have rendered, failing with its own error text if it did not.
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
  expect(await page.evaluate(() => window.__AOS_ERROR__ ?? '')).toBe('');
  const ready = await page.evaluate(() => window.__AOS_READY__);
  expect(ready).toBeDefined();
  return ready as ReadyPayload;
}

test.describe('webgl fallback', () => {
  test('static: the world still renders without WebGPU', async ({ page }) => {
    await page.goto('/?backend=webgl&orbit=0', { waitUntil: 'load' });
    const ready = await waitForReady(page);

    expect(ready.backend).toContain('webgl');
    expect(ready.splats).toBe(150_000);

    await page.waitForTimeout(2000);
    // Not compared against the WebGPU golden: the fallback's CPU sort and its own material
    // path produce a visibly different image, and pinning it here would make the WebGPU
    // golden the one that has to move. A non-empty render is the contract.
    const painted = await page.evaluate(() => {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    expect(painted.width).toBeGreaterThan(0);
    expect(painted.height).toBeGreaterThan(0);

    await page.addStyleTag({ content: '#stats, .brand { display: none !important; }' });
    await expect(page.locator('#canvas')).toHaveScreenshot('static-spz-webgl.png', {
      maxDiffPixelRatio: 0.02,
    });
    await assertNoPageError(page);
  });

  test('dynamic: refuses, and says why', async ({ page }) => {
    await page.goto('/?mode=dynamic&backend=webgl', { waitUntil: 'load' });
    await page.waitForFunction(() => (window.__AOS_ERROR__ ?? '') !== '', undefined, {
      timeout: 60_000,
    });
    const message = await page.evaluate(() => window.__AOS_ERROR__ ?? '');
    expect(message).toContain('WebGPU');
    await expect(page.locator('#error')).toBeVisible();
  });
});
