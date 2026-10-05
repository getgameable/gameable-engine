// Per-vertex debug colours, computed ONCE on the CPU and uploaded as one u32 per vertex.
//
// The debug lift could compute a palette in WGSL, and then the palette would be the one
// part of the preview a node test could not look at. Packing colours here instead makes
// every region decision plain TypeScript — `debugVertexLift.test.ts` asserts that the
// eyes come out a different colour from the face — and leaves the shader with a single
// `unpack4x8unorm`.
//
// The packing is `pack4x8unorm(r, g, b, a)`: byte 0 is red, byte 3 is alpha, which is
// little-endian u32 `r | g<<8 | b<<16 | a<<24`.

import type { AosRigPack } from '../rig/gnm/gnmPack.js';

/** Which per-vertex colouring a preview asks for. */
export type TintKind = 'joint' | 'uv' | 'height' | 'flat';

/**
 * The joint palette, in the pack's own compact joint order.
 *
 * Eight distinct hues is more than any head's joint list — GNM's compact list is four to
 * eight — and they are chosen to stay distinguishable against the dark background the
 * examples use, which a generated HSV ramp does not.
 */
const JOINT_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.85, 0.55, 0.35],
  [0.4, 0.7, 0.95],
  [0.55, 0.85, 0.5],
  [0.9, 0.45, 0.65],
  [0.95, 0.85, 0.4],
  [0.6, 0.5, 0.9],
  [0.4, 0.85, 0.8],
  [0.92, 0.78, 0.66],
];

/** Vertices an eye joint moves are drawn in this, whatever their skinning says. */
const EYE_COLOUR: readonly [number, number, number] = [0.25, 0.95, 1.0];

/**
 * Pack a colour the way `pack4x8unorm` does.
 *
 * @param r Red in `[0, 1]`; out-of-range values are clamped.
 * @param g Green in `[0, 1]`.
 * @param b Blue in `[0, 1]`.
 * @param a Alpha in `[0, 1]`. Defaults to 1.
 * @returns The 32 bits a WGSL `unpack4x8unorm` reads back as that colour.
 *
 * @example
 * ```ts
 * import { packRgba } from 'gameable/character';
 *
 * console.log(packRgba(1, 0, 0, 1).toString(16)); // 'ff0000ff'
 * ```
 */
export function packRgba(r: number, g: number, b: number, a = 1): number {
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (byte(r) | (byte(g) << 8) | (byte(b) << 16) | (byte(a) << 24)) >>> 0;
}

/**
 * A colour per vertex from the vertex's dominant skinning joint, with the eyes called out.
 *
 * This is the colouring that makes a rig bug obvious: a vertex weighted to the wrong
 * joint is a wrongly-coloured patch on an otherwise clean head, and a pack whose eye
 * weights did not survive the bake has no cyan in it at all.
 *
 * @param pack The parsed `.aosrig`, for `skinIndex`, `skinWeight` and `eyeWeights`.
 * @returns One packed RGBA per vertex, opaque.
 */
export function jointTint(pack: AosRigPack): Uint32Array {
  const V = pack.vertexCount;
  const inf = pack.maxInfluence;
  const out = new Uint32Array(V);
  for (let v = 0; v < V; v++) {
    let best = 0;
    let bestWeight = -1;
    for (let k = 0; k < inf; k++) {
      const w = pack.skinWeight[v * inf + k];
      if (w > bestWeight) {
        bestWeight = w;
        best = pack.skinIndex[v * inf + k];
      }
    }
    const eye = Math.max(pack.eyeWeights[v], pack.eyeWeights[V + v]);
    if (eye > 0.5) {
      out[v] = packRgba(EYE_COLOUR[0], EYE_COLOUR[1], EYE_COLOUR[2]);
      continue;
    }
    const [r, g, b] = JOINT_COLOURS[best % JOINT_COLOURS.length];
    // Fade toward grey where the skinning is split, so a seam band reads as a seam.
    const mix = Math.min(1, Math.max(0, bestWeight));
    const blend = (c: number): number => c * mix + 0.45 * (1 - mix);
    out[v] = packRgba(blend(r), blend(g), blend(b));
  }
  return out;
}

/**
 * A colour per vertex from the mesh's UVs: red = u, green = v.
 *
 * The UV view is how a texture-space problem shows itself — a seam in the wrong place,
 * a flipped island, a bake that dropped `uv` entirely (every vertex then comes out the
 * same colour, which is itself the finding).
 *
 * @param uv `(V,2)` texture coordinates.
 * @param vertexCount Vertices to colour; `uv` must hold at least `2 * vertexCount`.
 * @returns One packed RGBA per vertex, opaque.
 */
export function uvTint(uv: Float32Array, vertexCount: number): Uint32Array {
  const out = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    out[v] = packRgba(uv[v * 2], uv[v * 2 + 1], 0.55);
  }
  return out;
}

/**
 * A colour per vertex from its height inside the vertex bounds — a plain ramp.
 *
 * The backend-agnostic fallback: it needs nothing but the vertices, so it works for a
 * rig whose pack this package cannot read at all.
 *
 * @param verts `(V,3)` vertices in the rig's own units.
 * @param vertexCount Vertices to colour.
 * @returns One packed RGBA per vertex, opaque. A zero-height bound yields a flat ramp
 *   value rather than a division by zero.
 */
export function heightTint(verts: Float32Array, vertexCount: number): Uint32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const y = verts[v * 3 + 1];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const span = hi - lo;
  const out = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const t = span > 1e-9 ? (verts[v * 3 + 1] - lo) / span : 0.5;
    out[v] = packRgba(0.25 + 0.7 * t, 0.4 + 0.35 * Math.sin(Math.PI * t), 0.95 - 0.6 * t);
  }
  return out;
}

/**
 * One flat colour for every vertex.
 *
 * @param vertexCount Vertices to colour.
 * @param colour RGB in `[0, 1]`. Defaults to a light neutral.
 * @returns One packed RGBA per vertex, opaque.
 */
export function flatTint(
  vertexCount: number,
  colour: readonly [number, number, number] = [0.85, 0.85, 0.9],
): Uint32Array {
  return new Uint32Array(vertexCount).fill(packRgba(colour[0], colour[1], colour[2]));
}
