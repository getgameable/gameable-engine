/**
 * The built page, as shipped (multiplayer off): the room server client
 * (`gameable/rooms/client`, with the Colyseus SDK), the multiplayer boot
 * (`src/online.ts`, the room badge) and Play Solo's authority are not in the
 * entry chunk or anything it imports statically. They sit in chunks of their
 * own that only a multiplayer page asks for.
 *
 * Builds the page in direct mode (no guest build needed) into a temporary
 * directory and reads the chunks by markers: strings that survive
 * minification, one from each.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKERS = {
  'rooms/client': 'ColyseusConnection.join: call it once',
  'the room badge': 'Play with friends',
  InPageAuthority: 'InPageAuthority: no connection before start()',
};
const out = mkdtempSync(join(tmpdir(), 'third-person-bundle-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/**
 * The entry chunk and every chunk it reaches through static imports.
 *
 * @param assets The build's `assets/` directory.
 * @param entry The entry chunk's file name.
 * @returns The text of each chunk the page loads before any `import()`.
 */
function staticClosure(assets: string, entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const texts: string[] = [];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const text = readFileSync(join(assets, name), 'utf8');
    texts.push(text);
    // `import"./x.js"` and `from"./x.js"`, not `import("./x.js")`.
    for (const match of text.matchAll(/(?:\bimport|\bfrom)\s*["']\.\/([^"']+\.js)["']/g)) {
      queue.push(match[1] ?? '');
    }
  }
  return texts;
}

describe('the built template page, multiplayer off', () => {
  it('loads no room server client, room badge or authority until a game asks', async () => {
    const { build } = await import('vite');
    await build({
      root: ROOT,
      configFile: join(ROOT, 'vite.config.ts'),
      mode: 'direct',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const entry = /<script type="module"[^>]*src="[^"]*\/assets\/([^"]+)"/.exec(html)?.[1];
    expect(entry).toBeDefined();
    const assets = join(out, 'assets');
    const loaded = staticClosure(assets, entry ?? '');
    const chunks = readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(assets, name), 'utf8'));
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(
        loaded.some((chunk) => chunk.includes(marker)),
        `${name} loaded at boot`,
      ).toBe(false);
      // The positive control: the build has it, in a lazy chunk.
      expect(
        chunks.some((chunk) => chunk.includes(marker)),
        `${name} in some chunk`,
      ).toBe(true);
    }
  }, 300_000);
});
