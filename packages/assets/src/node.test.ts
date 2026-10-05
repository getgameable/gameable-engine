import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolvePackagedAssetPath } from './node.js';

/** A game directory inside this repository: its node_modules see the asset packages. */
const GAME = fileURLToPath(new URL('../../../templates/mystery', import.meta.url));

describe('resolvePackagedAssetPath', () => {
  it('resolves @placeholder/ and @aosrig/ to files inside the installed packages', () => {
    const collider = resolvePackagedAssetPath('@placeholder/arena.collider.bin', GAME);
    expect(collider.replaceAll('\\', '/')).toMatch(/assets-placeholder\/assets\/arena\.collider\.bin$/);
    expect(existsSync(collider)).toBe(true);
    const rig = resolvePackagedAssetPath('@aosrig/aosrig_v0.glb', GAME);
    expect(rig.replaceAll('\\', '/')).toMatch(/assets-aosrig\/assets\/aosrig_v0\.glb$/);
    expect(existsSync(rig)).toBe(true);
  });

  it("resolves any other relative src into the game's public/ folder, as the page serves it", () => {
    const at = resolvePackagedAssetPath('/models/hero.glb', GAME).replaceAll('\\', '/');
    expect(at).toBe(`${GAME.replaceAll('\\', '/')}/public/models/hero.glb`);
    expect(resolvePackagedAssetPath('levels/a.bin', GAME).replaceAll('\\', '/')).toMatch(/\/public\/levels\/a\.bin$/);
  });

  it('refuses a packaged file that does not exist, and an absolute URL', () => {
    expect(() => resolvePackagedAssetPath('@placeholder/nope.bin', GAME)).toThrow(/@placeholder\/nope\.bin/);
    expect(() => resolvePackagedAssetPath('https://cdn.example/a.bin', GAME)).toThrow(/not a file/);
  });
});
