#!/usr/bin/env node
/**
 * Copies the packaged files into this package (see FILES and DIST_FILES in
 * `entries.mjs`).
 *
 *   node scripts/sync-files.mjs         # assets/ and wit/ (on install)
 *   node scripts/sync-files.mjs --dist  # also dist/vendor (after the build)
 *   node scripts/sync-files.mjs --pack  # also LICENSE and the notices
 *
 * Every copy is a plain file copy: the sources are the workspace packages,
 * and the copies are gitignored.
 */
import { cpSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIST_FILES, FILES } from '../entries.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(PKG, '..', '..');

function copy({ from, to }) {
  const source = join(PKG, from);
  if (!existsSync(source)) {
    console.warn(`gameable: ${from} is missing; skipped`);
    return;
  }
  const target = join(PKG, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

for (const f of FILES) copy(f);
if (process.argv.includes('--dist') || process.argv.includes('--pack')) DIST_FILES.forEach(copy);
if (process.argv.includes('--pack')) {
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(join(ROOT, file))) copyFileSync(join(ROOT, file), join(PKG, file));
  }
}
