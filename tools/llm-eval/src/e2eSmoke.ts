/**
 * The optional browser stage, as its own process.
 *
 * `node e2eSmoke.ts <gameDir> <repoRoot> <port>`. Exit code 0 means the game
 * booted, 1 means it did not, and **2 means "could not run"** — no Playwright,
 * no browser, no GPU — which the runner records as skipped rather than as a
 * mark against the model.
 *
 * It is a separate process so that a wedged browser or a preview server that
 * never exits is killed by the parent's timeout instead of hanging the run.
 *
 * Playwright is resolved from the engine checkout, not from the game: a
 * scaffolded game deliberately does not depend on it (see the comment at the
 * top of `templates/fps/tests/smoke.spec.ts`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The flags that get a real WebGPU adapter in headless Chromium on Windows. */
const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--no-sandbox',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];

/** Exit code meaning "this machine cannot run the stage". */
const CANNOT_RUN = 2;

/**
 * Boot the built game in a browser and report whether it came up.
 *
 * @returns Nothing; sets `process.exitCode`.
 */
async function main(): Promise<void> {
  const [gameDir, repoRoot, portArg] = process.argv.slice(2);
  if (gameDir === undefined || repoRoot === undefined) {
    console.error('usage: node e2eSmoke.ts <gameDir> <repoRoot> [port]');
    process.exitCode = CANNOT_RUN;
    return;
  }
  const port = Number.parseInt(portArg ?? '4187', 10);
  const url = `http://localhost:${String(port)}`;

  if (!existsSync(`${gameDir}/dist/index.html`)) {
    console.error('no dist/index.html — the build stage has to pass first');
    process.exitCode = CANNOT_RUN;
    return;
  }

  let chromium: ChromiumLike;
  try {
    const require = createRequire(pathToFileURL(`${repoRoot}/package.json`));
    const entry = require.resolve('playwright');
    const mod = (await import(pathToFileURL(entry).href)) as { chromium: ChromiumLike };
    chromium = mod.chromium;
  } catch (err) {
    console.error(`playwright is not installed in ${repoRoot}: ${String(err)}`);
    process.exitCode = CANNOT_RUN;
    return;
  }

  const vite = `${gameDir}/node_modules/vite/bin/vite.js`;
  if (!existsSync(vite)) {
    console.error('vite is not installed in the game');
    process.exitCode = CANNOT_RUN;
    return;
  }
  const server = spawn(
    process.execPath,
    [vite, 'preview', '--port', String(port), '--strictPort'],
    { cwd: gameDir, shell: false, windowsHide: true, stdio: 'ignore' },
  );

  try {
    await waitForServer(url, 60_000);
    const browser = await chromium.launch({ channel: 'chromium', args: WEBGPU_ARGS });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(`${url}/?test=1&seed=1`, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForFunction(
        `window.__AOS_READY__ !== undefined || (window.__AOS_ERROR__ ?? '') !== ''`,
        { timeout: 120_000 },
      );
      const error = (await page.evaluate(`window.__AOS_ERROR__ ?? ''`)) as string;
      if (error !== '') {
        console.error(`the game reported an error: ${error}`);
        process.exitCode = 1;
        return;
      }
      await page.waitForFunction(`window.__AOS_TEST__ !== undefined`, { timeout: 30_000 });
      console.log('booted, drew a frame and installed the test hooks');
    } finally {
      await browser.close();
    }
  } catch (err) {
    const message = String(err);
    // A missing browser binary is an environment problem, not a model failure.
    if (
      message.includes("Executable doesn't exist") ||
      message.includes('npx playwright install')
    ) {
      console.error(`${message}\nrun: npx playwright install chromium`);
      process.exitCode = CANNOT_RUN;
      return;
    }
    console.error(message);
    process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
  }
}

/** The slice of Playwright this script uses. */
interface ChromiumLike {
  launch(options: { channel?: string; args?: readonly string[] }): Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<PageLike>;
    close(): Promise<void>;
  }>;
}

/** The slice of a Playwright page this script uses. */
interface PageLike {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  waitForFunction(body: string, options: { timeout: number }): Promise<unknown>;
  evaluate(body: string): Promise<unknown>;
}

/**
 * Poll until the preview server answers.
 *
 * @param url Where it should be.
 * @param timeoutMs How long to wait.
 * @returns Nothing; throws on timeout.
 */
async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} never came up`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

await main();
