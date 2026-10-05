// Rigid-shell deform: drive a branch mesh the exact rig cannot skin directly.
//
// A `head.dna` bakes ONE mesh — `head_lod0` — so any other branch gets no ORL
// deform and renders frozen. For a body or hair that is right. But a multi-region
// bundle's second branch is neither: it is the eyes and teeth, decimated
// (eyeline-v10c: 762 verts in four connected shells, sitting 0.11-0.35 cm from the
// DNA's own eyeLeft/eyeRight/teeth LOD0 meshes; isaac-ogs has the same structure at
// 882).
//
// Those parts are BONE, not skin, and the data agrees: one rigid transform per
// shell reproduces all 246 poses of the bundle's own pose table to 0.00 mm on both
// teeth rows. The eyes carry 2.9/4.8 mm — the pupil control dilating the eyeball,
// the one genuinely non-rigid thing either does. So the whole branch is four joint
// transforms: no skin weights, no second network, no distilled rig.
//
// WHAT THIS IS NOT: a reproduction of the distillation it replaces. The lower teeth
// land ~12 mm out on 39 mm of motion (rig vs capture solve disagree on jaw gain by
// ~9%, correlation 0.96 — the same motion over-driven), and the eyes disagree
// outright, because the capture authored gaze through Maya lookAt controls RigLogic
// has no input for. Accepted deliberately: at runtime gaze is OURS
// (`arkitToMh` writes `CTRL_L/R_eye.tx/ty`, which the rig does map), so matching the
// capture was never the goal. Driven beats frozen.
//
// SPACE: the rig's own, in centimetres. The caller maps vertices in and the result
// back out, which is exact rather than approximate — a similarity conjugates a
// rigid motion: S(rel(p)) = (S∘rel∘S⁻¹)(S(p)).
//
// Ported from aos-threejs-poc/src/lib/orl/shellDeform.js @ cdd63b10

/**
 * Union-find split of a mesh into connected components by shared vertices.
 *
 * Connectivity is the right split because these parts are physically separate
 * shells — two eyeballs and two teeth rows never share a vertex. Splitting by
 * position or by displacement would need a threshold; this needs none.
 *
 * @param faces Triangle indices, three per face, flat.
 * @param vertexCount Vertices in the mesh; every one lands in exactly one shell,
 *   isolated vertices included.
 * @returns One vertex-index array per connected component, LARGEST FIRST so "shell
 *   #0" names the same thing across runs.
 */
export function splitShells(faces: ArrayLike<number>, vertexCount: number): Int32Array[] {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const n = parent[a];
      parent[a] = r;
      a = n;
    } // path-compress
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let f = 0; f < faces.length; f += 3) {
    union(faces[f], faces[f + 1]);
    union(faces[f + 1], faces[f + 2]);
  }

  const byRoot = new Map<number, number[]>();
  for (let v = 0; v < vertexCount; v++) {
    const r = find(v);
    let list = byRoot.get(r);
    if (!list) byRoot.set(r, (list = []));
    list.push(v);
  }
  // Largest first, so a caller logging "shell #0" names the same thing across runs.
  return [...byRoot.values()].map((l) => Int32Array.from(l)).sort((a, b) => b.length - a.length);
}

/**
 * Centroid of each shell, in whatever space `verts` is in.
 *
 * @param verts Vertex positions as xyz triples.
 * @param shells Vertex-index arrays, as `splitShells` returns them.
 * @returns One `[x, y, z]` mean per shell, in `shells` order.
 */
export function shellCentroids(
  verts: Float32Array,
  shells: readonly Int32Array[],
): [number, number, number][] {
  return shells.map((idx) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i] * 3;
      x += verts[o];
      y += verts[o + 1];
      z += verts[o + 2];
    }
    return [x / idx.length, y / idx.length, z / idx.length];
  });
}

/**
 * Nearest candidate joint to each shell centroid.
 *
 * Restricted to a NAMED candidate set on purpose. Searching all 870 joints is
 * ambiguous — a dozen eyelid joints share the eyeball's origin to within a
 * hundredth of a centimetre, and the nearest joint to a teeth row is a tongue
 * joint. Against the four joints that can actually own one of these shells the
 * assignment is clean (eyeline-v10c, centimetres):
 *
 *     shell        L_Eye   R_Eye   TeethUpper  TeethLower
 *     eye L         0.65    6.59     7.48        9.32
 *     eye R         5.88    0.75     7.25        9.13
 *     teeth upper   7.92    8.09     1.82        2.23
 *     teeth lower   9.73    9.81     2.75        1.07
 *
 * Returns the candidate's joint index per shell, or -1 where no candidate is
 * within `maxDistCm` — an unrecognised shell is left at its neutral pose rather
 * than attached to whichever joint happened to be least far away.
 *
 * @param centroids Shell centroids in the rig's space, from `shellCentroids`.
 * @param jointOrigins Joint world origins as xyz triples, CENTIMETRES. Negative
 *   candidate indices are skipped, so an unresolved joint name costs nothing.
 * @param candidateJoints The joint indices allowed to own a shell.
 * @param maxDistCm Furthest a centroid may sit from a joint origin and still bind,
 *   in centimetres. Defaults to 4.
 * @returns One joint index per shell, or -1 where nothing was close enough. Each
 *   joint is used at most once — the pairing is greedy, nearest pair first.
 */
export function assignShellJoints(
  centroids: readonly [number, number, number][],
  jointOrigins: Float32Array,
  candidateJoints: readonly number[],
  maxDistCm = 4,
): number[] {
  // Greedy over all (shell, joint) pairs, nearest first, so ONE JOINT OWNS AT MOST
  // ONE SHELL. Per-shell independent nearest would happily bind both eyeballs to
  // the same eye joint if the frame were off, and the result is the failure mode
  // that hides best: the eyes track together, perfectly, and only look wrong when
  // something asks them to converge on a near target. Here the second eye takes its
  // next-best joint or none at all, and a shell left at neutral is visible
  // immediately.
  const pairs: { s: number; j: number; d: number }[] = [];
  for (let s = 0; s < centroids.length; s++) {
    const c = centroids[s];
    for (const j of candidateJoints) {
      if (j < 0) continue;
      const o = j * 3;
      const d = Math.hypot(
        jointOrigins[o] - c[0],
        jointOrigins[o + 1] - c[1],
        jointOrigins[o + 2] - c[2],
      );
      if (d <= maxDistCm) pairs.push({ s, j, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const out = new Array<number>(centroids.length).fill(-1);
  const taken = new Set<number>();
  for (const p of pairs) {
    if (out[p.s] >= 0 || taken.has(p.j)) continue;
    out[p.s] = p.j;
    taken.add(p.j);
  }
  return out;
}

/**
 * Apply each shell's joint relative transform to the neutral vertices.
 *
 * `rel` is J row-major 4x4 matrices (`world(pose) · world(rest)⁻¹`), so a shell
 * whose joint has not moved reproduces its neutral exactly — which is what the
 * upper teeth do, and why they measure 0.00 mm rather than merely small.
 *
 * Writes into `out` and returns it; allocation-free per frame.
 *
 * @param neutral The branch's rest vertices as xyz triples, in the rig's space
 *   (centimetres).
 * @param shells Vertex-index arrays, from `splitShells`.
 * @param jointOfShell One joint index per shell, or -1 to leave it at neutral.
 * @param rel J row-major 4x4 matrices, `world(pose) · world(rest)⁻¹`.
 * @param out Destination, same length as `neutral`. Seeded from `neutral` first, so
 *   shells with no joint keep their rest positions.
 * @returns `out`, holding the posed branch vertices in centimetres.
 */
export function poseShells(
  neutral: Float32Array,
  shells: readonly Int32Array[],
  jointOfShell: readonly number[],
  rel: Float32Array,
  out: Float32Array,
): Float32Array {
  out.set(neutral);
  for (let s = 0; s < shells.length; s++) {
    const j = jointOfShell[s];
    if (j < 0) continue; // unrecognised shell: stays neutral
    const m = j * 16;
    const m00 = rel[m];
    const m01 = rel[m + 1];
    const m02 = rel[m + 2];
    const m03 = rel[m + 3];
    const m10 = rel[m + 4];
    const m11 = rel[m + 5];
    const m12 = rel[m + 6];
    const m13 = rel[m + 7];
    const m20 = rel[m + 8];
    const m21 = rel[m + 9];
    const m22 = rel[m + 10];
    const m23 = rel[m + 11];
    const idx = shells[s];
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i] * 3;
      const x = neutral[o];
      const y = neutral[o + 1];
      const z = neutral[o + 2];
      out[o] = m00 * x + m01 * y + m02 * z + m03;
      out[o + 1] = m10 * x + m11 * y + m12 * z + m13;
      out[o + 2] = m20 * x + m21 * y + m22 * z + m23;
    }
  }
  return out;
}

/**
 * The joints that can own one of these shells, by DNA name.
 *
 * `head` is deliberately absent even though the upper teeth are rigid to it:
 * `FACIAL_C_TeethUpper` is itself rigid to the head, so it gives the same answer
 * while keeping the candidate set to parts a `head.dna` actually articulates.
 */
export const SHELL_JOINT_NAMES = [
  'FACIAL_L_Eye',
  'FACIAL_R_Eye',
  'FACIAL_C_TeethUpper',
  'FACIAL_C_TeethLower',
];
