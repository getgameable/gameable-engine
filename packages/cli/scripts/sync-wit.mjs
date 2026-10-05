#!/usr/bin/env node
/**
 * Copy the authored `wit/` package into `packages/cli/wit/` so the published
 * CLI can componentize a game that does not sit inside this repository.
 *
 * The copy is generated, gitignored, and refreshed by `prepack`. Inside the
 * repository the CLI resolves `wit/` from the repository root instead, so this
 * script only matters at publish time.
 *
 * Usage: `node scripts/sync-wit.mjs [--check]`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute, forward-slashed path to `packages/cli`. */
const PKG = fileURLToPath(new URL('../', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
/** Absolute, forward-slashed repository root. */
const ROOT = PKG.slice(0, PKG.lastIndexOf('/packages/'));
/** The authored WIT package. */
const SOURCE = `${ROOT}/wit`;
/**
 * The copy that ships inside the tarball.
 *
 * Inside `dist/` on purpose: gitignored and ignored by ESLint, so a generated
 * copy of files this package does not own cannot end up being linted. `prepack`
 * builds first and syncs second, because `tsdown` cleans `dist/`; `postpack`
 * removes it again, so it never lingers in a working tree.
 */
const TARGET = `${PKG}/dist/wit`;

if (!existsSync(`${SOURCE}/world.wit`)) {
  console.error(`sync-wit: ${SOURCE} does not look like the gameable:engine WIT package`);
  process.exit(1);
}

const check = process.argv.includes('--check');
const clean = process.argv.includes('--clean');

if (clean) {
  rmSync(TARGET, { recursive: true, force: true });
  console.log('sync-wit: removed packages/cli/dist/wit');
} else if (check) {
  const names = readdirSync(SOURCE).filter((name) => name.endsWith('.wit'));
  const stale = names.filter(
    (name) =>
      !existsSync(`${TARGET}/${name}`) ||
      readFileSync(`${TARGET}/${name}`, 'utf8') !== readFileSync(`${SOURCE}/${name}`, 'utf8'),
  );
  if (stale.length > 0) {
    console.error(`sync-wit: packages/cli/dist/wit is stale: ${stale.join(', ')}`);
    console.error('Run `npm run sync:wit -w packages/cli`.');
    process.exit(1);
  }
  console.log(`sync-wit: ok — ${String(names.length)} files match wit/`);
} else {
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  cpSync(SOURCE, TARGET, { recursive: true });
  const count = readdirSync(TARGET).length;
  console.log(`sync-wit: copied ${String(count)} files into packages/cli/dist/wit`);
}
