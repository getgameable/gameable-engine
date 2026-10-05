// Invert the DNA's blendshape targets from SCATTER to GATHER.
//
// The baked bundle stores deltas per TARGET: a target owns a run of
// (vertexIndex, delta) pairs, and the CPU deform walks active targets and scatters
// into the vertex array. A GPU thread owns ONE VERTEX, so it needs the opposite:
// for vertex v, which (channel, delta) pairs affect it. That is a CSR (compressed
// sparse row) built once at load with a counting sort.
//
// Deltas come in ALREADY DEQUANTIZED — the deformer applies the per-target int8
// scale once at load, and this reuses that exact array. Do NOT re-apply the scale
// here: an earlier version did, and because `scale = max|d|/127 < 1` it shrank
// every blendshape contribution. Neutral still matched exactly (no blendshapes
// active) while every posed frame was wrong by up to 0.6 cm — which is precisely
// what the GPU-vs-CPU gate exists to catch.
//
// Size, on a real MetaHuman head: 2,372,110 entries -> 9.5 MB channel + 28.5 MB
// delta on the GPU.
//
// Ported from aos-threejs-poc/src/lib/orl/csr.js @ cdd63b10

/** One blendshape target's run inside the concatenated index/delta arrays. */
export interface BlendshapeTarget {
  channel: number;
  offset: number;
  count: number;
  /** int8 dequantisation scale; read by the deformer, not by this module. */
  scale?: number;
}

/** Vertex-major blendshape deltas: row `v` is `[offset[v], offset[v+1])`. */
export interface BlendshapeCsr {
  offset: Uint32Array;
  channel: Uint32Array;
  delta: Float32Array;
  entries: number;
}

/**
 * Invert per-target blendshape runs into a per-vertex CSR.
 *
 * @param V Vertex count.
 * @param bsIndex Per-target vertex indices, concatenated.
 * @param bsDelta Per-target DEQUANTIZED deltas (xyz), concatenated.
 * @param bsTargets The runs, in the order they tile `bsIndex`/`bsDelta`.
 * @returns The CSR: `offset` is the V+1 row pointers, `channel` and `delta` are the
 *   per-entry channel index and xyz delta, sorted vertex-major.
 */
export function buildBlendshapeCsr(
  V: number,
  bsIndex: Uint16Array,
  bsDelta: Float32Array,
  bsTargets: readonly BlendshapeTarget[],
): BlendshapeCsr {
  let entries = 0;
  for (const t of bsTargets) entries += t.count;

  // Pass 1: count entries per vertex.
  const offset = new Uint32Array(V + 1);
  for (const t of bsTargets) {
    for (let k = 0; k < t.count; k++) offset[bsIndex[t.offset + k] + 1]++;
  }
  // Prefix sum -> row starts.
  for (let v = 0; v < V; v++) offset[v + 1] += offset[v];
  if (offset[V] !== entries) {
    throw new Error(
      `[orl] CSR build: counted ${String(offset[V])} entries, expected ${String(entries)}`,
    );
  }

  // Pass 2: place. `cursor` walks each row as it fills.
  const channel = new Uint32Array(entries);
  const delta = new Float32Array(entries * 3);
  const cursor = Uint32Array.from(offset.subarray(0, V));
  for (const t of bsTargets) {
    for (let k = 0; k < t.count; k++) {
      const v = bsIndex[t.offset + k];
      const dst = cursor[v]++;
      channel[dst] = t.channel;
      const src = (t.offset + k) * 3;
      delta[dst * 3] = bsDelta[src];
      delta[dst * 3 + 1] = bsDelta[src + 1];
      delta[dst * 3 + 2] = bsDelta[src + 2];
    }
  }
  return { offset, channel, delta, entries };
}
