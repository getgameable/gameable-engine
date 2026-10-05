#!/usr/bin/env node
/**
 * Copy the repository's `templates/*` into
 * `packages/create-gameable/dist/templates/` so they ship inside the published
 * tarball.
 *
 * `dist/` on purpose: gitignored and ignored by ESLint, so a generated copy of
 * a template this package does not own cannot end up being linted. `prepack`
 * builds first and syncs second, because `tsdown` cleans `dist/`; `postpack`
 * removes it again, so its tests are never collected by the repository's vitest
 * run.
 *
 * Templates are real workspace members — typechecked, linted and tested in CI —
 * and this makes the published copy byte-identical to the tested one. Build
 * output is skipped, and `.gitignore` travels as `_gitignore` because npm
 * refuses to put a `.gitignore` inside a package tarball.
 *
 * The copy is gitignored and refreshed by `prepack`.
 *
 * Usage:
 *   node scripts/sync-templates.mjs            refresh the copy
 *   node scripts/sync-templates.mjs --check    fail when the copy is stale
 *   node scripts/sync-templates.mjs --clean    remove it again
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute, forward-slashed path to `packages/create-gameable`. */
const PKG = fileURLToPath(new URL('../', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
/** Absolute, forward-slashed repository root. */
const ROOT = PKG.slice(0, PKG.lastIndexOf('/packages/'));
/** The authored templates. */
const SOURCE = `${ROOT}/templates`;
/** The copy that ships inside the tarball. */
const TARGET = `${PKG}/dist/templates`;
/** Templates extend this shared base two directories above their root. */
const BASE_SOURCE = `${ROOT}/tsconfig.base.json`;
const BASE_TARGET = `${PKG}/dist/tsconfig.base.json`;

/** Directories never copied. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.gameable',
  '.git',
  '.vite',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** Files never copied. */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** Names npm will not ship verbatim, and what they travel as. */
const SHIPPED_AS = { '.gitignore': '_gitignore', '.npmrc': '_npmrc' };

/**
 * Every file under a template, as `{ from, to }` pairs relative to the roots.
 *
 * @param {string} dir Absolute directory to walk.
 * @param {string} prefix Path of this level, relative to the template root.
 * @returns {{ from: string, to: string }[]} Relative source and target paths.
 */
function collect(dir, prefix = '') {
  /** @type {{ from: string, to: string }[]} */
  const out = [];
  const here = prefix === '' ? dir : `${dir}/${prefix}`;
  for (const entry of readdirSync(here, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collect(dir, rel));
      continue;
    }
    if (SKIP_FILES.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
    const shipped = SHIPPED_AS[entry.name];
    const to = shipped === undefined ? rel : prefix === '' ? shipped : `${prefix}/${shipped}`;
    out.push({ from: rel, to });
  }
  return out;
}

/**
 * Does this template reach outside itself with a `file:` dependency (the visit template's
 * `@gameable/voxy`, a tarball in `examples/wasm-hello/vendor/` until it is on npm)? Such a template only works
 * inside this checkout, so it is not shipped.
 *
 * @param {string} name Template directory name.
 * @returns {boolean} True when a dependency is a `file:` path leaving the template.
 */
function needsCheckout(name) {
  const pkg = JSON.parse(readFileSync(`${SOURCE}/${name}/package.json`, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.values(deps).some(
    (spec) => typeof spec === 'string' && spec.startsWith('file:') && spec.includes('..'),
  );
}

/**
 * Template directory names that look like templates and can travel.
 *
 * @returns {string[]} Sorted directory names.
 */
function templateNames() {
  if (!existsSync(SOURCE)) return [];
  return readdirSync(SOURCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => existsSync(`${SOURCE}/${entry.name}/package.json`))
    .map((entry) => entry.name)
    .filter((name) => !needsCheckout(name))
    .sort();
}

const check = process.argv.includes('--check');
const clean = process.argv.includes('--clean');
const names = templateNames();

if (clean) {
  rmSync(BASE_TARGET, { force: true });
  rmSync(TARGET, { recursive: true, force: true });
  console.log('sync-templates: removed packages/create-gameable/dist/templates');
  process.exit(0);
}

if (names.length === 0) {
  if (check) {
    console.log('sync-templates: no templates authored yet; nothing to check');
    process.exit(0);
  }
  console.log('sync-templates: no templates authored yet; nothing to copy');
  rmSync(TARGET, { recursive: true, force: true });
  process.exit(0);
}

if (check) {
  /** @type {string[]} */
  const stale = [];
  if (
    !existsSync(BASE_TARGET) ||
    readFileSync(BASE_TARGET).compare(readFileSync(BASE_SOURCE)) !== 0
  )
    stale.push('../tsconfig.base.json');
  for (const name of names) {
    for (const { from, to } of collect(`${SOURCE}/${name}`)) {
      const source = `${SOURCE}/${name}/${from}`;
      const target = `${TARGET}/${name}/${to}`;
      if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
        stale.push(`${name}/${to}`);
        continue;
      }
      if (readFileSync(target).compare(readFileSync(source)) !== 0) stale.push(`${name}/${to}`);
    }
  }
  if (stale.length > 0) {
    console.error('sync-templates: packages/create-gameable/dist/templates is stale:');
    for (const path of stale.slice(0, 10)) console.error(`  - ${path}`);
    console.error('Run `npm run sync:templates -w packages/create-gameable`.');
    process.exit(1);
  }
  console.log(`sync-templates: ok — ${String(names.length)} template(s) match templates/`);
} else {
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(`${PKG}/dist`, { recursive: true });
  copyFileSync(BASE_SOURCE, BASE_TARGET);
  let copied = 0;
  for (const name of names) {
    for (const { from, to } of collect(`${SOURCE}/${name}`)) {
      const target = `${TARGET}/${name}/${to}`;
      mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      copyFileSync(`${SOURCE}/${name}/${from}`, target);
      copied += 1;
    }
  }
  console.log(
    `sync-templates: copied ${String(copied)} files from ${String(names.length)} template(s)`,
  );
}
