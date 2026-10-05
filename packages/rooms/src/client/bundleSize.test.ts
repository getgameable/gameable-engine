/**
 * What `gameable/rooms/client` adds to a page, measured as the spike's
 * `scripts/bundleSize.mjs` did: a browser bundle, minified, gzip -9. The
 * baseline is the page's own client (`gameable/net/client`: Play Solo); the
 * difference is the Colyseus SDK, our serializer and the connection. three is
 * external in both (the page loads it anyway).
 */
import { gzipSync } from 'node:zlib';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

/** The budget for what the rooms client adds, gzip bytes: the spike measured the SDK alone at 52,154. */
const ADDED_GZIP_BUDGET = 64 * 1024;

interface Measured {
  minified: number;
  gzip: number;
  colyseus: number;
  imports: string[];
}

/**
 * @param source The entry module's code.
 * @returns Its browser bundle's sizes, and the rendered bytes from `@colyseus/*`.
 */
async function measure(source: string): Promise<Measured> {
  const bundle = await rolldown({
    input: 'aos-size-entry',
    platform: 'browser',
    resolve: { conditionNames: ['gameable-source', 'browser', 'import', 'default'] },
    external: [/^three(\/|$)/],
    logLevel: 'silent',
    plugins: [
      {
        name: 'entry',
        resolveId: (id) => (id === 'aos-size-entry' ? id : null),
        load: (id) => (id === 'aos-size-entry' ? source : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: 'esm', minify: true, codeSplitting: false });
  await bundle.close();
  const chunk = output[0];
  const colyseus = Object.entries(chunk.modules)
    .filter(([path]) => path.includes('@colyseus'))
    .reduce((sum, [, m]) => sum + m.renderedLength, 0);
  const gzip = gzipSync(chunk.code, { level: 9 }).length;
  return {
    minified: chunk.code.length,
    gzip,
    colyseus,
    imports: [...chunk.imports, ...chunk.dynamicImports],
  };
}

describe('the rooms client in a browser bundle', () => {
  it(`adds at most ${String(ADDED_GZIP_BUDGET)} gzip bytes to the page's own client`, async () => {
    const net = await measure(
      "import { multiplayer, createLoopbackConnection } from '@gameable/net/client';\n" +
        'console.log(multiplayer, createLoopbackConnection);\n',
    );
    const rooms = await measure(
      "import { multiplayer } from '@gameable/rooms/client';\n" +
        "import { createLoopbackConnection } from '@gameable/net/client';\n" +
        'console.log(multiplayer, createLoopbackConnection);\n',
    );
    const added = { minified: rooms.minified - net.minified, gzip: rooms.gzip - net.gzip };
    console.log('[bundle] net/client', JSON.stringify(net));
    console.log('[bundle] rooms/client', JSON.stringify(rooms));
    console.log('[bundle] added by rooms/client', JSON.stringify(added));
    expect(net.colyseus).toBe(0); // Play Solo's client ships no Colyseus
    expect(rooms.colyseus).toBeGreaterThan(0);
    expect(rooms.imports.filter((i) => !i.startsWith('three'))).toEqual([]); // nothing from Node
    expect(added.gzip).toBeLessThan(ADDED_GZIP_BUDGET);
  }, 60_000);
});
