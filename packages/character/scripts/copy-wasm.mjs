#!/usr/bin/env node
/**
 * Copy the vendored OpenRigLogic wasm next to the bundle that asks for it.
 *
 * `orlRig.ts` resolves the binary with `new URL('./vendor/riglogic.wasm', import.meta.url)`.
 * A bundler that sees that expression in source emits the asset itself, which is why the
 * `gameable-source` export works with no build step at all — but `tsdown` inlines the glue into
 * `dist/index.js` and leaves the URL pointing at `dist/vendor/riglogic.wasm`, a file nothing
 * would otherwise put there. `files: ["dist"]` then publishes a package whose rig 404s on
 * first use, and it 404s at RUNTIME, in the browser, not at build time.
 *
 * Usage: `node scripts/copy-wasm.mjs` (runs as `postbuild`).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src/rig/orl/vendor/riglogic.wasm');
const to = join(root, 'dist/vendor/riglogic.wasm');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log('copy-wasm: src/rig/orl/vendor/riglogic.wasm -> dist/vendor/riglogic.wasm');
