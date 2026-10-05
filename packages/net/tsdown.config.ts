import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.ts', 'src/page/index.ts', 'src/server/index.ts', 'src/solo/index.ts', 'src/testing/index.ts'],
  format: ['esm'],
  dts: true,
  deps: { neverBundle: [/^@gameable\//] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
