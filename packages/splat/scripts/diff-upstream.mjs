#!/usr/bin/env node
/**
 * Proves `src/three-fork/AnimatedGaussianSplat.js` is still a marked-up copy of the exact
 * upstream file it was forked from.
 *
 * The fork is written as *insertions only*: every deviation from upstream lives between a
 * `// GAMEABLE EDIT <n> BEGIN` and a `// GAMEABLE EDIT <n> END` line, and the two addon
 * import specifiers are rewritten (edit 0). Removing the marked blocks and mapping the two
 * specifiers back must therefore reproduce `node_modules/three/examples/jsm/objects/
 * GaussianSplat.js` byte for byte.
 *
 * Exits non-zero on any drift: a three upgrade, an accidental edit outside a block, or a
 * block whose markers are unbalanced.
 *
 * Usage: `node scripts/diff-upstream.mjs [--print]`
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const FORK = join(PKG, 'src/three-fork/AnimatedGaussianSplat.js');
const UPSTREAM_META = join(PKG, 'src/three-fork/UPSTREAM.md');

/** Upstream path inside the `three` package, relative to its root. */
const UPSTREAM_REL = 'examples/jsm/objects/GaussianSplat.js';

/** Edit 0: fork specifier -> upstream specifier. */
const SPECIFIERS = [
  ["'three/addons/gpgpu/CountingSort.js'", "'../gpgpu/CountingSort.js'"],
  ["'three/addons/utils/GaussianSplatUtils.js'", "'../utils/GaussianSplatUtils.js'"],
];

const BEGIN = /^\s*\/\/ GAMEABLE EDIT (\d+) BEGIN\b/;
const END = /^\s*\/\/ GAMEABLE EDIT (\d+) END\b/;
const ANY_MARKER = /GAMEABLE EDIT/;

/**
 * Locate the pinned `three` package on disk.
 *
 * Resolved through the same `three/addons/...` specifier the fork itself imports, because
 * three's `exports` map deliberately does not expose `./package.json`.
 *
 * @returns {{ file: string, version: string }} Upstream file path and the three version.
 */
function findThree() {
  const require = createRequire(join(PKG, 'package.json'));
  const file = require.resolve('three/addons/objects/GaussianSplat.js');
  // <three>/examples/jsm/objects/GaussianSplat.js -> <three>
  const root = dirname(dirname(dirname(dirname(file))));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  return { file, version };
}

/**
 * Remove every `GAMEABLE EDIT` block and undo the edit-0 specifier rewrite.
 *
 * @param {string} text The fork's source.
 * @returns {{ stripped: string, edits: Map<string, number> }} Upstream-shaped source, and how
 *   many blocks each edit number contributed.
 */
function strip(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const edits = new Map();
  let open = null;
  let openLine = 0;

  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const begin = BEGIN.exec(line);
    if (begin) {
      if (open !== null) {
        throw new Error(
          `line ${String(i + 1)}: EDIT ${begin[1]} BEGIN inside an open EDIT ${open} block ` +
            `(opened at line ${String(openLine)}); blocks must not nest`,
        );
      }
      open = begin[1];
      openLine = i + 1;
      edits.set(open, (edits.get(open) ?? 0) + 1);
      continue;
    }
    const end = END.exec(line);
    if (end) {
      if (open === null) throw new Error(`line ${String(i + 1)}: EDIT ${end[1]} END with no BEGIN`);
      if (end[1] !== open) {
        throw new Error(`line ${String(i + 1)}: EDIT ${end[1]} END closes EDIT ${open} BEGIN`);
      }
      open = null;
      continue;
    }
    if (open === null) {
      if (ANY_MARKER.test(line)) {
        throw new Error(
          `line ${String(i + 1)}: an GAMEABLE EDIT marker outside a BEGIN/END block:\n  ${line.trim()}`,
        );
      }
      out.push(line);
    }
  }

  if (open !== null)
    throw new Error(`EDIT ${open} BEGIN at line ${String(openLine)} is never closed`);

  let stripped = out.join('\n');
  for (const [fork, upstream] of SPECIFIERS) {
    if (!stripped.includes(fork)) {
      throw new Error(`edit 0: the fork no longer imports ${fork}`);
    }
    stripped = stripped.split(fork).join(upstream);
  }
  return { stripped, edits };
}

/**
 * First differing line between two texts.
 *
 * @param {string} a Left text.
 * @param {string} b Right text.
 * @returns {string} A short human description.
 */
function describe(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.min(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) {
      return [
        `first difference at line ${String(i + 1)}`,
        `  stripped fork: ${JSON.stringify(la[i])}`,
        `  upstream:      ${JSON.stringify(lb[i])}`,
      ].join('\n');
    }
  }
  return `stripped fork has ${String(la.length)} lines, upstream has ${String(lb.length)}`;
}

const { file: upstreamPath, version } = findThree();

if (!existsSync(FORK)) {
  console.error(`diff-upstream: missing ${FORK}`);
  process.exit(1);
}
if (!existsSync(upstreamPath)) {
  console.error(`diff-upstream: missing ${upstreamPath}`);
  process.exit(1);
}

// LF everywhere: .gitattributes normalises the repository, but a Windows checkout with a
// different core.autocrlf must not be reported as drift.
const forkText = readFileSync(FORK, 'utf8').replaceAll('\r\n', '\n');
const upstreamText = readFileSync(upstreamPath, 'utf8').replaceAll('\r\n', '\n');
const sha = createHash('sha256').update(upstreamText).digest('hex');

/** @type {string[]} */
const problems = [];

const recorded = existsSync(UPSTREAM_META) ? readFileSync(UPSTREAM_META, 'utf8') : '';
if (recorded !== '') {
  if (!recorded.includes(`three@${version}`)) {
    problems.push(
      `UPSTREAM.md does not record three@${version}; it was regenerated from a different pin`,
    );
  }
  if (!recorded.includes(sha)) {
    problems.push(
      `UPSTREAM.md does not record sha256 ${sha}\n  ` +
        'the upstream file changed under the same version, or UPSTREAM.md is stale',
    );
  }
} else {
  problems.push('src/three-fork/UPSTREAM.md is missing');
}

let edits = new Map();
try {
  const result = strip(forkText);
  edits = result.edits;
  if (result.stripped !== upstreamText) {
    problems.push(
      `the fork drifted from upstream outside its EDIT blocks:\n${describe(result.stripped, upstreamText)}`,
    );
  }
  if (process.argv.includes('--print')) process.stdout.write(result.stripped);
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err));
}

if (problems.length > 0) {
  console.error('diff-upstream: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nIf you upgraded three deliberately: re-fork from the new file, re-apply each\n' +
      'GAMEABLE EDIT block, and update src/three-fork/UPSTREAM.md with the new version\n' +
      'and sha256.',
  );
  process.exit(1);
}

const summary = [...edits.entries()]
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([n, c]) => `${n}×${String(c)}`)
  .join(' ');
console.log(
  `diff-upstream ok - fork matches three@${version} ${UPSTREAM_REL} (sha256 ${sha.slice(0, 12)}...), ` +
    `edits ${summary}`,
);
