import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/server/index.ts', 'src/client/index.ts', 'src/server/testing/index.ts'],
  format: ['esm'],
  dts: true,
  deps: { neverBundle: [/^@gameable\//, /^@colyseus\//, 'express'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
