// The ORL pack container, the deform formula, and the CSR that inverts it for the GPU.
//
// Ported from aos-threejs-poc/tests/unit/{orlPack,orlDeformSynthetic,orlCsr}.test.mjs
// @ cdd63b10, along with the fixture they run on.
//
// THE FIXTURE IS SYNTHETIC, and that is the point. Every other ORL numeric gate in the
// POC needed a real character's baked pack — identity data, never committed — so all of
// them skipped in CI and the formula that four implementations have to agree on had
// nothing checking it on a push. `test/fixtures/orl/deform-synthetic.json` is a seeded,
// made-up pack plus five posed cases with expected vertices, produced once by an
// independent slow reference. It is base64 in JSON rather than a `.bin` because
// `.gitattributes` would send a `.bin` to LFS and a clone without LFS would get a
// pointer file.
//
// It carries NO DNA: the deform needs geometry, not an identity, and turning controls
// into joint outputs is OpenRigLogic's job. The fixture supplies joint and blendshape
// outputs directly, and `createOrlRig` would rightly refuse it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildBlendshapeCsr, type BlendshapeTarget } from './rig/orl/csr.js';
import { createDeformer, type OrlBuffers, type OrlManifest } from './rig/orl/deform.js';
import {
  hasOrlBundle,
  orlAssetName,
  orlBundleAssetNames,
  ORL_BUNDLE_FILES,
  ORL_PACK_FILE,
  ORL_REQUIRED_MEMBERS,
} from './rig/orl/bundleFiles.js';
import { packOrlBundle, parseOrlPack } from './rig/orl/orlPack.js';
import { uniformCapacityError, skinRowsBytes, DEFAULT_UNIFORM_LIMIT } from './rig/orl/gpuLimits.js';
import {
  assignShellJoints,
  poseShells,
  shellCentroids,
  splitShells,
  SHELL_JOINT_NAMES,
} from './rig/orl/shellDeform.js';
import { buildControlMap, detectControlSpace, mhNameToDna } from './rig/orl/orlRig.js';

interface SyntheticCase {
  name: string;
  why: string;
  jointOut: number[];
  bsOut: number[];
  expected: number[];
}
interface SyntheticFixture {
  seed: number;
  tolerance_cm: number;
  manifest: OrlManifest & { mesh: string };
  packBase64: string;
  cases: SyntheticCase[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('../test/fixtures/orl/deform-synthetic.json', import.meta.url), 'utf8'),
) as SyntheticFixture;
const TOL = FIXTURE.tolerance_cm;

const bytes = (...v: number[]) => new Uint8Array(v);

describe('the pack container', () => {
  const members = [
    { name: 'manifest.json', bytes: new TextEncoder().encode('{"V":3}') },
    { name: 'neutral_pos.bin', bytes: bytes(1, 2, 3, 4, 5) },
    { name: 'bs_delta.bin', bytes: bytes(9) },
  ];

  it('round-trips every member byte for byte', () => {
    const p = parseOrlPack(packOrlBundle(members));
    expect(p.names).toEqual(members.map((m) => m.name));
    for (const m of members) expect([...p.get(m.name)!]).toEqual([...m.bytes]);
    expect(p.json('manifest.json')).toEqual({ V: 3 });
  });

  it('packs deterministically — the same bake packs to identical bytes', () => {
    expect([...packOrlBundle(members)]).toEqual([...packOrlBundle(members)]);
  });

  it('8-byte aligns members, so a reader can view them without copying', () => {
    const p = parseOrlPack(packOrlBundle(members));
    for (const m of members) expect(p.get(m.name)!.byteOffset % 8).toBe(0);
  });

  it('preserves an empty member as empty rather than dropping it', () => {
    const p = parseOrlPack(
      packOrlBundle([...members, { name: 'empty.bin', bytes: new Uint8Array(0) }]),
    );
    expect(p.has('empty.bin')).toBe(true);
    expect(p.get('empty.bin')!.length).toBe(0);
  });

  it('survives a member large enough to grow the TOC past its first encoding', () => {
    // The TOC records ABSOLUTE offsets, so its own encoded length grows with the digit
    // count of those offsets — the packer re-encodes until it converges. A member big
    // enough to push offsets to 7 digits exercises that.
    const big = new Uint8Array(1_200_000).fill(7);
    const p = parseOrlPack(packOrlBundle([{ name: 'big.bin', bytes: big }, ...members]));
    expect(p.get('big.bin')!.length).toBe(big.length);
    expect(p.get('big.bin')![1_199_999]).toBe(7);
    for (const m of members) expect([...p.get(m.name)!]).toEqual([...m.bytes]);
  });

  it('refuses a truncation rather than reading it as a valid rig', () => {
    // The last member is padded to an 8-byte boundary, so a small truncation passes
    // every per-member bounds check — which is exactly why the header carries a total.
    const packed = packOrlBundle(members);
    expect(() => parseOrlPack(packed.subarray(0, packed.length - 4))).toThrow(
      /truncated or corrupt/,
    );
  });

  it('refuses bytes that are not a pack at all', () => {
    // An HTML error page must not read as an empty-but-valid rig, which would render a
    // head that simply never moves.
    expect(() => parseOrlPack(new TextEncoder().encode('<!DOCTYPE html><html>404'))).toThrow(
      /not an ORL pack/,
    );
    expect(() => parseOrlPack(new Uint8Array(4))).toThrow(/too short/);
  });

  it('refuses a duplicate member name on the way in', () => {
    expect(() => packOrlBundle([members[0], members[0]])).toThrow(/duplicate member/);
    expect(() => packOrlBundle([])).toThrow(/no members/);
  });

  it('names the bundle asset the loader looks for', () => {
    expect(orlAssetName(ORL_PACK_FILE)).toBe('orl_pack.bin');
    expect(orlBundleAssetNames()).toEqual(['orl_pack.bin']);
    expect(hasOrlBundle((n) => n === 'orl_pack.bin')).toBe(true);
    expect(hasOrlBundle(() => false)).toBe(false);
    // `mesh_idx.bin` rides along but nothing at runtime reads it.
    expect(ORL_BUNDLE_FILES).toContain('mesh_idx.bin');
    expect(ORL_REQUIRED_MEMBERS).not.toContain('mesh_idx.bin');
  });
});

describe('the deform formula', () => {
  const pack = parseOrlPack(Uint8Array.from(Buffer.from(FIXTURE.packBase64, 'base64')));
  const ab = (name: string): ArrayBuffer => {
    const b = pack.get(name)!;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const bufs: Record<string, ArrayBuffer> = {};
  for (const n of [
    'neutral_pos',
    'joint_neutral',
    'joint_parents',
    'inverse_bind',
    'skin_idx',
    'skin_w',
    'bs_index',
    'bs_delta',
  ]) {
    bufs[n] = ab(`${n}.bin`);
  }
  const manifest = pack.json('manifest.json') as OrlManifest & { mesh: string };
  const bsTargets = pack.json('bs_targets.json') as BlendshapeTarget[];
  const deformer = createDeformer(manifest, bufs as unknown as OrlBuffers, bsTargets);

  const worst = (got: ArrayLike<number>, want: ArrayLike<number>): number => {
    let max = 0;
    for (let i = 0; i < want.length; i += 3) {
      const d = Math.hypot(got[i] - want[i], got[i + 1] - want[i + 1], got[i + 2] - want[i + 2]);
      if (d > max) max = d;
    }
    return max;
  };

  it('runs on a synthetic pack, not a character', () => {
    expect(manifest.mesh).toBe('synthetic_deform_fixture');
    // A DNA here would be identity data — this fixture exists so the deform can be
    // gated without one.
    expect(pack.has('head_behavior.dna')).toBe(false);
    expect(deformer.V).toBe(manifest.V);
    expect(deformer.J).toBe(manifest.numJoints);
    expect(deformer.maxInf).toBe(manifest.maxInfluence);
  });

  for (const c of FIXTURE.cases) {
    it(`matches the reference: ${c.name}`, () => {
      const out = deformer.deform(Float32Array.from(c.jointOut), Float32Array.from(c.bsOut));
      expect(out.length).toBe(c.expected.length);
      const d = worst(out, c.expected);
      expect(d, `${c.why}\n  max vertex error ${d.toExponential(2)} cm`).toBeLessThanOrEqual(TOL);
    });
  }

  it('is EXACT at the neutral, not merely within tolerance', () => {
    // With every delta zero, `skin = world · inverseBind` is the identity for every
    // joint, so the weights sum to 1 against an unchanged point. Anything but a
    // near-perfect match means `inverse_bind` and the joint walk disagree — and that
    // error is a constant offset calibration would then quietly absorb.
    const neutral = FIXTURE.cases.find((c) => c.name === 'neutral')!;
    const out = deformer.deform(
      Float32Array.from(neutral.jointOut),
      Float32Array.from(neutral.bsOut),
    );
    expect(worst(out, deformer.neutral)).toBeLessThan(1e-4);
  });

  it('is reusable — a second call does not accumulate into the first', () => {
    // `deform()` returns internal scratch. A missing reset would make every frame a sum
    // of every frame before it, which reads as the face slowly inflating.
    const c = FIXTURE.cases.find((x) => x.name === 'mixed')!;
    const j = Float32Array.from(c.jointOut);
    const b = Float32Array.from(c.bsOut);
    deformer.deform(j, b);
    const second = Float32Array.from(deformer.deform(j, b));
    expect(worst(second, c.expected)).toBeLessThanOrEqual(TOL);
  });

  it('refuses a hierarchy whose parent comes after its child', () => {
    // The forward walk reads `world[parent]` before it writes `world[j]`, and `world` is
    // scratch REUSED ACROSS FRAMES — so an out-of-order parent reads LAST FRAME's matrix
    // and propagates it to every descendant. No exception, no NaN, just a face posed off
    // a stale parent.
    const parents = new Int32Array(bufs.joint_parents.slice(0));
    const broken = { ...bufs, joint_parents: parents.buffer };
    parents[1] = manifest.numJoints - 1;
    expect(() => createDeformer(manifest, broken as unknown as OrlBuffers, bsTargets)).toThrow(
      /not topologically ordered/,
    );
  });

  it('refuses blendshape runs that do not tile their arrays', () => {
    // A gap leaves those deltas at zero, so they silently vanish from every posed frame:
    // not a crash, not visible in a log.
    const shifted = bsTargets.map((t, i) => (i === 1 ? { ...t, offset: t.offset + 1 } : t));
    expect(() => createDeformer(manifest, bufs as unknown as OrlBuffers, shifted)).toThrow(
      /do not tile/,
    );
  });

  it('inverts the blendshape scatter into the per-vertex gather the GPU needs', () => {
    // The CSR must NOT re-apply the int8 scale the deformer already applied at load:
    // that bug left the neutral bit-exact (no blendshapes active) and every posed frame
    // wrong by up to 0.6 cm, which only a posed comparison catches.
    const csr = buildBlendshapeCsr(
      deformer.V,
      deformer.buffers.bsIndex,
      deformer.buffers.bsDelta,
      bsTargets,
    );
    expect(csr.offset.length).toBe(deformer.V + 1);
    expect(csr.offset[deformer.V]).toBe(csr.entries);

    const viaScatter = new Map<string, [number, number, number]>();
    for (const t of bsTargets) {
      for (let k = 0; k < t.count; k++) {
        const key = `${String(deformer.buffers.bsIndex[t.offset + k])}:${String(t.channel)}`;
        const d = viaScatter.get(key) ?? [0, 0, 0];
        for (let c = 0; c < 3; c++) d[c] += deformer.buffers.bsDelta[(t.offset + k) * 3 + c];
        viaScatter.set(key, d);
      }
    }
    const viaGather = new Map<string, [number, number, number]>();
    for (let v = 0; v < deformer.V; v++) {
      for (let e = csr.offset[v]; e < csr.offset[v + 1]; e++) {
        const key = `${String(v)}:${String(csr.channel[e])}`;
        const d = viaGather.get(key) ?? [0, 0, 0];
        for (let c = 0; c < 3; c++) d[c] += csr.delta[e * 3 + c];
        viaGather.set(key, d);
      }
    }
    expect(viaGather.size).toBe(viaScatter.size);
    for (const [key, want] of viaScatter) {
      const got = viaGather.get(key);
      expect(got, `CSR is missing ${key}`).toBeDefined();
      for (let c = 0; c < 3; c++) expect(Math.abs(got![c] - want[c])).toBeLessThan(1e-6);
    }
  });

  it('packs the skin rows the WGSL deform reads', () => {
    // 12 floats per joint: rows 0-2 of the row-major 4x4, which the shader reads as 3
    // vec4. Row 3 is (0,0,0,1) on an affine transform and is not uploaded.
    const c = FIXTURE.cases.find((x) => x.name === 'mixed')!;
    const rows = deformer.computeSkinRows(Float32Array.from(c.jointOut));
    expect(rows.length).toBe(deformer.J * 12);
    const skin = deformer.computeSkin(Float32Array.from(c.jointOut));
    for (let j = 0; j < deformer.J; j++) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          expect(rows[j * 12 + row * 4 + col]).toBeCloseTo(skin[j * 16 + row * 4 + col], 5);
        }
      }
    }
  });
});

describe('the GPU deform capacity check', () => {
  it('lets a MetaHuman head through and names the DNA when one would not fit', () => {
    // The skin rows are a UNIFORM so the pipeline stays at 7 storage bindings and does
    // not depend on an adapter granting more than the WebGPU default. The trade is a
    // 64 KiB ceiling, which is ~1365 joints; a MetaHuman head is 870.
    expect(skinRowsBytes(870)).toBe(41_760);
    expect(uniformCapacityError(870, null)).toBeNull();
    const tooMany = Math.floor(DEFAULT_UNIFORM_LIMIT / 48) + 1;
    expect(uniformCapacityError(tooMany, null)).toMatch(/joints/);
  });
});

describe('the rigid-shell deform', () => {
  // Two separate quads, sharing no vertex: exactly the shape the eyes/teeth branch has.
  const verts = Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 11, 1, 0, 10, 1, 0,
  ]);
  const faces = Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  it('splits by CONNECTIVITY, largest first', () => {
    const shells = splitShells(faces, 8);
    expect(shells.length).toBe(2);
    expect([...shells[0]]).toEqual([0, 1, 2, 3]);
    expect([...shells[1]]).toEqual([4, 5, 6, 7]);
  });

  it('gives one joint AT MOST ONE shell', () => {
    // Per-shell independent nearest would bind both eyeballs to the same eye joint if
    // the frame were off — and then the eyes track together, perfectly, and only look
    // wrong when something asks them to converge on a near target.
    const shells = splitShells(faces, 8);
    const centroids = shellCentroids(verts, shells);
    const origins = Float32Array.from([0.5, 0.5, 0, 0.6, 0.5, 0]);
    const assigned = assignShellJoints(centroids, origins, [0, 1], 4);
    expect(new Set(assigned.filter((j) => j >= 0)).size).toBe(
      assigned.filter((j) => j >= 0).length,
    );
    expect(assigned[0]).toBe(0);
    // The second shell is 10 units away from both candidates, past `maxDistCm`.
    expect(assigned[1]).toBe(-1);
  });

  it('leaves an unrecognised shell at its neutral', () => {
    const shells = splitShells(faces, 8);
    const rel = new Float32Array(2 * 16);
    // Joint 0 translates by +5 in x; joint 1 is never used.
    rel.set([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    const out = new Float32Array(verts.length);
    poseShells(verts, shells, [0, -1], rel, out);
    expect(out[0]).toBe(5);
    expect(out[12]).toBe(10); // the unassigned shell is untouched
  });

  it('names the four joints a head.dna actually articulates', () => {
    // `head` is deliberately absent: FACIAL_C_TeethUpper is itself rigid to the head, so
    // it gives the same answer while keeping the candidate set to articulated parts.
    expect(SHELL_JOINT_NAMES).toEqual([
      'FACIAL_L_Eye',
      'FACIAL_R_Eye',
      'FACIAL_C_TeethUpper',
      'FACIAL_C_TeethLower',
    ]);
  });
});

describe('the control map', () => {
  it('translates MetaHuman names into DNA GUI names', () => {
    expect(mhNameToDna('CTRL_C_jaw.translateY')).toBe('CTRL_C_jaw.ty');
    expect(mhNameToDna('CTRL_expressions.browDownL')).toBe('CTRL_expressions.browDownL');
  });

  it('decides the control LAYER by counting, not by a flag', () => {
    // GUI and RAW are disjoint namespaces, so a list scores in one and zero in the
    // other. A raw-solved bundle resolves 0 of 263 through the GUI map, and the error
    // that produces blames the DNA when the DNA is correct.
    const gui = ['CTRL_C_jaw.ty', 'CTRL_L_eye_blink.ty'];
    const raw = ['CTRL_expressions.jawOpen', 'CTRL_expressions.eyeBlinkL'];
    expect(detectControlSpace(['CTRL_C_jaw.translateY'], gui, raw)).toMatchObject({
      space: 'gui',
      nGui: 1,
      nRaw: 0,
    });
    expect(detectControlSpace(['CTRL_expressions.jawOpen'], gui, raw)).toMatchObject({
      space: 'raw',
      nRaw: 1,
      nGui: 0,
    });
  });

  it('tolerates unmatched controls but refuses a map that resolves almost nothing', () => {
    const gui = ['CTRL_C_jaw.ty'];
    const map = buildControlMap(['CTRL_C_jaw.translateY', 'CTRL_C_eyesAim.translateX'], gui);
    expect([...map.forInput]).toEqual([0, -1]);
    expect(map.matched).toBe(1);
    expect(map.unmatched).toEqual(['CTRL_C_eyesAim.translateX']);
    expect(() => buildControlMap(['nope'], gui, { minMatched: 1 })).toThrow(
      /control map regressed/,
    );
  });
});
