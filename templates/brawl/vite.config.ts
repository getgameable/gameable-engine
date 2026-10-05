import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

/**
 * Everything gameable needs from Vite lives in the `gameable()` plugin: the
 * `gameable-source` resolve condition, the single-`three` alias, the wasm runtimes
 * kept out of the pre-bundle, `application/wasm` in dev, and
 * `import.meta.env.GAMEABLE_MODE`.
 *
 * `npm run dev` builds the direct sandbox (your TypeScript, run as-is).
 * `npm run build` builds the wasm sandbox from `build/guest`.
 * `npm run build:direct` builds the direct sandbox, which is what the
 * end-to-end suite serves.
 *
 * The ports are its own, so the end-to-end suite can serve this template, the
 * FPS template and the examples side by side.
 */
export default defineConfig({
  plugins: [gameable()],
  server: { port: 5199 },
  preview: { port: 4199 },
});
