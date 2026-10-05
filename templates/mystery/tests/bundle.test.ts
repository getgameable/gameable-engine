/**
 * The built page: a `?room=` page must not download the in-page authority.
 * `src/main.ts` loads `src/solo.ts` (and with it `gameable/net/solo`) with
 * a dynamic `import()`, so the authority, the room and the headless engine
 * sit in a chunk of their own and the entry chunk has none of them. Nor has
 * it the Browse rooms panel's room server client (`listRooms`), which loads
 * when the panel opens.
 *
 * Builds the page in direct mode (no guest build needed) into a temporary
 * directory and reads the chunks by markers: strings that survive
 * minification, one from each.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKERS = {
  InPageAuthority: 'InPageAuthority: no connection before start()',
  createEngineRoomGame: 'createEngineRoomGame: give exactly one of definition and guest',
  createHeadlessEngine: 'createHeadlessEngine: fixedHz must be greater than 0',
  // The Browse rooms panel's room server client: loaded only when the panel opens.
  listRooms: 'listRooms: no room server',
};
const out = mkdtempSync(join(tmpdir(), 'mystery-bundle-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe('the built page', () => {
  it('keeps the in-page authority out of the entry chunk, in a chunk of its own', async () => {
    const { build } = await import('vite');
    await build({
      root: ROOT,
      configFile: join(ROOT, 'vite.config.ts'),
      mode: 'direct',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const entry = /<script type="module"[^>]*src="\/?([^"]+)"/.exec(html)?.[1];
    expect(entry).toBeDefined();
    const main = readFileSync(join(out, entry ?? ''), 'utf8');
    const chunks = readdirSync(join(out, 'assets'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(out, 'assets', name), 'utf8'));
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(main.includes(marker), `${name} in the entry chunk`).toBe(false);
      // The positive control: the build has it, in another chunk.
      expect(
        chunks.some((chunk) => chunk.includes(marker)),
        `${name} in some chunk`,
      ).toBe(true);
    }
  }, 300_000);
});
