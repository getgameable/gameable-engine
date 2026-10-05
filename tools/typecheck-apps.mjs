#!/usr/bin/env node
// Typecheck every app-shaped workspace member (templates/*, examples/*) that is
// not part of the root `tsc -b` project graph. Those apps are `composite: false`
// (they emit nothing and reference sibling packages by their `gameable-source`
// condition), so the root build skips them; this sweep runs `tsc -p` on each.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['templates', 'examples'];
const failures = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const tsconfig = join(dir, 'tsconfig.json');
    if (!existsSync(tsconfig)) continue;
    const result = spawnSync('npx', ['tsc', '-p', tsconfig, '--noEmit'], {
      stdio: 'inherit',
      shell: true,
    });
    if (result.status !== 0) failures.push(dir);
    else console.log(`typecheck ok  ${dir}`);
  }
}
if (failures.length > 0) {
  console.error(`typecheck failed in: ${failures.join(', ')}`);
  process.exit(1);
}
