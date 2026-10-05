/**
 * Shared setup for the boundary tests: build the fixture, instantiate the real
 * component, and hand back a sandbox in either mode.
 *
 * Everything here is deliberately lazy. The root `npm test` picks these files
 * up through `tests/**` and must not pay for a 2 MiB componentize run, so
 * nothing is imported or built until a test that needs it actually runs.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { Sandbox } from '@gameable/wasm-host';
import type { HostApi } from '@gameable/sdk';

/** True when the slow boundary tests are enabled. */
export const BOUNDARY_ENABLED = process.env.GAMEABLE_BOUNDARY === '1';

/** Build helpers, imported lazily so a skipped run never loads jco. */
async function buildModule(): Promise<{
  buildTinyGame: (options?: { force?: boolean; quiet?: boolean; game?: string }) => {
    built: boolean;
    guestEntry: string;
    guestDir: string;
  };
  GUEST_DIR: string;
  GUEST_ENTRY: string;
}> {
  const url = new URL('../../fixtures/tiny-game/scripts/build.mjs', import.meta.url);
  return (await import(url.href)) as Awaited<ReturnType<typeof buildModule>>;
}

/**
 * Build the fixture when it is stale.
 *
 * @param game A module of `fixtures/tiny-game/src/`, without `.ts`; default the fixture itself.
 * @returns The transpiled guest directory and entry module path.
 */
export async function ensureFixtureBuilt(
  game = 'game',
): Promise<{ guestDir: string; guestEntry: string }> {
  const mod = await buildModule();
  const result = mod.buildTinyGame({ quiet: true, game });
  return { guestDir: result.guestDir, guestEntry: result.guestEntry };
}

/** A compiled-module cache, so 300 parity frames do not recompile core wasm. */
const coreCache = new Map<string, Promise<WebAssembly.Module>>();

/**
 * Load the game definition the fixture exports.
 *
 * @param game A module of `fixtures/tiny-game/src/`, without `.ts`; default the fixture itself.
 * @returns The `defineGame` result.
 */
export async function loadGameDefinition(
  game = 'game',
): Promise<import('@gameable/sdk').GameDefinition> {
  const url = new URL(`../../fixtures/tiny-game/src/${game}.ts`, import.meta.url);
  const mod = (await import(url.href)) as { default: import('@gameable/sdk').GameDefinition };
  return mod.default;
}

/**
 * Instantiate the real component.
 *
 * @param host Host services the guest imports.
 * @param game A module of `fixtures/tiny-game/src/`, without `.ts`; default the fixture itself.
 * @returns A wasm-mode sandbox.
 */
export async function createWasmSandbox(host: HostApi, game = 'game'): Promise<Sandbox> {
  const { createSandbox } = await import('@gameable/wasm-host');
  const { guestDir, guestEntry } = await ensureFixtureBuilt(game);

  const getCoreModule = (path: string): Promise<WebAssembly.Module> => {
    const key = `${guestDir}/${path}`;
    let pending = coreCache.get(key);
    if (!pending) {
      pending = readFile(key).then((bytes) => WebAssembly.compile(bytes));
      coreCache.set(key, pending);
    }
    return pending;
  };

  return createSandbox({
    mode: 'wasm',
    guestModuleUrl: pathToFileURL(guestEntry).href,
    getCoreModule,
    host,
    // Guest stderr only carries QuickJS trap messages; surface them as-is.
    wasi: {
      stderr: (bytes: Uint8Array) => {
        const text = new TextDecoder().decode(bytes).replace(/\n$/, '');
        if (text.length > 0) host.log('error', `guest stderr: ${text}`);
      },
    },
  });
}

/**
 * Build a direct-mode sandbox over the same fixture.
 *
 * @param host Host services the guest imports.
 * @param module A module of `fixtures/tiny-game/src/`, without `.ts`; default the fixture itself.
 * @returns A direct-mode sandbox.
 */
export async function createDirect(host: HostApi, module = 'game'): Promise<Sandbox> {
  const { createDirectSandbox } = await import('@gameable/wasm-host');
  const game = await loadGameDefinition(module);
  return createDirectSandbox({ mode: 'direct', game, host });
}

/** The manifest both modes resolve against, so asset handles match. */
export const FIXTURE_ASSETS = ['arena', 'enemy-capsule', 'shot'];

/**
 * A mock host wired the way both boundary tests want it: a scripted hitscan
 * that always hits enemy body 2, and a fixed manifest.
 *
 * @returns The mock host.
 */
export async function createBoundaryHost(): Promise<import('@gameable/test-harness').MockHost> {
  const { createMockHost } = await import('@gameable/test-harness');
  return createMockHost({
    seed: 0xa05e,
    nowMs: () => 0,
    assets: FIXTURE_ASSETS,
    raycast: (origin, direction) => ({
      body: 2,
      entity: 2,
      point: { x: origin.x + direction.x, y: origin.y + direction.y, z: origin.z + direction.z },
      normal: { x: 0, y: 0, z: 1 },
      distance: 6,
    }),
  });
}
