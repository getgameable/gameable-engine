// The decoder's raw log-scale -> the world log-scale, exactly as the trainer maps it.
//
// `MeshBranch.forward` runs this AFTER the geom decoder, so it is not in the ONNX
// graph and no amount of decoder verification can see it. A bundle that omits it,
// or a lifter that ignores it, renders a DIFFERENT MODEL and reports nothing.
//
// There are two maps and a checkpoint picks one:
//
//   sigmaMax > 0  (BOUNDED, myra v8+)
//       logSigma = log(sigmaMax) + logsigmoid(raw + sigmaOffset)
//   sigmaMax == 0 (the v7-and-earlier map)
//       logSigma = raw + scaleLogBias
//
// then either is clamped to scaleLogMax (the trainer's anti-Inf guard, inert under
// the bounded map since log(sigmaMax) is far below it).
//
// THE TWO ARE MUTUALLY EXCLUSIVE. Under the bounded map the bias is folded into
// sigmaOffset -- the trainer solves `sigmoid(sigmaOffset) = exp(scaleLogBias)/sigmaMax`
// so the map is the identity at initialisation -- and adding the bias again applies
// it twice.
//
// That identity-at-init property is also why ignoring the bound is so hard to spot:
// the two maps AGREE EXACTLY at raw = 0, so the neutral render looks correct and
// only the splats above the initial scale inflate. Measured on myra v10, web/trained
// size ratio by raw offset from init:
//
//     raw      head    body  clothes    hair
//      +1     1.435   1.578    1.377   1.859
//      +2     2.618   3.150    2.403   4.195
//      +3     5.833   7.423    5.192  10.544
//
// and the ceiling goes from sigmaMax (1.9-9.4 m) to exp(scaleLogMax) (20-55 m).
// That is the oversized-splat artefact, arriving only on the biggest splats.
//
// Ported from aos-threejs-poc/src/ogs/inference/splatScale.ts @ cdd63b10

/** The trainer's per-branch scale map. Mirrors `scene/multi_part_gaussian_model.py`. */
export interface SplatScaleMap {
  /** `--sigma_max`; 0 selects the unbounded map. */
  sigmaMax: number;
  /** The solved logit. Only read when sigmaMax > 0. */
  sigmaOffset: number;
  /** Additive log-scale bias. Only read when sigmaMax == 0. */
  scaleLogBias: number;
  /** Ceiling on the mapped log-scale. Infinity leaves it untouched. */
  scaleLogMax: number;
}

/**
 * `log(sigmoid(x))`, stable in both tails.
 *
 * `Math.log(1/(1+Math.exp(-x)))` underflows to -Infinity for x below about -745
 * and loses precision long before that; the trainer uses `F.logsigmoid` for the
 * same reason. The branch keeps `exp` on its non-overflowing side in each case.
 *
 * @param x The logit, here the raw decoder log-scale shifted by `sigmaOffset`.
 * @returns `log(sigmoid(x))`, finite and accurate for every finite `x`.
 */
export function logSigmoid(x: number): number {
  return x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x));
}

/** Precomputed constants so the per-texel loop does no branching or `log`. */
export interface ScaleMapConstants {
  /** 1 = bounded map, 0 = additive map. Kept numeric so shaders share the form. */
  bounded: number;
  /** `log(sigmaMax)` under the bounded map, else 0. */
  logSigmaMax: number;
  /** `sigmaOffset` under the bounded map, else `scaleLogBias`. */
  offset: number;
  /** Ceiling on the mapped log-scale. */
  scaleLogMax: number;
}

/**
 * Resolve a `SplatScaleMap` into the constants both the CPU and the shader read.
 *
 * @param map The checkpoint's per-branch scale map, as shipped in the bundle; its `sigmaMax`
 *   is what picks between the bounded and the additive form.
 * @returns The branch-free constants, with `bounded` as the 1/0 flag the shader switches on.
 */
export function scaleMapConstants(map: SplatScaleMap): ScaleMapConstants {
  const bounded = map.sigmaMax > 0;
  return {
    bounded: bounded ? 1 : 0,
    logSigmaMax: bounded ? Math.log(map.sigmaMax) : 0,
    offset: bounded ? map.sigmaOffset : map.scaleLogBias,
    scaleLogMax: map.scaleLogMax,
  };
}

/**
 * Raw decoder log-scale -> world scale (already exponentiated).
 *
 * @param raw One axis of one gaussian's log-space scale, straight off the geom decoder.
 * @param c The resolved constants from {@link scaleMapConstants}.
 * @returns The world-space scale in metres, after the map and the `scaleLogMax` clamp.
 */
export function splatScale(raw: number, c: ScaleMapConstants): number {
  const logSigma = c.bounded ? c.logSigmaMax + logSigmoid(raw + c.offset) : raw + c.offset;
  return Math.exp(Math.min(logSigma, c.scaleLogMax));
}
