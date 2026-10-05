#!/usr/bin/env node
// Start the VitePress dev server on the port the host assigns (PORT env),
// falling back to 5173. Lets IDE/preview launchers pick a free port.
import { spawnSync } from 'node:child_process';

const port = process.env.PORT ?? '5173';
const result = spawnSync(
  'npx',
  [
    'vitepress',
    'dev',
    'docs',
    '--port',
    port,
    '--strictPort',
    '--host',
    process.env.HOST ?? '0.0.0.0',
  ],
  {
    stdio: 'inherit',
    shell: true,
  },
);
process.exit(result.status ?? 1);
