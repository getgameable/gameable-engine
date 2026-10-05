#!/usr/bin/env node
/**
 * The published package.json is not the workspace one.
 *
 *   node scripts/publish-manifest.mjs            # at prepack
 *   node scripts/publish-manifest.mjs --restore  # at postpack
 *
 * It drops the `gameable-source` condition (`src/` is not shipped, and an app
 * whose bundler turned the condition on would resolve to files that are not
 * there), the scripts, and the workspace devDependencies.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(PKG, 'package.json');
const saved = join(PKG, 'package.json.workspace');

if (process.argv.includes('--restore')) {
  if (existsSync(saved)) renameSync(saved, manifest);
  process.exit(0);
}

const text = readFileSync(manifest, 'utf8');
writeFileSync(saved, text);
const pkg = JSON.parse(text);
for (const target of Object.values(pkg.exports)) {
  if (typeof target === 'object') delete target['gameable-source'];
}
delete pkg.scripts;
delete pkg.devDependencies;
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
