#!/usr/bin/env node
/**
 * Set the version of the two published packages, together.
 *
 *   npm run release:version -- 0.2.0
 *
 * `gameable` and `create-gameable` always carry the same version: a game
 * scaffolded by create-gameable x.y.z depends on gameable x.y.z exactly. The
 * workspace packages stay at 0.0.0; they are never published. Commit the
 * result; the release workflow publishes when it reaches the public main.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: npm run release:version -- <x.y.z>');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
// A workspace that pins `gameable` to an exact version stops matching the
// workspace when the version moves, and npm goes to the registry for it.
const pinned = execFileSync('git', ['ls-files', '*package.json'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '' && !file.endsWith('package-lock.json'))
  .filter((file) => {
    const pkg = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) =>
      ['gameable', 'create-gameable'].some((name) => (pkg[field]?.[name] ?? '*') !== '*'),
    );
  });
if (pinned.length > 0) {
  console.error(`depend on gameable as "*" inside the workspace: ${pinned.join(', ')}`);
  process.exit(1);
}
for (const dir of ['packages/gameable', 'packages/create-gameable']) {
  const file = resolve(root, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name} ${version}`);
}
// The lockfile records workspace versions.
const npm = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(npm.status ?? 1);
