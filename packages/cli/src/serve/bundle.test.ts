/**
 * Trap 4: the room server bundle (esbuild, platform node) loads no three.js.
 * physics-jolt's debug draw imports three behind a dynamic `import()`; a
 * static import anywhere on the path would be hoisted to the top of the
 * bundle and load three at startup. The bundle must also be standalone: the
 * image has no node_modules, so nothing but node's own modules may be
 * imported at startup.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { bundleServer, startupImports, threeInputs } from '../../scripts/bundle-server.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aos-bundle-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the room server bundle', () => {
  it('contains no three module and imports nothing but node at startup', async () => {
    const result = await bundleServer({ outdir: scratch, write: false });
    expect(threeInputs(result.metafile)).toEqual([]);
    expect(startupImports(result.metafile)).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((p) => p.includes('physics-jolt/src/debugDraw.ts'))).toBe(true); // it is in, three is not
    expect(inputs.some((p) => p.includes('@colyseus/core'))).toBe(true); // standalone: Colyseus inlined
  }, 60_000);

  it('bundles pg and writes the player store SQL beside main.mjs, where migrate looks', async () => {
    const out = join(scratch, 'written');
    const result = await bundleServer({ outdir: out });
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(inputs.some((p) => p.includes('node_modules/pg/'))).toBe(true);
    expect(startupImports(result.metafile)).toEqual([]);
    expect(existsSync(join(out, 'main.mjs'))).toBe(true);
    expect(readdirSync(join(out, 'sql'))).toContain('001_player_data.sql');
  }, 120_000);

  it('catches the old shape: a lazily imported file that imports three statically (positive control)', async () => {
    writeFileSync(join(scratch, 'draw.ts'), "import { BufferGeometry } from 'three/webgpu';\nexport const make = () => new BufferGeometry();\n");
    writeFileSync(join(scratch, 'entry.ts'), "export const draw = () => import('./draw.ts');\n");
    const result = await bundleServer({ outdir: scratch, write: false, entry: join(scratch, 'entry.ts') });
    expect(startupImports(result.metafile)).toEqual(['three/webgpu']); // hoisted to the top
  }, 60_000);
});
