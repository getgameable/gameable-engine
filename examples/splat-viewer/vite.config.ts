import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Bare `three` must resolve to the WebGPU build.
 *
 * `AGENTS.md` hard rule 1 forbids *our* code from importing bare `three`, but three's own
 * addons do it — `OrbitControls`, `GaussianSplatPLYLoader`, `SPZLoader` and
 * `GaussianSplatUtils` all import from `'three'`. Without this alias the app ends up with two
 * copies of the core classes: one from `three/webgpu` and one from `three.module.js`, and a
 * `Vector3` from one is not `instanceof` the other. This mirrors the import map three's own
 * WebGPU examples ship.
 */
const webgpuBuild = fileURLToPath(
  new URL('../../node_modules/three/build/three.webgpu.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: webgpuBuild }],
    // Workspace packages resolve to their TypeScript sources, so there is no build step
    // between editing `packages/splat` and seeing it here.
    conditions: ['gameable-source'],
  },
  server: { port: 5178 },
  preview: { port: 4178 },
  build: {
    // Top-level await in the engine bootstrap, and WebGPU is an evergreen-browser feature
    // anyway: there is nothing to gain by down-levelling.
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
});
