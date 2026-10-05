// The mouth's inside, as data: the head pack's mouth blobs, the teeth's binding, the rim and
// the window the studio draws the inside through. A synthetic mouth small enough to reason
// about: a bag (a tube open at the front, capped at the back) and two triangles of teeth.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  floatToHalf,
  packAosRig,
  parseAosRig,
  type AosRigBlob,
  type AosRigHeader,
} from '../rig/gnm/gnmPack.js';
import { loadAosrigSplatBundle } from './format.js';
import {
  OPEN_FULL_M,
  OPEN_START_M,
  buildLipEdges,
  buildMouthMesh,
  createVertexExpression,
  featherTriangles,
  holdLips,
  lipEdgePoints,
  moveBoundPoints,
  mouthShade,
  openStrength,
  parseTeethBinding,
  parseTeethInfo,
  restVertices,
  rimLoop,
  screenRings,
  teethOffsets,
  teethPoint,
  windowCorners,
  windowPoints,
  windowRest,
  type FaceSplats,
} from './mouth.js';

const RIM = 8;
/** Rim (0-7): an ellipse 50 mm wide, 10 mm tall at z 0; back ring (8-15) at z -30 mm; cap (16); teeth (17-20). */
function mouthVertices(): Float32Array {
  const v: number[] = [];
  for (const z of [0, -0.03])
    for (let k = 0; k < RIM; k++) {
      const a = (2 * Math.PI * k) / RIM;
      v.push(0.025 * Math.cos(a), 1.5 + 0.005 * Math.sin(a), z);
    }
  v.push(0, 1.5, -0.04);
  v.push(-0.01, 1.502, -0.005, 0.01, 1.502, -0.005, 0.01, 1.51, -0.005, -0.01, 1.51, -0.005);
  return Float32Array.from(v);
}

function mouthFaces(): { faces: number[]; parts: number[] } {
  const faces: number[] = [];
  const parts: number[] = [];
  for (let k = 0; k < RIM; k++) {
    const a = k,
      b = (k + 1) % RIM;
    faces.push(a, b, RIM + a, b, RIM + b, RIM + a);
    parts.push(2, 2);
    faces.push(RIM + a, RIM + b, 16);
    parts.push(2);
  }
  faces.push(17, 18, 19, 17, 19, 20);
  parts.push(1, 1);
  return { faces, parts };
}

/**
 * A two-coefficient head: coefficient 0 opens the jaw (the lower lip, rim points 5-7, and the
 * teeth, 17-20, down 1 m per unit), 1 moves all +x.
 */
function mouthPack(options: { badVertex?: boolean } = {}): Uint8Array {
  const V = 21,
    E = 2;
  const neutral = mouthVertices();
  const lanes = new Uint16Array(V * E * 3);
  for (let v = 0; v < V; v++) {
    if ((v >= 5 && v <= 7) || v >= 17) lanes[(v * E + 0) * 3 + 1] = floatToHalf(-1);
    lanes[(v * E + 1) * 3 + 0] = floatToHalf(1);
  }
  const { faces, parts } = mouthFaces();
  const bag = Array.from({ length: 17 }, (_, i) => i);
  const header: Omit<AosRigHeader, 'buffers'> = {
    version: 1,
    model: 'gnm',
    vertexCount: V,
    coeffCount: E,
    maxInfluence: 4,
    units: 'm',
    headExt: {
      dim: E + 4,
      exprDim: E,
      gazeDim: 4,
      regions: [['lower_face', E]],
      reduced: { lower_face: E },
    },
    joints: [{ name: 'c_head', parent: -1 }],
    eyes: { names: ['left_eye', 'right_eye'] },
    bindTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mouth: {
      groups: [
        { name: 'teeth', vertices: 'mouthTeeth', look: { color: [0.9, 0.87, 0.8], gloss: 0.62 } },
        {
          name: 'mouth_sock',
          vertices: 'mouthBag',
          look: { color: [0.42, 0.16, 0.17], gloss: 0.35 },
        },
      ],
      faces: 'mouthFaces',
      faceParts: 'mouthFaceParts',
    },
  };
  const blobs: AosRigBlob[] = [
    { name: 'neutral', dtype: 'f32', shape: [V, 3], data: neutral },
    { name: 'basis', dtype: 'u32', shape: [lanes.length / 2], data: new Uint32Array(lanes.buffer) },
    { name: 'basisScale', dtype: 'f32', shape: [E], data: Float32Array.from([1, 1]) },
    { name: 'skinIndex', dtype: 'u16', shape: [V, 4], data: new Uint16Array(V * 4) },
    {
      name: 'skinWeight',
      dtype: 'f16',
      shape: [V, 4],
      data: Uint16Array.from({ length: V * 4 }, (_, i) => (i % 4 === 0 ? floatToHalf(1) : 0)),
    },
    { name: 'eyePositions', dtype: 'f32', shape: [2, 3], data: new Float32Array(6) },
    { name: 'eyeWeights', dtype: 'f32', shape: [2, V], data: new Float32Array(2 * V) },
    {
      name: 'restWorld',
      dtype: 'f32',
      shape: [1, 4, 4],
      data: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    },
    { name: 'jointParents', dtype: 'i32', shape: [1], data: Int32Array.from([-1]) },
    { name: 'faces', dtype: 'u32', shape: [faces.length / 3, 3], data: Uint32Array.from(faces) },
    {
      name: 'mouthTeeth',
      dtype: 'u32',
      shape: [4],
      data: Uint32Array.from([17, 18, 19, options.badVertex ? 99 : 20]),
    },
    { name: 'mouthBag', dtype: 'u32', shape: [bag.length], data: Uint32Array.from(bag) },
    {
      name: 'mouthFaces',
      dtype: 'u32',
      shape: [faces.length / 3, 3],
      data: Uint32Array.from(faces),
    },
    { name: 'mouthFaceParts', dtype: 'u32', shape: [parts.length], data: Uint32Array.from(parts) },
  ];
  return packAosRig(header, blobs);
}

/** `teeth.bin` for points on the teeth's first triangle. */
function teethBin(
  points: { bary: [number, number, number]; h: number }[],
  tri = [17, 18, 19],
): Uint8Array {
  const n = points.length;
  const out = new Uint8Array(24 + n * 28);
  out.set(new TextEncoder().encode('AOSTTH01'));
  const v = new DataView(out.buffer);
  v.setUint32(8, n, true);
  v.setFloat32(12, 0, true);
  v.setFloat32(16, 0, true);
  v.setFloat32(20, -0.006, true);
  points.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      v.setUint32(24 + (i * 3 + k) * 4, tri[k], true);
      v.setFloat32(24 + n * 12 + (i * 3 + k) * 4, p.bary[k], true);
    }
    v.setFloat32(24 + n * 24 + i * 4, p.h, true);
  });
  return out;
}

describe('the head pack carries the mouth', () => {
  it('parses the groups, their looks, the triangles and their parts', () => {
    const pack = parseAosRig(mouthPack());
    expect(pack.mouth?.groups.map((g) => g.name)).toEqual(['teeth', 'mouth_sock']);
    expect(pack.mouth?.groups[0].color).toEqual([0.9, 0.87, 0.8]);
    expect(pack.mouth?.groups[1].gloss).toBeCloseTo(0.35);
    expect(pack.mouth?.faces.length).toBe(26 * 3);
    expect([...(pack.mouth?.faceParts ?? [])].filter((p) => p === 1).length).toBe(2);
  });

  it('refuses a mouth that names a vertex the head does not have', () => {
    expect(() => parseAosRig(mouthPack({ badVertex: true }))).toThrow(/mouth/);
  });
});

describe('the mouth mesh', () => {
  it('walks the bag open end as one loop, in order round it', () => {
    const pack = parseAosRig(mouthPack());
    const mesh = buildMouthMesh(pack.mouth!);
    expect([...mesh.rim].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let k = 0; k < RIM; k++) {
      const step = (mesh.rim[(k + 1) % RIM] - mesh.rim[k] + RIM) % RIM;
      expect(step === 1 || step === RIM - 1).toBe(true);
    }
  });

  it('refuses a bag with two open ends', () => {
    const faces = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    expect(() => rimLoop(faces, () => true)).toThrow(/more than one loop/);
  });

  it('keeps a vertex list per part, and each vertex its own part triangles', () => {
    const mesh = buildMouthMesh(parseAosRig(mouthPack()).mouth!);
    expect([...mesh.partStart]).toEqual([0, 2, 26]);
    expect(mesh.ids.length).toBe(4 + 17);
    expect([...mesh.part.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    // The cap's centre is in the eight cap triangles; a teeth corner in one or two.
    const cap = mesh.ids.indexOf(16);
    expect(mesh.adjStart[cap + 1] - mesh.adjStart[cap]).toBe(8);
    expect(mesh.adjStart[1] - mesh.adjStart[0]).toBe(2);
    expect(mesh.adjTris.length).toBe(mesh.adjStart[mesh.ids.length] * 3);
    expect(mesh.bag).toBe(1);
  });

  it('shades the back of the bag darker than its front', () => {
    const pack = parseAosRig(mouthPack());
    const mesh = buildMouthMesh(pack.mouth!);
    const shade = mouthShade(mesh, restVertices(pack));
    expect(shade[mesh.ids.indexOf(0)]).toBeCloseTo(1, 5);
    expect(shade[mesh.ids.indexOf(16)]).toBeLessThan(0.1);
  });
});

describe('the rim follows the expression on the CPU', () => {
  it('matches neutral + basis, through the bind transform', () => {
    const pack = parseAosRig(mouthPack());
    const rim = Uint32Array.from([0, 6]);
    const out = new Float32Array(6);
    createVertexExpression(pack, rim).evaluate([0.004, 0.001, 9, 9, 9, 9], out);
    expect(out[0]).toBeCloseTo(0.025 + 0.001, 6);
    expect(out[1]).toBeCloseTo(1.5, 6);
    // Vertex 6 is on the lower lip: down 4 mm.
    expect(out[4]).toBeCloseTo(1.5 - 0.005 - 0.004, 6);
  });
});

describe('the window', () => {
  const setup = (open: number) => {
    const pack = parseAosRig(mouthPack());
    const mesh = buildMouthMesh(pack.mouth!);
    const ex = createVertexExpression(pack, mesh.rim);
    const rest = new Float32Array(RIM * 3);
    ex.evaluate([0, 0], rest);
    const now = new Float32Array(RIM * 3);
    ex.evaluate([open, 0], now);
    const corners = windowCorners(rest);
    return {
      rest,
      now,
      corners,
      restOff: windowRest(rest, corners),
      scratch: new Float32Array((RIM + 1) * 3),
    };
  };

  it('finds the corners across the mouth', () => {
    const { rest, corners } = setup(0);
    expect(Math.abs(rest[corners[0] * 3] - rest[corners[1] * 3])).toBeCloseTo(0.05, 6);
  });

  it('shows the inside only once the lips are clearly apart, never at a slight part', () => {
    expect(openStrength(0)).toBe(0);
    expect(openStrength(0.002)).toBe(0);
    expect(openStrength(OPEN_START_M)).toBe(0);
    const half = openStrength((OPEN_START_M + OPEN_FULL_M) / 2);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(openStrength(OPEN_FULL_M)).toBe(1);
    expect(openStrength(0.02)).toBe(1);
    // a page's own thresholds
    expect(openStrength(0.002, 0.002, 0.0035)).toBe(0);
    expect(openStrength(0.00275, 0.002, 0.0035)).toBeCloseTo(0.5, 9);
    expect(openStrength(0.0035, 0.002, 0.0035)).toBe(1);
  });

  it('narrows across and draws its edges in', () => {
    const { now, restOff, corners } = setup(0.004);
    const out = new Float32Array((RIM + 1) * 3);
    windowPoints(now, out, restOff, corners, 0.82, 0.0015);
    const [a, b] = corners;
    expect(Math.abs(out[a * 3] - out[b * 3])).toBeCloseTo(0.05 * 0.82, 5);
  });
});

describe("the window follows the lips' own points", () => {
  /** The rows of the inverse of a rest frame [e1 e2 n] (columns), as bindings.bin holds them. */
  function inverseRows(e1: number[], e2: number[], n: number[]): number[] {
    const m = [e1[0], e2[0], n[0], e1[1], e2[1], n[1], e1[2], e2[2], n[2]];
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6]);
    return [
      (m[4] * m[8] - m[5] * m[7]) / det,
      (m[2] * m[7] - m[1] * m[8]) / det,
      (m[1] * m[5] - m[2] * m[4]) / det,
      (m[5] * m[6] - m[3] * m[8]) / det,
      (m[0] * m[8] - m[2] * m[6]) / det,
      (m[2] * m[3] - m[0] * m[5]) / det,
      (m[3] * m[7] - m[4] * m[6]) / det,
      (m[1] * m[6] - m[0] * m[7]) / det,
      (m[0] * m[4] - m[1] * m[3]) / det,
    ];
  }

  /**
   * A face of five opaque points at the lips' edges: three on the upper lip 4 mm above the lip
   * line, bound to a triangle of the bag's upper half (which the jaw never moves), two on the
   * lower lip 4 mm below it, bound to a triangle whose rim edge the jaw moves (its back vertex
   * stays). The lower lip has no point at one place across the mouth, so that station borrows.
   */
  function face(rest: Float64Array): FaceSplats {
    const points: { p: [number, number, number]; tri: [number, number, number] }[] = [];
    for (const x of [-0.0177, 0, 0.0177]) points.push({ p: [x, 1.504, 0], tri: [1, 2, 9] });
    for (const x of [0, 0.0177]) points.push({ p: [x, 1.496, 0], tri: [5, 6, 13] });
    const bindings = new Float32Array(points.length * 28);
    const u = new Uint32Array(bindings.buffer);
    const at = (k: number): number[] => [rest[k * 3], rest[k * 3 + 1], rest[k * 3 + 2]];
    points.forEach(({ tri }, i) => {
      const o = i * 28;
      bindings[o + 4] = 1;
      u.set(tri, o + 8);
      bindings[o + 11] = 1;
      const [a, b, c] = tri.map(at);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const len = Math.hypot(n[0], n[1], n[2]);
      const rows = inverseRows(
        e1,
        e2,
        n.map((x) => x / len),
      );
      for (let r = 0; r < 3; r++)
        for (let k = 0; k < 3; k++) bindings[o + 12 + r * 4 + k] = rows[r * 3 + k];
      bindings.set(a, o + 24);
    });
    return {
      count: points.length,
      position(i, out) {
        out[0] = points[i].p[0];
        out[1] = points[i].p[1];
        out[2] = points[i].p[2];
      },
      opacity: () => 1,
      bindings,
    };
  }

  const setup = () => {
    const pack = parseAosRig(mouthPack());
    const mesh = buildMouthMesh(pack.mouth!);
    const rest = restVertices(pack);
    return { pack, rest, edges: buildLipEdges({ pack, mesh, rest, splats: face(rest) }) };
  };

  /** The window's stations with the jaw open by `open` metres, and the lips' gap. */
  const windowAt = (open: number) => {
    const { pack, edges } = setup();
    const vpos = new Float32Array(edges.verts.length * 3);
    createVertexExpression(pack, edges.verts).evaluate([open, 0], vpos);
    const moved = moveBoundPoints(edges, vpos, new Float64Array(edges.blend.length * 3));
    const out = new Float64Array(RIM * 3);
    const gap = lipEdgePoints(edges, moved, out, new Float64Array(RIM * 7));
    return { edges, out, gap, moved };
  };

  it('tells the lips apart by how their points move with the jaw', () => {
    const { edges } = setup();
    expect(edges.counts).toEqual({ upper: 3, lower: 2, candidates: 5 });
    // Rim points 5-7 open with the jaw: the lower lip; 0 and 4 are the corners.
    expect([...edges.lip]).toEqual([2, 0, 0, 0, 2, 1, 1, 1]);
    expect(edges.up[1]).toBeCloseTo(1, 6);
    expect(Math.abs(edges.across[0])).toBeCloseTo(1, 6);
    // The lower station with no point of its own borrows the nearest one of its lip.
    expect(edges.borrow[5]).toBe(6);
    expect(edges.borrow[6]).toBe(6);
    expect(edges.borrow[2]).toBe(2);
  });

  it("sits between the lips' points at rest, not on the model's rim", () => {
    const { out, gap } = windowAt(0);
    expect(gap).toBeCloseTo(0, 6);
    for (let k = 0; k < RIM; k++) expect(out[k * 3 + 1]).toBeCloseTo(1.5, 4);
  });

  it("opens with the lower lip's points and never below them, and shows once clearly apart", () => {
    const rest = restVertices(parseAosRig(mouthPack()));
    const a = windowAt(0.002),
      b = windowAt(0.004),
      c = windowAt(0.006),
      d = windowAt(0.01);
    expect(a.gap).toBeGreaterThan(0);
    expect(b.gap).toBeGreaterThan(a.gap);
    expect(c.gap).toBeGreaterThan(b.gap);
    expect(d.gap).toBeGreaterThan(c.gap);
    // The lower lip's own points drop by the jaw's move, exactly as the bound-splat shader moves them.
    expect(c.moved[3 * 3 + 1]).toBeCloseTo(1.496 - 0.006, 4);
    // The lower middle station follows them (most of the move; an eight-point rim shares a
    // little with the corners), the upper middle station stays close to the upper lip.
    expect(1.5 - c.out[6 * 3 + 1]).toBeGreaterThan(0.75 * 0.006);
    expect(1.5 - c.out[2 * 3 + 1]).toBeLessThan(0.25 * 0.006);
    expect(c.gap).toBeGreaterThan(0.5 * 0.006);
    expect(c.gap).toBeLessThanOrEqual(0.006);
    // The model's own rim drops further than the splat's lower lip: the window stops at the points.
    const rim6 = rest[6 * 3 + 1] - 0.006;
    expect(c.out[6 * 3 + 1]).toBeGreaterThan(rim6 + 0.004);
    expect(openStrength(a.gap)).toBe(0);
    expect(openStrength(d.gap)).toBe(1);
  });

  it('holds each lip on its side of the middle line, so a fold closes instead of crossing', () => {
    // Four points and the centre: corners at x = +-1, an upper point 1 mm BELOW the middle, a
    // lower point 1 mm ABOVE it.
    const win = Float32Array.from([1, 0, 0, 0, -0.001, 0, -1, 0, 0, 0, 0.001, 0, 0, 0, 0]);
    const lip = Uint8Array.from([2, 0, 2, 1]);
    const bound = new Float32Array(12),
      middle = new Float32Array(12);
    holdLips(win, lip, [1, 0, 0], [0, 1, 0], bound, middle);
    expect(bound[1 * 3 + 1]).toBeCloseTo(0, 9);
    expect(bound[3 * 3 + 1]).toBeCloseTo(0, 9);
    expect(middle[1 * 3 + 1]).toBeCloseTo(0, 9);
    // A lip on its own side is left where it is.
    const open = Float32Array.from([1, 0, 0, 0, 0.002, 0, -1, 0, 0, 0, -0.002, 0, 0, 0, 0]);
    holdLips(open, lip, [1, 0, 0], [0, 1, 0], bound, middle);
    expect(bound[1 * 3 + 1]).toBeCloseTo(0.002, 9);
    expect(bound[3 * 3 + 1]).toBeCloseTo(-0.002, 9);
  });

  it('builds the soft rim on the screen: the same feather from every side, none past the middle', () => {
    // A lens 200 px wide: corners, an upper point 20 px up, a lower point 20 px down.
    const p = Float32Array.from([100, 0, 0, -20, -100, 0, 0, 20]);
    const m = Float32Array.from([100, 0, 0, 0, -100, 0, 0, 0]);
    const lip = Uint8Array.from([2, 0, 2, 1]);
    const outer = new Float32Array(8),
      inner = new Float32Array(8),
      value = new Float32Array(4);
    screenRings(p, m, lip, 10, outer, inner, value);
    expect(outer[3]).toBeCloseTo(-25, 6);
    expect(inner[3]).toBeCloseTo(-15, 6);
    expect(outer[7]).toBeCloseTo(25, 6);
    expect(inner[7]).toBeCloseTo(15, 6);
    expect(outer[0]).toBeCloseTo(105, 6);
    expect(value[1]).toBe(1);
    expect(value[3]).toBe(1);
    expect(value[0]).toBe(0);
    // Barely apart (2 px from the middle): the inner ring stops at the middle, the mask fades.
    const near = Float32Array.from([100, 0, 0, -2, -100, 0, 0, 2]);
    screenRings(near, m, lip, 10, outer, inner, value);
    expect(inner[3]).toBeCloseTo(0, 6);
    expect(value[1]).toBeGreaterThan(0);
    expect(value[1]).toBeLessThan(0.15);
  });

  it('triangulates the window as a strip between the lips and a band between the rings', () => {
    const lip = Uint8Array.from([2, 0, 0, 0, 2, 1, 1, 1]);
    const t = [25, 17.7, 0, -17.7, -25, -17.7, 0, 17.7];
    const tris = featherTriangles(lip, t);
    // The strip: (5 - 1) + (5 - 1) triangles on the inner ring; the band: two per rim edge.
    expect(tris.length).toBe((8 + 16) * 3);
    expect(Math.max(...tris)).toBe(15);
    expect(Math.min(...tris.subarray(0, 24))).toBe(8);
    expect(() => featherTriangles(Uint8Array.from([2, 0, 0, 0]), [0, 1, 2, 3])).toThrow(
      /two corners/,
    );
  });
});

describe('the teeth files', () => {
  it('reads teeth.json and refuses names that are not plain sibling files', () => {
    expect(parseTeethInfo({ points: 3, ply: 'teeth.ply', binding: 'teeth.bin' })).toEqual({
      points: 3,
      ply: 'teeth.ply',
      binding: 'teeth.bin',
    });
    expect(() => parseTeethInfo({ points: 3, ply: '../x.ply', binding: 'teeth.bin' })).toThrow();
    expect(() => parseTeethInfo({ points: 0, ply: 'teeth.ply', binding: 'teeth.bin' })).toThrow();
  });

  it('reads teeth.bin and refuses a bad magic, size, vertex or weight', () => {
    const bin = teethBin([{ bary: [0.2, 0.3, 0.5], h: 0.001 }]);
    const b = parseTeethBinding(bin, 21);
    expect(b.count).toBe(1);
    expect(b.setBack[2]).toBeCloseTo(-0.006);
    expect([...b.tri]).toEqual([17, 18, 19]);
    expect(b.height[0]).toBeCloseTo(0.001);
    expect(() => parseTeethBinding(bin.slice(0, -1), 21)).toThrow(/size/);
    expect(() => parseTeethBinding(bin, 19)).toThrow(/vertex/);
    const bad = bin.slice();
    bad[0] = 0x58;
    expect(() => parseTeethBinding(bad, 21)).toThrow(/not a teeth/);
    expect(() => parseTeethBinding(teethBin([{ bary: [0.2, 0.3, 0.2], h: 0 }]), 21)).toThrow(/sum/);
  });

  it('keeps each point where its file has it, in the character frame or the ply frame', () => {
    const pack = parseAosRig(mouthPack());
    const rest = restVertices(pack);
    const b = parseTeethBinding(
      teethBin([
        { bary: [0.2, 0.3, 0.5], h: 0.001 },
        { bary: [1, 0, 0], h: 0 },
      ]),
      21,
    );
    const p: [number, number, number] = [0, 0, 0];
    const centres = new Float32Array(6);
    for (let i = 0; i < 2; i++) centres.set(teethPoint(b, i, rest, p), i * 3);
    centres[2] += 0.001; // the file a millimetre forward of its binding
    const plain = teethOffsets(centres, b, rest, [0, 1.31, 0]);
    expect(plain.offsets[2]).toBeCloseTo(0.001, 6);
    expect(plain.mean[2]).toBeCloseTo(0.0005, 6);
    const inPly = centres.map((x, i) => (i % 3 === 1 ? x - 1.31 : x));
    expect(teethOffsets(inPly, b, rest, [0, 1.31, 0]).offsets[1]).toBeCloseTo(0, 5);
    const far = centres.map((x, i) => (i % 3 === 0 ? x + 0.1 : x));
    expect(() => teethOffsets(far, b, rest, [0, 1.31, 0])).toThrow(/another/);
  });
});

describe('loading a package with and without its teeth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function sha(bytes: Uint8Array): Promise<string> {
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    );
    return Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function serve(extra: Record<string, Uint8Array | string>): Promise<void> {
    const files: Record<string, Uint8Array> = {};
    for (const name of ['character.ply', 'rig.glb', 'head.aosrig', 'bindings.bin'])
      files[name] = new TextEncoder().encode(name);
    const descriptor = {
      format: 'aosrig-splat',
      version: 1,
      rig: 'aosrig_v0',
      renderer: 'webgpu',
      units: 'm',
      splatCount: 1,
      headVertexCount: 1,
      jointNames: ['c_head'],
      plyToCharacter: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      bounds: { center: [0, 0, 0], radius: 1 },
      files: {} as Record<string, { src: string; sha256: string }>,
    };
    for (const [name, bytes] of Object.entries(files))
      descriptor.files[name] = { src: name, sha256: await sha(bytes) };
    const all: Partial<Record<string, Uint8Array | string>> = {
      'character.json': JSON.stringify(descriptor),
      ...files,
      ...extra,
    };
    vi.stubGlobal('fetch', (url: string) => {
      const name = new URL(url).pathname.split('/').pop() ?? '';
      const body = all[name];
      if (body === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
      return Promise.resolve(new Response(typeof body === 'string' ? body : (body as BodyInit)));
    });
  }

  it('loads a package without them exactly as before', async () => {
    await serve({});
    const bundle = await loadAosrigSplatBundle('http://x/characters/a/character.json');
    expect(bundle.teeth).toBeUndefined();
    expect(Object.keys(bundle)).toEqual(['descriptor', 'files']);
  });

  it('shrugs off a page answered in place of teeth.json', async () => {
    await serve({ 'teeth.json': '<!doctype html><html></html>' });
    expect(
      (await loadAosrigSplatBundle('http://x/characters/a/character.json')).teeth,
    ).toBeUndefined();
  });

  it('carries the three files when they are there', async () => {
    await serve({
      'teeth.json': JSON.stringify({ points: 1, ply: 'teeth.ply', binding: 'teeth.bin' }),
      'teeth.ply': new Uint8Array([1, 2, 3]),
      'teeth.bin': new Uint8Array([4, 5]),
    });
    const bundle = await loadAosrigSplatBundle('http://x/characters/a/character.json');
    expect(bundle.teeth?.info.points).toBe(1);
    expect([...(bundle.teeth?.ply ?? [])]).toEqual([1, 2, 3]);
    expect([...(bundle.teeth?.binding ?? [])]).toEqual([4, 5]);
  });

  it('draws without them when teeth.json names files that are not there', async () => {
    const warn = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await serve({
      'teeth.json': JSON.stringify({ points: 1, ply: 'teeth.ply', binding: 'teeth.bin' }),
    });
    expect(
      (await loadAosrigSplatBundle('http://x/characters/a/character.json')).teeth,
    ).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
