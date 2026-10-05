import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

/**
 * Everything gameable needs from Vite lives in the `gameable()` plugin, exactly as
 * in the third-person template this example is built from. That includes the
 * dev server's answer to Play Solo's "is the built guest stale?".
 *
 * `npm run dev` builds the direct sandbox, `npm run build` the wasm one. The
 * ports are its own, so it can be served beside the templates and examples.
 */
export default defineConfig({
  plugins: [gameable()],
  server: { port: 5192 },
  preview: { port: 4192 },
});
