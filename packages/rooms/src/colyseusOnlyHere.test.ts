/**
 * The amendment's package rule: everything that touches Colyseus lives in
 * `gameable/rooms`. Nothing else in the repository depends on
 * `@colyseus/*` or loads it in any form, and the server entry loads no three.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const threeLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('three', () => {
  threeLoads.count += 1;
  return {};
});
vi.mock('three/webgpu', () => {
  threeLoads.count += 1;
  return {};
});
vi.mock('three/tsl', () => {
  threeLoads.count += 1;
  return {};
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  '.git',
  '.claude',
  '.superpowers',
]);
// docs/public/play: built pages (docs:games), which bundle the room client like any built game.
const SKIP_PATHS = ['packages/rooms', 'spikes', 'docs/api', 'docs/public/play'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

/**
 * Any import, export-from, side-effect import, dynamic import or require of
 * an `@colyseus/` module.
 */
const COLYSEUS = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]@colyseus\//;

/**
 * @param dir A folder under the repository root.
 * @returns Every source file under it, the skipped folders left out.
 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const rel = relative(ROOT, path).split(sep).join('/');
    if (SKIP_PATHS.includes(rel)) continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE.test(name)) out.push(path);
  }
  return out;
}

describe('Colyseus stays inside @gameable/rooms', () => {
  const packages = join(ROOT, 'packages');
  // `gameable` is the published bundle of every package, rooms included, so it
  // carries rooms' dependencies; it has no code of its own that imports them.
  const others = readdirSync(packages).filter(
    (name) =>
      name !== 'rooms' && name !== 'gameable' && statSync(join(packages, name)).isDirectory(),
  );

  it('no other package lists @colyseus/* in its package.json', () => {
    expect(others.length).toBeGreaterThan(10);
    const offenders = others.filter((name) =>
      readFileSync(join(packages, name, 'package.json'), 'utf8').includes('"@colyseus/'),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern catches every form of loading a module (positive control)', () => {
    const forms = [
      "import { Room } from '@colyseus/core';",
      "import '@colyseus/core';",
      "export * from '@colyseus/sdk';",
      "const m = await import('@colyseus/sdk');",
      "const m = require('@colyseus/core');",
      'const m = require("@colyseus/core");',
    ];
    expect(forms.filter((f) => !COLYSEUS.test(f))).toEqual([]);
    expect(COLYSEUS.test("const name = 'colyseus';")).toBe(false);
  });

  it('no source file outside packages/rooms (and spikes/) loads @colyseus/*', () => {
    const files = sources(ROOT);
    expect(files.length).toBeGreaterThan(500);
    const offenders = files
      .filter((file) => COLYSEUS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the root and server entries load no three', async () => {
    const root = await import('./index.js');
    const server = await import('./server/index.js');
    expect(root.SERIALIZER_ID).toBe('aos');
    expect(typeof server.GameableColyseusRoom).toBe('function');
    expect(threeLoads.count).toBe(0);
  }, 30_000); // a cold import of the whole server graph (sdk, net, wasm-host): ~3.5 s warm, over 5 s cold under load

  it('counts a three load when one happens (positive control for the zero above)', async () => {
    await import('three/webgpu');
    expect(threeLoads.count).toBeGreaterThan(0);
  });
});
