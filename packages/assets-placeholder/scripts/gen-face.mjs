#!/usr/bin/env node
/**
 * Authors the placeholder facial idle clip, `assets/face_idle.arkit.json`.
 *
 * Four seconds of ARKit-52 weights at 30 fps: one gentle breath cycle, two
 * blinks, a little eye drift and a faint smile. The breath is exactly one
 * period long and the blinks sit away from the ends, so the clip loops without
 * a seam.
 *
 * The document is `{ fps, frames }`, where every frame is
 * `{ timeCode, blendshapeWeights }` and `blendshapeWeights` is 52 numbers in
 * `[0, 1]`.
 *
 * Channel order is the canonical ARKit one, identical to `ARKIT_NAMES` in
 * `gameable/animation` (`packages/animation/src/face/arkitNames.ts`). The
 * list is duplicated below because this script must run with no dependencies.
 *
 * Usage: `node scripts/gen-face.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stringifyCompact } from './json.mjs';

/** The 52 ARKit blendshape channel names, in wire order. */
const ARKIT_NAMES = [
  'EyeBlinkLeft',
  'EyeLookDownLeft',
  'EyeLookInLeft',
  'EyeLookOutLeft',
  'EyeLookUpLeft',
  'EyeSquintLeft',
  'EyeWideLeft',
  'EyeBlinkRight',
  'EyeLookDownRight',
  'EyeLookInRight',
  'EyeLookOutRight',
  'EyeLookUpRight',
  'EyeSquintRight',
  'EyeWideRight',
  'JawForward',
  'JawLeft',
  'JawRight',
  'JawOpen',
  'MouthClose',
  'MouthFunnel',
  'MouthPucker',
  'MouthLeft',
  'MouthRight',
  'MouthSmileLeft',
  'MouthSmileRight',
  'MouthFrownLeft',
  'MouthFrownRight',
  'MouthDimpleLeft',
  'MouthDimpleRight',
  'MouthStretchLeft',
  'MouthStretchRight',
  'MouthRollLower',
  'MouthRollUpper',
  'MouthShrugLower',
  'MouthShrugUpper',
  'MouthPressLeft',
  'MouthPressRight',
  'MouthLowerDownLeft',
  'MouthLowerDownRight',
  'MouthUpperUpLeft',
  'MouthUpperUpRight',
  'BrowDownLeft',
  'BrowDownRight',
  'BrowInnerUp',
  'BrowOuterUpLeft',
  'BrowOuterUpRight',
  'CheekPuff',
  'CheekSquintLeft',
  'CheekSquintRight',
  'NoseSneerLeft',
  'NoseSneerRight',
  'TongueOut',
];

/** Frames per second. */
const FPS = 30;

/** Clip length in seconds. One breath cycle, so the loop is seamless. */
const DURATION = 4;

/** When the two blinks start, in seconds. */
const BLINKS = [0.85, 2.65];

/** Blink phase lengths in seconds: close, hold shut, open. */
const BLINK_CLOSE = 0.07;
const BLINK_HOLD = 0.04;
const BLINK_OPEN = 0.11;

/** Channel index by name, so the curves below read as names, not numbers. */
const INDEX = new Map(ARKIT_NAMES.map((name, i) => [name, i]));

/**
 * Smoothstep between 0 and 1.
 *
 * @param {number} x Input in `[0, 1]`; values outside are clamped.
 * @returns {number} The eased value.
 */
function smooth(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * The blink envelope at time `t`: 0 for open eyes, 1 for fully shut.
 *
 * @param {number} t Time in seconds.
 * @returns {number} Eyelid closure in `[0, 1]`.
 */
function blinkAt(t) {
  let closure = 0;
  for (const start of BLINKS) {
    const dt = t - start;
    if (dt < 0 || dt > BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN) continue;
    if (dt < BLINK_CLOSE) closure = Math.max(closure, smooth(dt / BLINK_CLOSE));
    else if (dt < BLINK_CLOSE + BLINK_HOLD) closure = 1;
    else closure = Math.max(closure, 1 - smooth((dt - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN));
  }
  return closure;
}

/**
 * Round to four decimals, so the committed JSON is stable and readable.
 *
 * @param {number} v Any number.
 * @returns {number} The rounded number.
 */
function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * The 52 ARKit weights for one instant.
 *
 * @param {number} t Time in seconds.
 * @returns {number[]} Weights in `[0, 1]`, in ARKit channel order.
 */
function poseAt(t) {
  const w = new Array(ARKIT_NAMES.length).fill(0);
  /**
   * Set one channel by name.
   *
   * @param {string} name ARKit channel name.
   * @param {number} value Weight in `[0, 1]`.
   * @returns {void}
   */
  const set = (name, value) => {
    w[INDEX.get(name)] = round4(Math.min(1, Math.max(0, value)));
  };

  // One full breath over the clip: jaw and cheeks open slightly on the inhale.
  const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / DURATION);
  set('JawOpen', 0.018 + 0.03 * breath);
  set('MouthClose', 0.012 * (1 - breath));
  set('CheekPuff', 0.02 * breath);
  set('NoseSneerLeft', 0.012 * breath);
  set('NoseSneerRight', 0.012 * breath);

  // A faint, asymmetric resting smile so the face is not a mask.
  set('MouthSmileLeft', 0.055);
  set('MouthSmileRight', 0.045);
  set('MouthDimpleLeft', 0.02);

  // Brows drift on a slower cycle than the breath.
  const brow = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / DURATION + 1.1);
  set('BrowInnerUp', 0.03 + 0.035 * brow);
  set('BrowOuterUpLeft', 0.02 * brow);
  set('BrowOuterUpRight', 0.02 * brow);

  // Slow horizontal eye drift, the two eyes moving together.
  const gaze = Math.sin((2 * Math.PI * t) / DURATION + 0.4);
  set('EyeLookInLeft', Math.max(0, gaze) * 0.09);
  set('EyeLookOutRight', Math.max(0, gaze) * 0.09);
  set('EyeLookOutLeft', Math.max(0, -gaze) * 0.09);
  set('EyeLookInRight', Math.max(0, -gaze) * 0.09);

  // Blinks, with the slight squint that always comes with them.
  const closure = blinkAt(t);
  set('EyeBlinkLeft', closure);
  set('EyeBlinkRight', closure);
  set('EyeSquintLeft', 0.02 + 0.16 * closure);
  set('EyeSquintRight', 0.02 + 0.16 * closure);

  return w;
}

const frameCount = DURATION * FPS;
const frames = [];
for (let i = 0; i < frameCount; i += 1) {
  const t = i / FPS;
  frames.push({ timeCode: round4(t), blendshapeWeights: poseAt(t) });
}

const clip = { fps: FPS, frames };
const outDir = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const text = `${stringifyCompact(clip)}\n`;
writeFileSync(`${outDir}face_idle.arkit.json`, text);

console.log(
  `face_idle.arkit.json ${String(frames.length)} frames @ ${String(FPS)} fps (${String(
    DURATION,
  )} s), ${String(ARKIT_NAMES.length)} channels, ${String(text.length)} bytes`,
);
