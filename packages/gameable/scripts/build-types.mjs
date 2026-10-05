#!/usr/bin/env node
/**
 * The published declarations.
 *
 * 1. `tsc -p tsconfig.types.json` emits a declaration for every workspace
 *    source file the entries reach, into `dist/types/<package>/src/`.
 * 2. Hand-written `.d.ts` sources (the generated WIT modules, the riglogic
 *    binding) are copied beside them, because tsc never emits those.
 * 3. Every `@gameable/<package>[/sub]` specifier in them is rewritten to the
 *    relative path of that export's declaration, since the workspace packages
 *    are not installed beside `gameable`.
 * 4. `dist/<file>.d.ts` re-exports `types/gameable/src/<file>`, which is what
 *    the exports map points at.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRIES } from '../entries.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(PKG, '..');
const TYPES = join(PKG, 'dist', 'types');
const require = createRequire(import.meta.url);

rmSync(TYPES, { recursive: true, force: true });
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(PKG, 'tsconfig.types.json')], { stdio: 'inherit' });

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// 2. Hand-written declarations of the packages that were emitted.
for (const pkg of readdirSync(TYPES)) {
  for (const file of walk(join(PACKAGES, pkg, 'src'))) {
    if (!file.endsWith('.d.ts')) continue;
    cpSync(file, join(TYPES, pkg, relative(join(PACKAGES, pkg), file)));
  }
}

// 3. Workspace specifier -> declaration path (relative to dist/types).
/** @type {Map<string, string>} */
const targets = new Map();
for (const dir of readdirSync(PACKAGES)) {
  const manifest = join(PACKAGES, dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const { name, exports = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!name?.startsWith('@gameable/')) continue;
  for (const [subpath, target] of Object.entries(exports)) {
    const source = typeof target === 'object' ? target['gameable-source'] : undefined;
    if (typeof source !== 'string' || !source.endsWith('.ts')) continue;
    const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`;
    targets.set(specifier, join(dir, source.replace(/^\.\//, '').replace(/\.ts$/, '')));
  }
}

// Module specifiers only (`from`, `import()`, a side-effect import, and the
// `declare module` augmentations that add each module's name to core's
// registry), never prose in a doc comment.
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bdeclare\s+module\s+)(['"])(@gameable\/[A-Za-z0-9_./-]+)\2/g;
const missing = new Set();
for (const file of walk(TYPES)) {
  if (!file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf8');
  const out = text.replace(SPECIFIER, (match, lead, quote, specifier) => {
    const target = targets.get(specifier);
    if (target === undefined) {
      missing.add(specifier);
      return match;
    }
    let rel = relative(dirname(file), join(TYPES, target)).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${quote}${rel}.js${quote}`;
  });
  if (out !== text) writeFileSync(file, out);
}
if (missing.size > 0) {
  console.error(`build-types: no declaration for ${[...missing].join(', ')}`);
  process.exit(1);
}

// 4. The entry declarations the exports map names.
for (const e of ENTRIES) {
  writeFileSync(
    join(PKG, 'dist', `${e.file}.d.ts`),
    `export * from './types/gameable/src/${e.file}.js';\n`,
  );
}
console.log(`build-types: ${ENTRIES.length} entries`);
