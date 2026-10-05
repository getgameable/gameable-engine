// ARKit-52 -> N-control rig mapping (the face-animation path).
//
// A splat character's rig is an N-element vector of MetaHuman board controls
// declared by its bundle's `rig_names.json` (60 on one character, 174 on another).
// The animation layer produces 52-element ARKit blendshape frames. To drive the
// splat from that, reuse the exact ARKit->188 MetaHuman mapping the decoders'
// training data was generated with (`./arkitToMh.ts`), then gather the N controls
// the character needs.
//
// The 188->N gather is derived at load time from the bundle's own `rig_names.json`
// (`./rigGatherFromNames.ts`). This module stays pure and dependency-light: the
// caller passes the gather in, which also keeps it trivially unit-testable.
//
// Ported from aos-threejs-poc/src/ogs/rig/arkitToIsaacRig.js @ cdd63b10
// (renamed: nothing about it is character-specific).

import { arkitToMh, MH_LEN } from './arkitToMh.js';

/** A per-control `[lo, hi]` trained-domain limit, or one pair for the whole space. */
export type RigRange = [number, number] | [number, number][];

/**
 * Map a live 52-element ARKit frame to a character's N-element rig vector.
 *
 * ABOUT `rest`. ARKit-52 can only express a SUBSET of a MetaHuman board, and
 * arkitToMh ZEROES every control it does not write — so without a rest vector the
 * output is "the few controls ARKit reached, and 0 everywhere else". That is only
 * a neutral face if the control space is centred on 0. For one declaring
 * rig_range [0,1] it is an extreme corner the decoders never saw: measured on
 * eyeline V10-C, ARKit reaches 53 of 168 controls (115 are permanently 0) against
 * a trained mean with 133 non-zero, and the resulting vector sits FURTHER from
 * the training distribution (L2 3.32) than a real trained pose does (2.96). The
 * decoders then extrapolate, which is what a washed-out, detail-free face is.
 *
 * ARKit weights are deltas from neutral BY DEFINITION (0 = neutral, 1 = full
 * expression), and arkitToMh maps them into an MH space with the same convention
 * — `arkitToMh(zeros)` is all-zeros, verified. So ARKit's contribution is ADDED
 * to rest rather than replacing it: an ARKit-neutral frame reproduces `rest`
 * exactly, and the 115 controls ARKit cannot reach hold their rest value instead
 * of collapsing to 0.
 *
 * Passing no `rest` reproduces the previous behaviour exactly, which is correct
 * for a bundle whose controls do rest at zero.
 *
 * @param arkit52 Live ARKit weights (length >= 52).
 * @param gather N indices into the 188 MH controls (`gatherFromRigNames`).
 * @param outN Destination, length N === `gather.length` (overwritten).
 * @param scratch188 Optional reusable 188-length buffer, to avoid a per-call
 *   allocation on the hot path.
 * @param rest The bundle's rest configuration, length N. Ignored when its length
 *   does not match the gather.
 * @param range Either the bundle's declared `rig_range` as one `[lo,hi]` pair, or
 *   PER-CONTROL trained-domain limits, one `[lo,hi]` per gathered control. Prefer
 *   the latter — see below.
 * @returns `outN`, holding the N gathered controls — `rest` plus the ARKit delta,
 *   clamped to `range`, when a matching `rest` was supplied.
 *
 * @example
 * ```ts
 * import { arkitToRig, ARKIT_NAMES, gatherFromRigNames } from 'gameable/character';
 *
 * const gather = gatherFromRigNames(bundle.manifest.rig.controlNames);
 * const controls = new Float32Array(gather.length);
 * const weights = new Float32Array(ARKIT_NAMES.length);
 *
 * weights[ARKIT_NAMES.indexOf('jawOpen')] = 0.4;
 * arkitToRig(weights, gather, controls);
 * ```
 */
export function arkitToRig(
  arkit52: ArrayLike<number>,
  gather: readonly number[],
  outN: Float32Array,
  scratch188?: Float32Array,
  rest: ArrayLike<number> | null = null,
  range: RigRange | null = null,
): Float32Array {
  const buf = scratch188 || new Float32Array(MH_LEN);
  arkitToMh(arkit52, buf);
  const base = rest && rest.length === gather.length ? rest : null;
  if (!base) {
    for (let i = 0; i < gather.length; i++) outN[i] = buf[gather[i]];
    return outN;
  }
  // Clamping matters because rest is already inside the domain: adding a full
  // expression on top can leave it, and a control outside its declared range is
  // extrapolation again — the very thing rest exists to avoid.
  //
  // PER-CONTROL LIMITS BEAT THE DECLARED RANGE, and the difference is not small.
  // `rig_range` is the control space's nominal domain ([0,1] for eyeline-v10c),
  // but the training data occupies a far narrower, per-control box inside it: 76
  // of that bundle's 168 controls never exceed 0.5 in any of its 246 poses, 35
  // never move at all, and the median per-control trained maximum is 0.622. So a
  // single ARKit channel at 1.0 can sit MULTIPLES past anything the decoders
  // saw — `MouthUpperUpLeft` drives `CTRL_L_mouth_upperLipRaise`, whose trained
  // max is 0.205 (nonzero in 9 of 246 rows), five times over; `MouthRollUpper`
  // drives `CTRL_R_mouth_lipsRollU`, trained max 0.143, seven times over. The
  // decoders extrapolate, and that is the blown-out, exploding face.
  //
  // The raw rig board has always clamped to these limits (it is why
  // dragging its sliders does not blow up); the ARKit path did not, so the same
  // pose reached the same decoders unclamped depending only on which UI produced
  // it. Same `trainedLimits`, so the two agree by construction.
  //
  // Live speech is barely affected: measured over real Convorcher frames, ~2.9 of
  // 168 controls exceed the unpadded envelope at all, by at most 0.076 — against
  // the 5-7x overshoot above.
  const perLimit =
    Array.isArray(range) && Array.isArray(range[0]) ? (range as [number, number][]) : null;
  const flat = perLimit ? null : (range as [number, number] | null);
  const lo0 = flat ? flat[0] : -Infinity;
  const hi0 = flat ? flat[1] : Infinity;
  for (let i = 0; i < gather.length; i++) {
    const v = base[i] + buf[gather[i]];
    const lim = perLimit ? perLimit[i] : null;
    const lo = lim ? lim[0] : lo0;
    const hi = lim ? lim[1] : hi0;
    outN[i] = v < lo ? lo : v > hi ? hi : v;
  }
  return outN;
}
