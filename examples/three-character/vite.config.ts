import { defineConfig } from 'vite';

/**
 * Nothing Gameable-specific: an app that installs `gameable/three` from npm
 * needs no Vite configuration at all. The one line below only exists because inside this
 * repository the packages are resolved to their TypeScript sources instead of a build.
 */
export default defineConfig({
  resolve: { conditions: ['gameable-source'] },
  server: { port: 5191 },
  preview: { port: 4191 },
  build: { target: 'esnext' },
});
