/**
 * Bundle the room server (`src/serve/main.ts`) into one standalone
 * `main.mjs` for the container (`deploy/rooms/Dockerfile`), with Jolt's wasm
 * and the player store's SQL (`packages/net/sql`, as `sql/`, where `migrate`
 * looks first) copied beside it: the image has node and these files, no
 * node_modules. `pg` is inlined like Colyseus.
 *
 *     node packages/cli/scripts/bundle-server.mjs <outdir> [--pack]
 *
 * Our packages come from TypeScript source (the `gameable-source`
 * condition). Colyseus, express and ws are inlined. `three` stays external
 * and must only ever be reached through a dynamic `import()` (physics-jolt's
 * debug draw, the asset loaders): a static import of it anywhere on the
 * server's path would be hoisted to the top of the bundle (trap 4), which
 * `startupImports` reports and the bundle test refuses.
 */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/** The room server's entry. */
export const SERVER_ENTRY = fileURLToPath(new URL('../src/serve/main.ts', import.meta.url));

/** The build step that writes one game's server bundle (`pack.mjs`, run in the build stage only). */
export const PACK_ENTRY = fileURLToPath(new URL('../src/serve/pack.ts', import.meta.url));

/** Node's own modules, which the image always has. */
const NODE = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Optional modules their users `require` inside a `try` and do without:
 * ws's `bufferutil` and `utf-8-validate`, debug's `supports-color`, and pg's
 * `pg-native` (only behind `pg.native`, which the store never reads).
 */
const OPTIONAL = new Set(['bufferutil', 'utf-8-validate', 'supports-color', 'pg-native']);

/** The player store's migrations, copied to `<outdir>/sql`. */
const SQL_DIR = fileURLToPath(new URL('../../net/sql', import.meta.url));

/**
 * @param {{ outdir: string, write?: boolean, entry?: string, name?: string }} options Where, whether to
 *   write, the entry and its output name (`main`).
 * @returns {Promise<import('esbuild').BuildResult & { metafile: import('esbuild').Metafile }>} esbuild's result, with its metafile.
 */
export async function bundleServer({ outdir, write = true, entry = SERVER_ENTRY, name = 'main' }) {
  const result = await build({
    entryPoints: { [name]: entry },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    conditions: ['gameable-source'],
    // three: never on a server's path (see above). vite: only `serve --direct` loads it, by a
    // runtime path. bufferutil / utf-8-validate: ws's optional native speed-ups.
    external: ['three', 'three/*', 'vite', 'bufferutil', 'utf-8-validate'],
    // express and ws are CommonJS and call `require`, which an ES module bundle lacks.
    banner: {
      js: "import { createRequire as __aosRequire } from 'node:module'; const require = __aosRequire(import.meta.url);",
    },
    metafile: true,
    write,
    logLevel: 'error',
  });
  if (write) {
    mkdirSync(outdir, { recursive: true });
    // Trap 5: Jolt's wasm beside the bundle; main.ts passes its path explicitly.
    const wasm = createRequire(import.meta.url).resolve('jolt-physics/jolt-physics.wasm.wasm');
    copyFileSync(wasm, join(outdir, 'jolt-physics.wasm.wasm'));
    // migrate() reads `sql/` beside the running file first.
    cpSync(SQL_DIR, join(outdir, 'sql'), { recursive: true });
  }
  return /** @type {any} */ (result);
}

/**
 * @param {import('esbuild').Metafile} metafile A bundle's metafile.
 * @returns {string[]} Every three.js file that went into the bundle.
 */
export function threeInputs(metafile) {
  return Object.keys(metafile.inputs).filter((path) => /(^|\/)node_modules\/three\//.test(path.replaceAll('\\', '/')));
}

/**
 * @param {import('esbuild').Metafile} metafile A bundle's metafile.
 * @returns {string[]} Modules the bundle imports at startup that are not node's own:
 *   anything here must be installed beside the bundle, which the image never has.
 */
export function startupImports(metafile) {
  const out = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || imported.kind === 'dynamic-import') continue;
      if (imported.kind === 'require-call' && OPTIONAL.has(imported.path)) continue;
      if (!NODE.has(imported.path)) out.add(imported.path);
    }
  }
  return [...out].sort();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outdir = process.argv[2] ?? 'dist/rooms';
  // `--pack`: also bundle pack.mjs, which writes a game's server bundle (the image's build stage).
  if (process.argv.includes('--pack')) await bundleServer({ outdir, entry: PACK_ENTRY, name: 'pack' });
  const result = await bundleServer({ outdir });
  const bad = [...threeInputs(result.metafile), ...startupImports(result.metafile)];
  if (bad.length > 0) {
    console.error(`the room server bundle is not standalone: ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log(`built ${outdir}/main.mjs, ${outdir}/jolt-physics.wasm.wasm and ${outdir}/sql/`);
}
