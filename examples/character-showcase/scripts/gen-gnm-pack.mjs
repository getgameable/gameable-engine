#!/usr/bin/env node
/**
 * Bake myra's GNM head into `public/generated/`, at dev time, from the aosRig source.
 *
 * WHY THE PACK IS NOT COMMITTED. `myra.head.npz` is 7.9 MB of licensed source data and
 * the pack it produces is 42 MB; neither belongs in this repository, and `.gitattributes`
 * would route them through Git LFS, which a clean clone may not have. So the example
 * generates them, `public/generated/` is gitignored, and a machine without the source
 * gets a clear message instead of a broken app.
 *
 * IT NEVER FAILS THE BUILD. A missing npz, a missing python, a missing numpy — all of
 * them write `public/generated/status.json` saying what was missing and exit 0, because
 * `prebuild` runs on every `npm run build` and this example must not be the reason a
 * repository-wide build goes red. The app reads that file and says so on screen.
 *
 * WHAT IT PRODUCES
 *
 *   reference_frames.npz   10 random `head_ext` frames + the python model's vertices
 *   reference_frames.json  the same, for the browser self-check (`?selftest=1`)
 *   myra_head.aosrig       the FULL pack: all 383 coefficients, fp16 basis, ~42 MB
 *   myra_head.e64.aosrig   64 coefficients (the model's reduced view), lean, ~7.8 MB
 *   status.json            what ran, what it measured, and what was missing
 *
 * The truncated pack is the default the app loads: 42 MB over a dev server is a slow
 * reload, and `gnm_pack.py --trunc-report` measures exactly what the truncation costs
 * against the same reference frames, so the trade is a number rather than a hope.
 *
 * Usage:
 *   node scripts/gen-gnm-pack.mjs [--force] [--head <npz>] [--rig <stem>] [--python <exe>]
 *
 * Environment: `GAMEABLE_MYRA_HEAD`, `GAMEABLE_MYRA_RIG`, `GAMEABLE_PYTHON` override the defaults.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPO = resolve(APP, '../..');
const OUT = join(APP, 'public', 'generated');
const TOOLS = join(REPO, 'packages', 'character', 'tools');

/** Command-line and environment overrides. */
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const force = argv.includes('--force');
const HEAD_NPZ =
  flag('head') ?? process.env.GAMEABLE_MYRA_HEAD ?? 'F:/work/aos/aosRig/assets/myra/myra.head.npz';
const RIG_STEM =
  flag('rig') ?? process.env.GAMEABLE_MYRA_RIG ?? 'F:/work/aos/aosRig/assets/myra/myra.aosrig';

/** Reference-frame settings, shared by both tools so the comparison is apples to apples. */
const FRAMES = 10;
const SEED = 20250913;
/** Vertices the reference JSON records. All 17,821 would be a 6 MB JSON for no benefit. */
const REF_SUBSET = 512;
/** Coefficients the truncated pack keeps — exactly the model's own reduced ML view. */
const TRUNC_EXP = 64;

/**
 * Write `status.json` and stop.
 *
 * @param {object} status What the app should show.
 * @returns {never} Exits 0: a missing dev asset is not a build failure.
 */
function finish(status) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  if (status.ok !== true) console.warn(`gen-gnm-pack: ${status.reason}`);
  process.exit(0);
}

/**
 * The first python on this machine that can `import numpy`.
 *
 * @returns {string | null} The executable name, or null when none works.
 */
function findPython() {
  const candidates = [
    process.env.GAMEABLE_PYTHON,
    flag('python'),
    'python',
    'python3',
    'py',
  ].filter((c) => typeof c === 'string' && c.length > 0);
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-c', 'import numpy'], { stdio: 'ignore', shell: false });
    if (probe.status === 0) return exe;
  }
  return null;
}

/**
 * Run one of the character package's python tools.
 *
 * @param {string} python The interpreter.
 * @param {string} tool File name inside `packages/character/tools`.
 * @param {string[]} args Arguments.
 * @returns {{ok: boolean, out: string}} Whether it exited 0, and everything it printed.
 */
function runTool(python, tool, args) {
  const result = spawnSync(python, [join(TOOLS, tool), ...args], {
    encoding: 'utf8',
    shell: false,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (out.length > 0) console.log(out);
  return { ok: result.status === 0, out };
}

/**
 * Megabytes of a file, or 0.
 *
 * @param {string} file Absolute path.
 * @returns {number} Size in MB, two decimals.
 */
function mb(file) {
  return existsSync(file) ? Number((statSync(file).size / 1e6).toFixed(2)) : 0;
}

if (!existsSync(HEAD_NPZ)) {
  finish({
    ok: false,
    reason:
      `the GNM source head is not on this machine (${HEAD_NPZ}). Point GAMEABLE_MYRA_HEAD at a ` +
      'BakedHead npz and re-run `npm run gen:pack -w examples/character-showcase`, or drop a ' +
      'pre-baked pack at public/generated/myra_head.e64.aosrig.',
    headNpz: HEAD_NPZ,
  });
}
if (!existsSync(`${RIG_STEM}.json`) || !existsSync(`${RIG_STEM}.npz`)) {
  finish({
    ok: false,
    reason:
      `the rig pair ${RIG_STEM}.json / .npz is missing; gnm_pack.py needs the joint ` +
      'hierarchy and the bind pose that the head is skinned to.',
    rigStem: RIG_STEM,
  });
}

const python = findPython();
if (python === null) {
  finish({
    ok: false,
    reason:
      'no python with numpy on PATH. Install numpy, or set GAMEABLE_PYTHON to an interpreter ' +
      'that has it; the bake is numpy-only and needs neither gnm nor aosrig.',
  });
}

mkdirSync(OUT, { recursive: true });

const refNpz = join(OUT, 'reference_frames.npz');
const refJson = join(OUT, 'reference_frames.json');
const fullPack = join(OUT, 'myra_head.aosrig');
const leanPack = join(OUT, `myra_head.e${String(TRUNC_EXP)}.aosrig`);

const steps = [];

if (force || !existsSync(refNpz) || !existsSync(refJson)) {
  const step = runTool(python, 'gnm_reference.py', [
    '--head',
    HEAD_NPZ,
    '--out',
    refNpz,
    '--json',
    refJson,
    '--frames',
    String(FRAMES),
    '--seed',
    String(SEED),
    '--subset',
    String(REF_SUBSET),
  ]);
  steps.push({ tool: 'gnm_reference.py', ...step });
  if (!step.ok) finish({ ok: false, reason: 'gnm_reference.py failed', steps });
} else {
  steps.push({ tool: 'gnm_reference.py', ok: true, out: 'up to date' });
}

if (force || !existsSync(fullPack)) {
  const step = runTool(python, 'gnm_pack.py', [
    '--head',
    HEAD_NPZ,
    '--rig',
    RIG_STEM,
    '--out',
    fullPack,
  ]);
  steps.push({ tool: 'gnm_pack.py (full)', ...step });
  if (!step.ok) finish({ ok: false, reason: 'gnm_pack.py failed on the full pack', steps });
} else {
  steps.push({ tool: 'gnm_pack.py (full)', ok: true, out: 'up to date' });
}

let truncation = null;
if (force || !existsSync(leanPack)) {
  const step = runTool(python, 'gnm_pack.py', [
    '--head',
    HEAD_NPZ,
    '--rig',
    RIG_STEM,
    '--out',
    leanPack,
    '--trunc-exp',
    String(TRUNC_EXP),
    '--lean',
    '--trunc-report',
    refNpz,
  ]);
  steps.push({ tool: `gnm_pack.py (--trunc-exp ${String(TRUNC_EXP)})`, ...step });
  if (!step.ok) finish({ ok: false, reason: 'gnm_pack.py failed on the truncated pack', steps });
  // "truncation to 64 coefficients costs max 6.717 mm, mean 0.2592 mm over 10 reference frames"
  const measured = /costs max ([\d.]+) mm, mean ([\d.]+) mm over (\d+)/.exec(step.out);
  if (measured !== null) {
    truncation = {
      coefficients: TRUNC_EXP,
      maxVertexErrorMm: Number(measured[1]),
      meanVertexErrorMm: Number(measured[2]),
      frames: Number(measured[3]),
    };
  }
} else {
  steps.push({ tool: 'gnm_pack.py (truncated)', ok: true, out: 'up to date' });
}

finish({
  ok: true,
  generatedAt: new Date().toISOString(),
  source: { headNpz: HEAD_NPZ, rigStem: RIG_STEM, python },
  packs: {
    full: { file: 'myra_head.aosrig', megabytes: mb(fullPack), coefficients: 383 },
    truncated: {
      file: `myra_head.e${String(TRUNC_EXP)}.aosrig`,
      megabytes: mb(leanPack),
      coefficients: TRUNC_EXP,
      truncation,
    },
  },
  reference: { file: 'reference_frames.json', megabytes: mb(refJson), frames: FRAMES, seed: SEED },
  steps,
});
