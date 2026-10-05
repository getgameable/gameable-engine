#!/usr/bin/env node
// Produces the two published archives, `gameable-<v>.tgz` and
// `create-gameable-<v>.tgz`, for consumers outside this repository. Each
// package's prepack builds it. Usage: node tools/pack-consumer.mjs [destination]
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const destination = resolve(process.argv[2] ?? '../gameable-packages');
mkdirSync(destination, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const directory of readdirSync(resolve(root, 'packages')).sort()) {
  const packageDir = resolve(root, 'packages', directory);
  const manifest = resolve(packageDir, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.private) continue;
  const result = spawnSync(npm, ['pack', '--pack-destination', destination], {
    cwd: packageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Packed: ${destination}`);
