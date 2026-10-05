import { describe, expect, it } from 'vitest';

import { createMockHost } from '@gameable/test-harness';

import { GAME_EXPORT } from './guestExport';
import { createSandbox, type GuestNamespace, type Instantiate } from './sandbox';

/**
 * @param marker Returned by `snapshot`, so a test can tell which namespace was loaded.
 * @returns A `game` namespace that does nothing.
 */
function namespace(marker: number): GuestNamespace {
  return {
    init: () => undefined,
    tick: () => {
      throw new Error('unused');
    },
    shutdown: () => undefined,
    snapshot: () => new Uint8Array([marker]),
    restore: () => undefined,
  };
}

/**
 * @param root What `instantiate` resolves to, as jco's root object would be.
 * @returns A wasm sandbox over it.
 */
function load(root: Record<string, unknown>): ReturnType<typeof createSandbox> {
  return createSandbox({
    mode: 'wasm',
    getCoreModule: () => Promise.reject(new Error('unused')),
    host: createMockHost(),
    instantiate: (() => Promise.resolve(root)) as unknown as Instantiate,
  });
}

describe('the guest WIT version check', () => {
  it('refuses a guest built for gameable:engine 0.1.0, naming its version and the fix', async () => {
    const game = namespace(1);
    await expect(load({ game, 'gameable:engine/game@0.1.0': game })).rejects.toThrow(
      'guest built for gameable:engine/game@0.1.0; this host speaks gameable:engine 0.2.0; ' +
        'rebuild it (npm run build:guest)',
    );
  });

  it('loads the versioned 0.2.0 export, which is what jco emits beside `game`', async () => {
    const sandbox = await load({ game: namespace(1), [GAME_EXPORT]: namespace(2) });
    expect(GAME_EXPORT).toBe('gameable:engine/game@0.2.0');
    expect([...sandbox.snapshot()]).toEqual([2]);
  });

  it('refuses a module with only the bare `game` (no version to check), or with neither', async () => {
    await expect(load({ game: namespace(3) })).rejects.toThrow(/exports no gameable:engine\/game@0\.2\.0/);
    await expect(load({})).rejects.toThrow(/exports no gameable:engine\/game@0\.2\.0/);
  });
});
