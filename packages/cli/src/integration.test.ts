/**
 * The one test that runs the real pipeline.
 *
 * A cold `jco componentize` is about thirty seconds, so this is gated behind
 * `GAMEABLE_BOUNDARY=1` exactly like `tests/boundary/`. It builds
 * `fixtures/tiny-game` into a temporary directory, so it never races the
 * boundary suite over the fixture's own `build/`.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run packages/cli
 * ```
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { guestBuild, resolveToolchain } from './lib/guestBuild.js';
import { toPosix } from './lib/paths.js';
import { measure } from './lib/report.js';

const enabled = process.env.GAMEABLE_BOUNDARY === '1';
const fixture = toPosix(fileURLToPath(new URL('../../../fixtures/tiny-game', import.meta.url)));
const scratch = toPosix(mkdtempSync(join(tmpdir(), 'aos-cli-guest-')));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe.runIf(enabled)('guestBuild against fixtures/tiny-game', () => {
  it('resolves jco, the WIT package and the SDK', () => {
    const toolchain = resolveToolchain(fixture);
    expect(toolchain.jco.endsWith('/dist/jco.js')).toBe(true);
    expect(existsSync(`${toolchain.wit}/world.wit`)).toBe(true);
    expect(existsSync(toolchain.sdkEntry)).toBe(true);
    for (const path of [toolchain.jco, toolchain.wit, toolchain.sdkEntry]) {
      expect(path).not.toContain('\\');
    }
  }, 60_000);

  it('componentizes and transpiles a runnable guest', async () => {
    const result = await guestBuild({
      gameDir: fixture,
      workDir: `${scratch}/work`,
      guestDir: `${scratch}/guest`,
      force: true,
      onLog: () => {
        // quiet
      },
    });

    expect(result.built).toBe(true);
    expect(existsSync(result.wasmPath)).toBe(true);
    expect(existsSync(result.guestEntry)).toBe(true);
    expect(result.wasmBytes).toBeGreaterThan(1024 * 1024);

    // The generated entry is the only file that mentions WIT.
    const entry = readFileSync(`${scratch}/work/entry.ts`, 'utf8');
    expect(entry).toContain('createGuestExports');
    expect(entry).not.toContain('\\');

    // jco emits the transpiled core modules next to game.js.
    expect(existsSync(`${scratch}/guest/game.core.wasm`)).toBe(true);
    expect(existsSync(`${scratch}/work/guest-types/wit.d.ts`)).toBe(true);
  }, 600_000);

  it('measures the build it just made', async () => {
    const numbers = await measure({
      wasmPath: `${scratch}/work/game.wasm`,
      guestDir: `${scratch}/guest`,
      ticks: 50,
    });
    expect(numbers.wasmBrotli).toBeGreaterThan(0);
    expect(numbers.wasmBrotli).toBeLessThan(numbers.wasmBytes);
    expect(numbers.ticks).toBe(50);
    expect(numbers.tickP99).toBeGreaterThanOrEqual(numbers.tickP50);
    expect(numbers.coldInstantiateMs).toBeGreaterThan(0);
  }, 600_000);
});
