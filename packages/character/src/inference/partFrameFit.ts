// Each driver part's own FBX→trained-branch-frame transform, solved from the geometry.
//
// Training does NOT use one conversion for the whole rig. `build_v5_meshes.py:get_part`
// solves a SIGNED AXIS PERMUTATION plus a TRANSLATION per part — "FBX->geo conversion
// solved once at pose 0, then frozen" — and only then applies the shared Y flip:
//
//     branch_vertex = ((v_fbx * 0.01) @ Pm.T + shift) @ YFLIP.T
//
// Assume one global conversion instead and it comes out right for whichever part's solved
// permutation you happened to guess and wrong for the rest, which is what "the body
// renders but the head and clothes don't" looks like from the outside. The head's error is
// a ~5.5 cm pure translation; the clothes' is three different translations at once, so no
// single rigid fit can absorb it.
//
// Ported from aos-threejs-poc/src/ogs/inference/partFrameFit.js @ cdd63b10
//
// We can solve it EXACTLY where training had to approximate. It matched parts to the
// export with a KD-tree because it had no correspondence; we do — `faces[corner]` names
// the trained vertex that corner belongs to. So per part the translation is closed-form
// (the mean residual) and the permutation is the best of 48, with nothing to converge.

// Centimetres to metres, exactly as training's `v * 0.01`. Solved for, never guessed:
// see PART_FIT_MAX_RESIDUAL_METRES.
const CENTIMETRES_TO_METRES = 0.01;

// A fit worse than this is not a frame convention, it is the wrong part or the wrong
// vertex order — training's own pose0-vs-export agreement is ~1 mm and its rig-topology
// validation 1.1 mm mean / 3.15 mm worst, so centimetres here means something is wrong.
export const PART_FIT_MAX_RESIDUAL_METRES = 0.08;

/** Which source axis each target axis reads, and its sign. */
export interface SignedPermutation {
  axes: [number, number, number];
  signs: [number, number, number];
}

/** One part's solved FBX -> trained-branch-frame transform. */
export interface PartFrameFit {
  permutation: SignedPermutation;
  translation: Float32Array;
  residualMean: number;
  residualMax: number;
}

/**
 * The 48 signed axis permutations: which source axis each target axis reads, and its sign.
 *
 * @returns All 6 axis orders crossed with the 8 sign combinations, freshly allocated — the
 *   complete candidate set `fitPartFrame` scores exhaustively.
 */
export function signedPermutations(): SignedPermutation[] {
  const orders: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const out: SignedPermutation[] = [];
  for (const order of orders) {
    for (let signs = 0; signs < 8; signs++) {
      out.push({
        axes: order,
        signs: [signs & 1 ? -1 : 1, signs & 2 ? -1 : 1, signs & 4 ? -1 : 1],
      });
    }
  }
  return out;
}

/**
 * `label` for a permutation, e.g. `(-y, -z, +x)` — for the fit report.
 *
 * @param permutation The solved permutation to name.
 * @param permutation.axes Which source axis each target axis reads, as 0/1/2.
 * @param permutation.signs The sign applied to each, +1 or -1.
 * @returns The three signed axis names, comma-separated inside parentheses.
 */
export function describePermutation({ axes, signs }: SignedPermutation): string {
  const names = ['x', 'y', 'z'];
  return `(${axes.map((axis, i) => `${signs[i] < 0 ? '-' : '+'}${names[axis]}`).join(', ')})`;
}

/**
 * Solve one part's transform against the trained vertices its corners map onto.
 *
 * @param corners The part's own positions, `(C,3)`, in its FBX frame.
 * @param faces Branch vertex index per corner, offset by `firstCorner`.
 * @param firstCorner Where this part's corners start in the branch's `faces`.
 * @param target The branch's trained neutral vertices, `(V,3)`.
 * @returns The best-scoring of the 48 candidates: its permutation, the closed-form
 *   translation in metres, and the mean and worst per-corner residual, also in metres.
 */
export function fitPartFrame(
  corners: Float32Array,
  faces: ArrayLike<number>,
  firstCorner: number,
  target: Float32Array,
): PartFrameFit {
  const count = corners.length / 3;
  // Seeded rather than nullable: every candidate produces a finite residual, so the
  // "no best" branch is unreachable and would be dead code the reader has to discount.
  let best: PartFrameFit = {
    permutation: { axes: [0, 1, 2], signs: [1, 1, 1] },
    translation: new Float32Array(3),
    residualMean: Infinity,
    residualMax: Infinity,
  };
  for (const permutation of signedPermutations()) {
    const { axes, signs } = permutation;
    // Closed-form translation: the mean of (target - permuted source) minimises the
    // squared residual, so each candidate costs one pass and no search.
    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    for (let index = 0; index < count; index++) {
      const source = index * 3;
      const vertex = faces[firstCorner + index] * 3;
      sumX += target[vertex] - signs[0] * corners[source + axes[0]] * CENTIMETRES_TO_METRES;
      sumY += target[vertex + 1] - signs[1] * corners[source + axes[1]] * CENTIMETRES_TO_METRES;
      sumZ += target[vertex + 2] - signs[2] * corners[source + axes[2]] * CENTIMETRES_TO_METRES;
    }
    const translation = new Float32Array([sumX / count, sumY / count, sumZ / count]);
    let sum = 0;
    let worst = 0;
    for (let index = 0; index < count; index++) {
      const source = index * 3;
      const vertex = faces[firstCorner + index] * 3;
      const distance = Math.hypot(
        signs[0] * corners[source + axes[0]] * CENTIMETRES_TO_METRES +
          translation[0] -
          target[vertex],
        signs[1] * corners[source + axes[1]] * CENTIMETRES_TO_METRES +
          translation[1] -
          target[vertex + 1],
        signs[2] * corners[source + axes[2]] * CENTIMETRES_TO_METRES +
          translation[2] -
          target[vertex + 2],
      );
      sum += distance;
      if (distance > worst) worst = distance;
    }
    const residualMean = sum / count;
    if (residualMean < best.residualMean) {
      best = { permutation, translation, residualMean, residualMax: worst };
    }
  }
  return best;
}

/** A three.js `Vector3`-shaped point the fit is applied to, in place. */
export interface MutablePoint {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): MutablePoint;
}

/**
 * Apply a solved fit to one point, in place.
 *
 * @param fit The part's solved transform, from {@link fitPartFrame}.
 * @param point A point in the part's FBX frame, centimetres; overwritten with the
 *   branch-frame position in metres.
 * @returns The same `point`, so callers can use it as an expression.
 */
export function applyPartFrame<T extends MutablePoint>(fit: PartFrameFit, point: T): T {
  const { axes, signs } = fit.permutation;
  const source = [point.x, point.y, point.z];
  return point.set(
    signs[0] * source[axes[0]] * CENTIMETRES_TO_METRES + fit.translation[0],
    signs[1] * source[axes[1]] * CENTIMETRES_TO_METRES + fit.translation[1],
    signs[2] * source[axes[2]] * CENTIMETRES_TO_METRES + fit.translation[2],
  ) as T;
}

/**
 * `head/SKM_…FaceMesh: (-y, -z, +x) +[0.006, 0.055, 0.000]m  fit 1.6mm/18.2mm`
 *
 * @param branch The branch the part drives, e.g. `head`.
 * @param part The part file name.
 * @param fit That part's solved transform.
 * @returns The one-line report: permutation, translation in metres, then mean and worst
 *   residual in millimetres.
 */
export function formatPartFrame(branch: string, part: string, fit: PartFrameFit): string {
  const millimetres = (metres: number) => `${(metres * 1000).toFixed(1)}mm`;
  const offset = [...fit.translation].map((value) => value.toFixed(3)).join(', ');
  return (
    `${branch}/${part}: ${describePermutation(fit.permutation)} +[${offset}]m  ` +
    `fit ${millimetres(fit.residualMean)}/${millimetres(fit.residualMax)}`
  );
}
