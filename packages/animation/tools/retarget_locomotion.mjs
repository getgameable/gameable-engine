#!/usr/bin/env node
/*
 * BARE `three` IMPORT, DELIBERATELY.
 *
 * The engine's hard rule (`gameable/no-bare-three-import`) bans bare `three`
 * imports because the bare entry point pulls in the WebGL renderer and can
 * create a second three singleton in the browser bundle. Neither hazard exists
 * here: this is an offline node script that never renders, and it MUST share
 * one three instance with `three/addons/loaders/GLTFLoader.js` and
 * `three/addons/exporters/GLTFExporter.js`, both of which import bare `three`
 * themselves. Importing `three/webgpu` here instead would give the loaders one
 * three and this file another, and the exporter's `instanceof` checks would
 * silently drop every clip.
 *
 * No `eslint-disable` directive is needed — or possible: the rule is registered
 * only for `packages/**` + `/src/**` + `.ts`, so naming it in a directive from
 * this file is itself an "unknown rule" lint error. This comment is the record.
 */

/**
 * retarget_locomotion — retarget source locomotion clips onto the canonical
 * MetaHuman body armature and emit one GLB per clip plus a `locomotion.json`
 * index.
 *
 * Pipeline per clip:
 *
 *  1. map the source bone names through `assets/mixamo_to_mh.json`;
 *  2. rebind every rotation track into the TARGET rest frame, so the clip starts
 *     from the target's own bind pose instead of baking the source rig's
 *     A-pose/T-pose difference into every frame;
 *  3. scale the pelvis translation by the hip-height ratio, so the stride is
 *     proportional to the legs that take it;
 *  4. prune the tracks that cannot bind to the target rig;
 *  5. export a GLB, and record the clip's measured ground speed.
 *
 * The clips this is meant for are CC0 (Quaternius / Kenney lineage). Mixamo
 * content is excluded for licensing; the bone table is named for the naming
 * convention, not for the asset source.
 *
 * Usage: `node tools/retarget_locomotion.mjs --help`
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  boneMapFromJson,
  hipHeightRatio,
  mapTrackName,
  rebindQuaternionTrack,
  scalePositionTrack,
} from '../src/retarget.ts';
import { pruneBodyClipTracks } from '../src/clips/pruneBodyClipTracks.ts';

/** This file's directory. */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The bone table shipped with the package. */
const DEFAULT_MAP = join(HERE, '..', 'assets', 'mixamo_to_mh.json');

/** What `--help` prints. */
const USAGE = `
retarget_locomotion — retarget locomotion clips onto the canonical body armature

Usage:
  node tools/retarget_locomotion.mjs --target <rig.glb> --clips <dir> --out <dir> [options]

Required:
  --target <file>   Target rig GLB. Its skeleton defines the rest frame and the
                    canonical bone names.
  --clips <dir>     Directory of source clip GLBs (one or more animations each).
  --out <dir>       Output directory. One GLB per clip plus locomotion.json.

Options:
  --map <file>      Bone name table. Default: assets/mixamo_to_mh.json
  --speeds <file>   JSON { "<clipName>": <metres per second> } overriding the
                    speed measured from the clip's own root travel.
  --loop <names>    Comma-separated clip names to mark loop:false in the index.
                    Everything else loops.
  --dry-run         Do everything except write files.
  --help            Print this and exit.

Notes:
  Source GLBs must not be Draco-compressed: no decoder is wired up here.
  Bones the table does not name are dropped; spine_02, spine_04 and neck_02 have
  no Mixamo-lineage source and stay at their rest rotation on purpose.
`.trimStart();

/**
 * Parse argv.
 *
 * @returns The parsed options.
 */
function parseOptions() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      clips: { type: 'string' },
      out: { type: 'string' },
      map: { type: 'string', default: DEFAULT_MAP },
      speeds: { type: 'string' },
      loop: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return values;
}

/**
 * Model-space rest rotation of every named node, plus each node's parent name.
 *
 * @param {import('three').Object3D} root Rig root, freshly loaded and unposed.
 * @returns {Map<string, { quat: number[], parentQuat: number[], worldY: number }>} Rest frames by node name.
 */
function restFrames(root) {
  root.updateMatrixWorld(true);
  const frames = new Map();
  const q = new (rootCtor(root).Quaternion)();
  root.traverse((n) => {
    if (!n.name) return;
    n.getWorldQuaternion(q);
    const quat = [q.x, q.y, q.z, q.w];
    const parent = n.parent;
    let parentQuat = [0, 0, 0, 1];
    if (parent) {
      parent.getWorldQuaternion(q);
      parentQuat = [q.x, q.y, q.z, q.w];
    }
    const pos = n.getWorldPosition(new (rootCtor(root).Vector3)());
    frames.set(n.name, { quat, parentQuat, worldY: pos.y });
  });
  return frames;
}

/** Lazily-bound three namespace, so `--help` never loads the library. */
let THREE = null;

/**
 * The three namespace, for the helpers that need constructors.
 *
 * @returns {typeof import('three')} The namespace.
 */
function rootCtor() {
  if (!THREE) throw new Error('three was not loaded yet');
  return THREE;
}

/**
 * Read a GLB from disk and parse it.
 *
 * @param {object} loader A GLTFLoader.
 * @param {string} file Absolute path.
 * @returns {Promise<{ scene: object, animations: object[] }>} The parsed glTF.
 */
function loadGlb(loader, file) {
  const buffer = readFileSync(file);
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((res, rej) => {
    loader.parse(array, '', res, rej);
  });
}

/**
 * Measure a clip's ground speed from its pelvis translation track.
 *
 * @param {object} clip A retargeted AnimationClip.
 * @returns {number} Metres per second, or 0 when the clip plays in place.
 */
function measureSpeed(clip) {
  const track = clip.tracks.find((t) => t.name === 'pelvis.position');
  if (!track || track.values.length < 6 || clip.duration <= 0) return 0;
  const n = track.values.length / 3;
  const dx = track.values[(n - 1) * 3] - track.values[0];
  const dz = track.values[(n - 1) * 3 + 2] - track.values[2];
  return Math.hypot(dx, dz) / clip.duration;
}

/**
 * Retarget one source clip in place.
 *
 * @param {object} clip The source AnimationClip; mutated.
 * @param {Map<string, string>} boneMap Source bone name to target bone name.
 * @param {Map<string, object>} srcRest Source rest frames.
 * @param {Map<string, object>} dstRest Target rest frames.
 * @param {number} hipRatio Target hip height divided by source hip height.
 * @returns {{ dropped: string[] }} Track names that had no target bone.
 */
function retargetClip(clip, boneMap, srcRest, dstRest, hipRatio) {
  const kept = [];
  const dropped = [];
  for (const track of clip.tracks) {
    const mapped = mapTrackName(track.name, boneMap);
    if (mapped === null) {
      dropped.push(track.name);
      continue;
    }
    const dot = track.name.lastIndexOf('.');
    const srcLeaf = (dot >= 0 ? track.name.slice(0, dot) : track.name).split('/').pop();
    const dstLeaf = mapped.slice(0, mapped.lastIndexOf('.'));
    const prop = mapped.slice(mapped.lastIndexOf('.') + 1);

    const src = srcRest.get(srcLeaf);
    const dst = dstRest.get(dstLeaf);
    if (!src || !dst) {
      dropped.push(track.name);
      continue;
    }

    if (prop === 'quaternion') {
      rebindQuaternionTrack(track.values, {
        srcRest: src.quat,
        srcParentRest: src.parentQuat,
        dstRest: dst.quat,
        dstParentRest: dst.parentQuat,
      });
    } else if (prop === 'position') {
      // Only the root carries meaningful translation; every other bone's
      // position is the rig's own bone length and must not be imported.
      if (dstLeaf !== 'pelvis') {
        dropped.push(track.name);
        continue;
      }
      scalePositionTrack(track.values, hipRatio);
    } else {
      dropped.push(track.name);
      continue;
    }

    track.name = mapped;
    kept.push(track);
  }
  clip.tracks = kept;
  return { dropped };
}

/**
 * Run the retarget.
 *
 * @param {Record<string, unknown>} opts Parsed options.
 * @returns {Promise<number>} Process exit code.
 */
async function run(opts) {
  THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

  const boneMap = boneMapFromJson(JSON.parse(readFileSync(opts.map, 'utf8')));
  const speedOverrides = opts.speeds ? JSON.parse(readFileSync(opts.speeds, 'utf8')) : {};
  const nonLooping = new Set((opts.loop ?? '').split(',').filter(Boolean));

  const loader = new GLTFLoader();
  const exporter = new GLTFExporter();

  const target = await loadGlb(loader, resolve(opts.target));
  const dstRest = restFrames(target.scene);
  const dstHip = dstRest.get('pelvis')?.worldY ?? 0;
  const targetBones = new Set(dstRest.keys());

  const clipsDir = resolve(opts.clips);
  const sources = readdirSync(clipsDir)
    .filter((f) => extname(f).toLowerCase() === '.glb')
    .sort();
  if (sources.length === 0) {
    console.error(`no .glb files in ${clipsDir}`);
    return 1;
  }

  if (!opts['dry-run']) mkdirSync(resolve(opts.out), { recursive: true });

  const index = { clips: [] };

  for (const file of sources) {
    const gltf = await loadGlb(loader, join(clipsDir, file));
    const srcRest = restFrames(gltf.scene);
    const srcHip = srcRest.get(sourcePelvis(srcRest, boneMap))?.worldY ?? 0;
    const ratio = hipHeightRatio(srcHip, dstHip);

    for (const clip of gltf.animations) {
      const name = gltf.animations.length === 1 ? basename(file, '.glb') : clip.name;
      const { dropped } = retargetClip(clip, boneMap, srcRest, dstRest, ratio);
      const report = pruneBodyClipTracks(clip, targetBones, {
        generatedMarker: { keepRootMotion: true },
      });
      clip.name = name;

      const speed = speedOverrides[name] ?? measureSpeed(clip);
      const outFile = `${name}.glb`;
      console.log(
        `${file} -> ${outFile}: ${report.bound} tracks bound, ${report.unbound + dropped.length} dropped, ` +
          `hip ratio ${ratio.toFixed(3)}, speed ${speed.toFixed(3)} m/s`,
      );

      if (!opts['dry-run']) {
        const glb = await exportClip(exporter, target.scene, clip);
        writeFileSync(join(resolve(opts.out), outFile), Buffer.from(glb));
      }
      index.clips.push({ name, file: outFile, loop: !nonLooping.has(name), speed });
    }
  }

  index.clips.sort((a, b) => a.speed - b.speed);
  if (!opts['dry-run']) {
    writeFileSync(
      join(resolve(opts.out), 'locomotion.json'),
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(`${index.clips.length} clip(s) indexed`);
  return 0;
}

/**
 * The source rig's pelvis node name, found through the bone table.
 *
 * @param {Map<string, object>} srcRest Source rest frames.
 * @param {Map<string, string>} boneMap The bone table.
 * @returns {string} The node name, or an empty string.
 */
function sourcePelvis(srcRest, boneMap) {
  for (const name of srcRest.keys()) {
    if (boneMap.get(name) === 'pelvis') return name;
  }
  return '';
}

/**
 * Export one clip as a GLB carrying the target skeleton.
 *
 * @param {object} exporter A GLTFExporter.
 * @param {object} scene The target rig scene.
 * @param {object} clip The retargeted clip.
 * @returns {Promise<ArrayBuffer>} The GLB bytes.
 */
function exportClip(exporter, scene, clip) {
  return new Promise((res, rej) => {
    exporter.parse(scene, res, rej, { binary: true, animations: [clip], onlyVisible: false });
  });
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves once the exit code is set.
 */
async function main() {
  let opts;
  try {
    opts = parseOptions();
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n`);
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const missing = ['target', 'clips', 'out'].filter((k) => !opts[k]);
  if (missing.length > 0) {
    console.error(`missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}\n`);
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  for (const [flag, path] of [
    ['--target', opts.target],
    ['--clips', opts.clips],
    ['--map', opts.map],
  ]) {
    if (!existsSync(path)) {
      console.error(`${flag}: no such file or directory: ${path}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!statSync(resolve(opts.clips)).isDirectory()) {
    console.error(`--clips must be a directory: ${opts.clips}`);
    process.exitCode = 2;
    return;
  }

  process.exitCode = await run(opts);
}

await main();
