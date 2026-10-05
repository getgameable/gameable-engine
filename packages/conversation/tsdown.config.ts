import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/relay.ts'],
  format: ['esm'],
  dts: true,
  deps: { neverBundle: [/^@gameable\//, /^ws$/] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
