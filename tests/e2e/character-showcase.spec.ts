/**
 * The character showcase, end to end, on a real GPU — spikes S3/S4/S5 as assertions.
 *
 * What each one is actually protecting:
 *
 * - **the self-test** — S4. `gnm_blend.wgsl` on a real adapter against `gnmReference.ts`
 *   on the CPU, over the ten recorded reference frames. The node test already holds the
 *   TypeScript reference to the python model, so this closes the chain: the browser
 *   reproduces the baked head. A shader that quietly dropped the gaze stage, or read the
 *   fp16 basis with the halves swapped, still renders a head — this is what notices.
 * - **zero WebGPU validation errors** — validation failures are silent by default: the
 *   call is dropped, the frame still renders, and a bind-group mistake looks like a
 *   rendering choice.
 * - **the golden screenshot** — the whole chain as pixels: pack parse, blend, LBS, the
 *   debug lift's writes into the sink's four buffers, the sort, three's TSL material.
 *   Every one of those fails silently into an empty canvas.
 * - **rig + sort GPU time** — the budget the plan states (S4: blend + LBS under 0.5 ms at
 *   V ~= 17.8k; the sort measured at 0.56 ms for 250 k gaussians in S2).
 * - **`sortsPerFrame === 1`** — `markGaussiansChanged`. The vertices move every frame
 *   while the camera is still, which is exactly the case a missing call renders stale.
 *
 * THE SUITE SKIPS ITSELF when `public/generated/` has no pack: the bake needs
 * `myra.head.npz`, which is licensed source data that lives outside this repository. The
 * app says so on its own status page and the suite reports it rather than failing, so a
 * machine without the source still runs the rest of the e2e suite.
 */
import { expect, test, type Page } from '@playwright/test';

import { CHARACTER_BASE_URL } from './playwright.config';

/** What the showcase publishes once it has booted (or decided it cannot). */
interface ReadyPayload {
  rig: string;
  pack: string;
  vertices: number;
  coefficients: number;
  backend: string;
  blocked?: string;
}

/** What `?selftest=1` publishes. */
interface SelfTestPayload {
  pass: boolean;
  frames: number;
  vertices: number;
  gpuVsCpuMaxErrorM: number;
  gpuVsCpuMeanErrorM: number;
  toleranceM: number;
  quantisationBoundM: number;
  packVsModelMaxErrorM: number;
  oracle: string;
  pack: { file: string; coefficients: number; truncatedFrom: number | null };
}

/** What `?bench=1` publishes. */
interface BenchPayload {
  rig: string;
  pack: string;
  vertices: number;
  coefficients: number;
  frames: number;
  rigMsP50: number;
  rigMsP95: number;
  sortMsP50: number;
  rigPlusSortMsP50: number;
  frameMsP50: number;
  sortsPerFrame: number;
  writeBufferPerFrame: number;
  writeBufferBytesPerFrame: number;
  validationErrors: string[];
}

declare global {
  interface Window {
    __AOS_READY__?: ReadyPayload;
    __AOS_SELFTEST__?: SelfTestPayload;
    __AOS_BENCH__?: BenchPayload;
    __AOS_VALIDATION__?: string[];
    __AOS_ERROR__?: string;
  }
}

/** The GPU budget for the rig pass plus the sort, at p50. */
const RIG_PLUS_SORT_BUDGET_MS = 1.5;

/**
 * Fail with the page's own error text rather than with a timeout, which says nothing.
 *
 * @param page The page under test.
 * @returns Nothing.
 */
async function assertNoPageError(page: Page): Promise<void> {
  const message = await page.evaluate(() => window.__AOS_ERROR__ ?? '');
  expect(message, 'the showcase reported an error').toBe('');
}

/**
 * Open a showcase URL and wait for it to boot.
 *
 * @param page The page under test.
 * @param query Query string without the leading `?`.
 * @returns What the app published, including `blocked` when it could not run.
 */
async function open(page: Page, query: string): Promise<ReadyPayload> {
  await page.goto(`${CHARACTER_BASE_URL}/${query.length > 0 ? `?${query}` : ''}`, {
    waitUntil: 'load',
  });
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
 * Skip the rest of a test when the GNM pack was never baked on this machine.
 *
 * @param ready What the app published.
 * @returns Nothing.
 */
function skipIfNotBaked(ready: ReadyPayload): void {
  test.skip(
    ready.blocked !== undefined,
    `the GNM pack is not baked on this machine: ${ready.blocked ?? ''}`,
  );
}

test.describe('character showcase', () => {
  test('the GNM rig loads and drives gaussians through the debug lift', async ({ page }) => {
    const ready = await open(page, '');
    skipIfNotBaked(ready);

    expect(ready.rig).toBe('gnm');
    expect(ready.backend).toBe('webgpu');
    // The shipped myra head. A different count means a re-bake, and the goldens and the
    // reference frames both have to be regenerated with it.
    expect(ready.vertices).toBe(17_821);
    // The default pack is the truncated one: 64 coefficients, the model's reduced view.
    expect(ready.coefficients).toBe(64);

    await page.waitForTimeout(1500);
    const stats = (await page.locator('#stats').textContent()) ?? '';
    // The vertices move every frame, so the sort must run every frame even though the
    // camera never moves.
    expect(stats).toMatch(/sorts\/frame\s+1\.00/);
    expect(await page.evaluate(() => window.__AOS_VALIDATION__ ?? [])).toEqual([]);
    await assertNoPageError(page);
  });

  test('selftest: the GPU reproduces the CPU reference over the recorded frames', async ({
    page,
  }) => {
    const ready = await open(page, 'selftest=1');
    skipIfNotBaked(ready);

    await page.waitForFunction(
      () => window.__AOS_SELFTEST__ !== undefined || (window.__AOS_ERROR__ ?? '') !== '',
      undefined,
      { timeout: 120_000 },
    );
    await assertNoPageError(page);
    const report = (await page.evaluate(() => window.__AOS_SELFTEST__)) as SelfTestPayload;
    expect(report, 'the self-test published no report').toBeDefined();
    console.log(`selftest: ${JSON.stringify(report)}`);

    expect(report.frames).toBe(10);
    expect(report.vertices).toBe(17_821);
    // The gate: the pack's own recorded fp16 bound plus 10 µm. The plan states 1e-3 cm for
    // the exact model; the fp16 basis is requantised by a power of two, so the pack
    // records a bound of zero and the tolerance is the slack alone.
    expect(report.toleranceM).toBeLessThanOrEqual(1e-5 + report.quantisationBoundM);
    expect(report.gpuVsCpuMaxErrorM).toBeLessThanOrEqual(report.toleranceM);
    expect(report.pass, 'the GPU disagrees with the CPU reference').toBe(true);
    // The truncated pack drops 319 of 383 coefficients, so this one is reported rather
    // than gated — but a centimetre would mean the truncation is not a usable default.
    expect(report.packVsModelMaxErrorM).toBeLessThan(0.01);
    expect(await page.evaluate(() => window.__AOS_VALIDATION__ ?? [])).toEqual([]);
  });

  test('selftest: the full 383-coefficient pack matches the model almost exactly', async ({
    page,
  }) => {
    const ready = await open(page, 'selftest=1&pack=full');
    skipIfNotBaked(ready);
    expect(ready.coefficients).toBe(383);

    await page.waitForFunction(
      () => window.__AOS_SELFTEST__ !== undefined || (window.__AOS_ERROR__ ?? '') !== '',
      undefined,
      { timeout: 120_000 },
    );
    await assertNoPageError(page);
    const report = (await page.evaluate(() => window.__AOS_SELFTEST__)) as SelfTestPayload;
    console.log(`selftest (full pack): ${JSON.stringify(report)}`);
    expect(report.pass).toBe(true);
    // With every coefficient kept, the only loss is the fp16 basis — and the packer's
    // power-of-two scales make that round trip exactly, so this is micrometres.
    expect(report.packVsModelMaxErrorM).toBeLessThan(1e-5);
  });

  test('the vertex-debug head renders', async ({ page }) => {
    const ready = await open(page, '');
    skipIfNotBaked(ready);

    // Let the first sort settle. The camera is fixed by default, so the golden is a fixed
    // front view of the neutral pose.
    await page.waitForTimeout(2000);
    // The overlays sit over the canvas and an element screenshot includes whatever
    // overlaps it, so the frame counter and the fps would differ on every run.
    await page.addStyleTag({
      content: '#stats, #controls, #report, .brand { display: none !important; }',
    });
    await expect(page.locator('#canvas')).toHaveScreenshot('character-showcase-gnm-debug.png', {
      maxDiffPixelRatio: 0.02,
    });
    await assertNoPageError(page);
  });

  test('the rig pass and the sort fit the frame budget', async ({ page }) => {
    const ready = await open(page, 'bench=1&frames=120');
    skipIfNotBaked(ready);

    await page.waitForFunction(
      () => window.__AOS_BENCH__ !== undefined || (window.__AOS_ERROR__ ?? '') !== '',
      undefined,
      { timeout: 150_000 },
    );
    await assertNoPageError(page);
    const report = (await page.evaluate(() => window.__AOS_BENCH__)) as BenchPayload;
    expect(report, 'the bench published no report').toBeDefined();
    console.log(`bench: ${JSON.stringify(report)}`);

    expect(report.validationErrors, 'WebGPU validation errors').toEqual([]);
    expect(report.vertices).toBe(17_821);
    expect(report.frames).toBe(120);
    // The measurement itself: a bench reporting 0 ms measured nothing.
    expect(report.rigMsP50).toBeGreaterThan(0);
    expect(report.sortMsP50).toBeGreaterThan(0);
    expect(
      report.rigPlusSortMsP50,
      'the GNM blend, the debug lift and the splat sort, at p50',
    ).toBeLessThan(RIG_PLUS_SORT_BUDGET_MS);
    // `markGaussiansChanged`, again — the bench's camera never moves either.
    expect(report.sortsPerFrame).toBe(1);
    // The claim the whole `RigBackend` design rests on: per frame the CPU uploads the rig's
    // uniforms — coefficients, skin rows, a params block — and not one vertex.
    expect(report.writeBufferBytesPerFrame).toBeLessThan(8192);
  });

  test('the ORL path explains itself instead of 404ing', async ({ page }) => {
    // There is no ORL bundle in this repository: ORL is driven by a licensed per-character
    // DNA. The path has to fail with the two files to drop in, not with a stack trace.
    await page.goto(`${CHARACTER_BASE_URL}/?rig=orl`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window.__AOS_ERROR__ ?? '') !== '', undefined, {
      timeout: 60_000,
    });
    const message = await page.evaluate(() => window.__AOS_ERROR__ ?? '');
    expect(message).toContain('orl_pack.bin');
    expect(message).toContain('rig_names.json');
    expect(message).toContain('public/bundles/myra/');
  });
});
