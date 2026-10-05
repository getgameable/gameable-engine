// ARKit-52 -> GNM `head_ext` through the package's fitted face table (`face.arkit`,
// `arkit_to_gnm.bin`): gnm-arkit's fit of the head against the rig it was made from, the table
// the studio's own face plays. It replaces the hand-made stopgap (`arkitToGnmDefault.ts`) for
// every package that carries it: setExpression, the automatic blink and a clip's face track all
// reach the head through the animator's `ExpressionSpace.map`, which this is.

import { ARKIT_NAMES } from '../rig/arkit/arkitNames.js';
import type { HeadExtLayout } from '../rig/gnm/gnmPack.js';
import type { ArkitFaceTableInfo } from '../aosrigSplat/format.js';

/** Each of our ARKit channels by its lower-case name, so the table's `eyeBlinkLeft` finds `EyeBlinkLeft`. */
const ARKIT_BY_LOWER = new Map(ARKIT_NAMES.map((name, i) => [name.toLowerCase(), i]));

/** The mapper a fitted table gives, in the shape `createArkitToGnmMap` returns. */
export interface FittedArkitMap {
  /** Floats `map` writes: the pack's `head_ext`. */
  dim: number;
  /** ARKit weights (`ARKIT_NAMES` order, 52) -> `head_ext`. Allocates nothing. */
  map: (arkit: Float32Array, out: Float32Array) => void;
  /** Rows of the table in use: channels plus correctives. */
  terms: number;
  /** The table's channels this reader has no ARKit channel for (left out). */
  dropped: string[];
}

/**
 * Build the `ExpressionSpace.map` for a package's fitted face table.
 *
 * `head_ext`'s expression block is the head's coefficients in order, so the table's columns
 * land on it one to one; its gaze block (`pitchL, yawL, pitchR, yawR`, pitch + looking down,
 * yaw + toward the character's left) takes the `eyeLook*` channels' turns, the table's pitch
 * (+ up) negated.
 *
 * @param table The descriptor's `face.arkit` and the file's bytes (hash already checked).
 * @param layout The pack's `header.headExt`.
 * @returns The mapper.
 * @throws {Error} When the table does not fit this head (another coefficient count, a file of
 *   another size), so the caller can fall back to the stopgap.
 * @example
 * ```ts
 * import { createFittedArkitMap } from 'gameable/character';
 *
 * const face = createFittedArkitMap(bundle.faceArkit, pack.header.headExt);
 * const animator = createAnimator({ root, expressionSpace: { kind: 'gnm', dim: face.dim, map: face.map } });
 * ```
 */
export function createFittedArkitMap(
  table: { info: ArkitFaceTableInfo; bytes: Uint8Array },
  layout: HeadExtLayout,
): FittedArkitMap {
  const { info, bytes } = table;
  const n = info.coeffs;
  if (n !== layout.exprDim)
    throw new Error(
      `face table: ${String(n)} coefficients per row, the head has ${String(layout.exprDim)}`,
    );
  const rows = info.channels.length + info.pairs.length;
  if (bytes.byteLength !== rows * n * 4)
    throw new Error(
      `face table: ${String(bytes.byteLength)} bytes, expected ${String(rows * n * 4)}`,
    );
  const all = new Float32Array(rows * n);
  new Uint8Array(all.buffer).set(bytes);
  for (let i = 0; i < all.length; i++)
    if (!Number.isFinite(all[i])) throw new Error('face table: a value is not finite');

  // A: one row per OUR channel (a channel the table lacks stays zero).
  const channelCount = ARKIT_NAMES.length;
  const linear = new Float32Array(channelCount * n);
  const ours = new Int32Array(info.channels.length).fill(-1);
  const dropped: string[] = [];
  info.channels.forEach((name, row) => {
    const i = ARKIT_BY_LOWER.get(name.toLowerCase());
    if (i === undefined) {
      dropped.push(name);
      return;
    }
    ours[row] = i;
    linear.set(all.subarray(row * n, (row + 1) * n), i * n);
  });

  // C: the correctives whose two channels both exist here.
  const keptPairs: number[] = [];
  const keptRows: number[] = [];
  info.pairs.forEach(([a, b], k) => {
    const i = ours[a];
    const j = ours[b];
    if (i < 0 || j < 0) return;
    keptPairs.push(i, j);
    keptRows.push(info.channels.length + k);
  });
  const pairIndex = Int32Array.from(keptPairs);
  const corrective = new Float32Array(keptRows.length * n);
  keptRows.forEach((row, k) => {
    corrective.set(all.subarray(row * n, (row + 1) * n), k * n);
  });

  // Gaze: channel, head_ext slot, radians in the head's convention.
  const gazeBase = layout.exprDim;
  const gazeChannel: number[] = [];
  const gazeSlot: number[] = [];
  const gazeGain: number[] = [];
  if (layout.gazeDim >= 4) {
    for (const [name, g] of Object.entries(info.gaze)) {
      const i = ARKIT_BY_LOWER.get(name.toLowerCase());
      if (i === undefined) continue;
      gazeChannel.push(i);
      gazeSlot.push(gazeBase + (g.eye === 'right' ? 2 : 0) + (g.axis === 'yaw' ? 1 : 0));
      gazeGain.push(g.axis === 'pitch' ? -g.radians : g.radians);
    }
  }
  const gc = Int32Array.from(gazeChannel);
  const gs = Int32Array.from(gazeSlot);
  const gg = Float32Array.from(gazeGain);
  const unit = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0);

  return {
    dim: layout.dim,
    terms: channelCount + keptRows.length,
    dropped,
    map(arkit, out) {
      out.fill(0);
      // c A: rows of the channels that are not zero (a face at rest touches none).
      for (let c = 0; c < channelCount; c++) {
        const w = arkit[c];
        if (w === 0) continue;
        const row = c * n;
        for (let k = 0; k < n; k++) out[k] += w * linear[row + k];
      }
      // sum_k clamp(c_i) clamp(c_j) C_k
      for (let p = 0; p < pairIndex.length / 2; p++) {
        const q = unit(arkit[pairIndex[2 * p]]) * unit(arkit[pairIndex[2 * p + 1]]);
        if (q === 0) continue;
        const row = p * n;
        for (let k = 0; k < n; k++) out[k] += q * corrective[row + k];
      }
      for (let g = 0; g < gc.length; g++) out[gs[g]] += unit(arkit[gc[g]]) * gg[g];
    },
  };
}
