import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

/**
 * `npm run dev` runs the game as TypeScript (the direct sandbox); `npm run
 * build` compiles it to a WebAssembly component. The ports are this
 * template's own.
 *
 * `/services/visit/` is the conversation relay. Locally it is the hello
 * world's relay (`npm run relay -w examples/wasm-hello`, port 8788); a
 * published page passes its own with `?talk=`.
 */
const proxy = {
  '/services/visit': {
    target: 'http://127.0.0.1:8788',
    ws: true,
    rewrite: (path: string) => path.replace(/^\/services\/visit/, ''),
  },
};

export default defineConfig({
  plugins: [gameable()],
  server: { port: 5188, strictPort: true, proxy },
  preview: { port: 4188, strictPort: true, proxy },
});
