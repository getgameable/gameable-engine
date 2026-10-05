import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

const proxy = {
  '/services/hello': {
    target: 'http://127.0.0.1:8788',
    ws: true,
    rewrite: (path: string) => path.replace(/^\/services\/hello/, ''),
  },
};

/** Direct development and compiled wasm share the same local voice relay. */
export default defineConfig({
  plugins: [gameable()],
  server: { port: 5180, proxy },
  preview: { port: 4180, proxy },
});
