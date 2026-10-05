// The pose corrections as data: the index, the two per-splat files, the weight curve, the
// arm's elevation, the packed lanes, and a package loading with and without its folder.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { floatToHalf } from '../rig/gnm/gnmPack.js';
import {
  LANE,
  MAX_CORRECTIONS_PLAYED,
  armAngleDeg,
  blendWeight,
  correctivePoints,
  fadedCount,
  newLanes,
  ownLanes,
  parseCorrectiveIndex,
  parseFade,
  parseSide,
} from './corrective.js';
import { loadAosrigSplatBundle, parseDescriptor } from './format.js';

const JOINTS = ['root', 'c_spine3', 'l_uparm', 'l_lowarm', 'r_uparm', 'r_lowarm', 'c_head'];
const RIG = { splatCount: 6, jointNames: JOINTS };

/** Tala's index, scaled to a six-splat character. */
function index(patch: (v: Record<string, unknown>) => void = () => undefined): unknown {
  const drive = (side: number, l: string): Record<string, unknown> => ({
    side,
    bone: [`${l}_uparm`, `${l}_lowarm`],
    frame: 'c_spine3',
    restDeg: 24.36,
    fromDeg: 29.36,
    toDeg: 57.18,
    curve: 'smoothstep',
  });
  const v: Record<string, unknown> = {
    format: 'aosrig-splat-corrective',
    version: 1,
    corrections: [
      {
        name: 'arms_up_90',
        label: 'Arms up 90',
        trainedDeg: 90,
        drives: [drive(0, 'l'), drive(1, 'r')],
        splatCount: 6,
        points: 2,
        faded: 3,
        files: {
          'fade.bin': 'arms_up_90/fade.bin',
          'side.bin': 'arms_up_90/side.bin',
          'points.ply': 'arms_up_90/points.ply',
          'points_bindings.bin': 'arms_up_90/points_bindings.bin',
          'points_side.bin': 'arms_up_90/points_side.bin',
        },
      },
    ],
  };
  patch(v);
  return v;
}

const halves = (values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((x, i) => {
    view.setUint16(i * 2, floatToHalf(x), true);
  });
  return out;
};

describe('the index', () => {
  it('reads the drives, the counts and the paths', () => {
    const [c] = parseCorrectiveIndex(index(), RIG);
    expect(c.name).toBe('arms_up_90');
    expect(c.trainedDeg).toBe(90);
    expect(c.drives.map((d) => d.side)).toEqual([0, 1]);
    expect(c.drives[1].bone).toEqual(['r_uparm', 'r_lowarm']);
    expect(c.drives[0].frame).toBe('c_spine3');
    expect(c.points).toBe(2);
    expect(c.files['fade.bin']).toBe('arms_up_90/fade.bin');
    expect(c.sha256).toEqual({});
  });

  it('refuses another format, another character, a joint the rig lacks, angles out of order, a path that climbs', () => {
    expect(() =>
      parseCorrectiveIndex(
        index((v) => (v.format = 'x')),
        RIG,
      ),
    ).toThrow(/not a pose/);
    expect(() => parseCorrectiveIndex(index(), { ...RIG, splatCount: 7 })).toThrow(/another/);
    const corr = (v: Record<string, unknown>): Record<string, unknown> =>
      (v.corrections as Record<string, unknown>[])[0];
    expect(() =>
      parseCorrectiveIndex(
        index((v) => ((corr(v).drives as Record<string, unknown>[])[0].bone = ['l_uparm', 'x'])),
        RIG,
      ),
    ).toThrow(/joints/);
    expect(() =>
      parseCorrectiveIndex(
        index((v) => ((corr(v).drives as Record<string, unknown>[])[0].toDeg = 20)),
        RIG,
      ),
    ).toThrow(/order/);
    expect(() =>
      parseCorrectiveIndex(
        index((v) => ((corr(v).files as Record<string, string>)['fade.bin'] = '../fade.bin')),
        RIG,
      ),
    ).toThrow(/path/);
    expect(() =>
      parseCorrectiveIndex(
        index((v) => ((corr(v).drives as Record<string, unknown>[])[1].side = 0)),
        RIG,
      ),
    ).toThrow(/side/);
  });
});

describe('the per-splat files', () => {
  it('reads float16 keep factors and refuses the wrong size or a factor past 1', () => {
    const fade = parseFade(halves([1, 0.5, 0, 1, 0.25, 1]), 6);
    expect([...fade]).toEqual([1, 0.5, 0, 1, 0.25, 1]);
    expect(fadedCount(fade)).toBe(3);
    expect(() => parseFade(halves([1, 1]), 6)).toThrow(/size/);
    expect(() => parseFade(halves([1, 2, 1, 1, 1, 1]), 6)).toThrow(/0\.\.1/);
  });

  it('reads sides and refuses a third side', () => {
    expect([...parseSide(Uint8Array.from([0, 1, 1, 0, 0, 1]), 6)]).toEqual([0, 1, 1, 0, 0, 1]);
    expect(() => parseSide(Uint8Array.from([0, 2, 0, 0, 0, 0]), 6)).toThrow(/side/);
    expect(() => parseSide(Uint8Array.from([0]), 6)).toThrow(/size/);
  });
});

describe('the blend', () => {
  const drive = { fromDeg: 29.36, toDeg: 57.18 };
  it('is 0 up to fromDeg, 1 from toDeg, a smoothstep between', () => {
    expect(blendWeight(0, drive)).toBe(0);
    expect(blendWeight(29.36, drive)).toBe(0);
    expect(blendWeight((29.36 + 57.18) / 2, drive)).toBeCloseTo(0.5, 9);
    expect(blendWeight(57.18, drive)).toBe(1);
    expect(blendWeight(120, drive)).toBe(1);
    // Tala at 45 degrees, as the studio measured it: about two thirds
    expect(blendWeight(45, drive)).toBeCloseTo(0.593, 2);
  });

  it("reads the arm's elevation in the frame joint's rest orientation", () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(armAngleDeg(0, -1, 0, I)).toBeCloseTo(0, 9);
    expect(armAngleDeg(0.5, 0, 0, I)).toBeCloseTo(90, 9);
    expect(armAngleDeg(0, 0, 0.5, I)).toBeCloseTo(90, 9);
    expect(armAngleDeg(0, 2, 0, I)).toBeCloseTo(180, 9);
    expect(armAngleDeg(1, -1, 0, I)).toBeCloseTo(45, 9);
    expect(armAngleDeg(0, 0, 0, I)).toBe(0);
    // The torso leans 90 degrees about z (its up went to -x); an arm hanging along the
    // leaning torso (+x) still reads 0, an arm straight out from it reads 90.
    const lean = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(armAngleDeg(1, 0, 0, lean)).toBeCloseTo(0, 9);
    expect(armAngleDeg(0, 1, 0, lean)).toBeCloseTo(90, 9);
  });
});

describe('the lanes', () => {
  it('give each own splat the strongest fade among the played corrections, and its slot', () => {
    const records = new Float32Array(3 * 44);
    for (let n = 0; n < 3; n++) records[n * 44 + LANE.fade] = 1;
    const a = { fade: Float32Array.from([1, 0.5, 0.2]), side: Uint8Array.from([0, 1, 0]) };
    const b = { fade: Float32Array.from([0.9, 0.8, 0.1]), side: Uint8Array.from([1, 1, 1]) };
    ownLanes(records, 0, 3, [a, b]);
    const lane = (n: number, k: number): number => records[n * 44 + k];
    expect([lane(0, LANE.fade), lane(0, LANE.slot), lane(0, LANE.kind)]).toEqual([
      expect.closeTo(0.9, 6),
      3,
      0,
    ]);
    expect([lane(1, LANE.fade), lane(1, LANE.slot)]).toEqual([0.5, 1]);
    expect([lane(2, LANE.fade), lane(2, LANE.slot)]).toEqual([expect.closeTo(0.1, 6), 3]);
    // an untouched character: 1, 0, 0 (what the shader reads as unchanged)
    ownLanes(records, 0, 3, []);
    expect([lane(1, LANE.fade), lane(1, LANE.slot), lane(1, LANE.kind)]).toEqual([1, 0, 0]);
  });

  it('mark a new splat by its side and correction', () => {
    const records = new Float32Array(2 * 44);
    newLanes(records, 2, 1, Uint8Array.from([1, 0]));
    expect([records[LANE.fade], records[LANE.slot], records[LANE.kind]]).toEqual([1, 3, 1]);
    expect([records[44 + LANE.slot], records[44 + LANE.kind]]).toEqual([2, 1]);
  });

  it('counts the room the new splats need over the corrections played', () => {
    expect(correctivePoints(undefined)).toBe(0);
    const c = (points: number): { info: { points: number } } => ({ info: { points } });
    expect(correctivePoints([c(3094)])).toBe(3094);
    expect(correctivePoints([c(1), c(2), c(4)])).toBe(1 + 2);
    expect(MAX_CORRECTIONS_PLAYED).toBe(2);
  });
});

describe('a package with and without its corrections', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A four-file package of one splat, plus what a correction needs, served by name. */
  function serve(extra: Record<string, Uint8Array | string>, withDescriptorKey = false) {
    const ply = plyOf(1);
    const bindings = bindingsOf(1);
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const pack = new Uint8Array(16);
    const files: Record<string, Uint8Array | string> = {
      'character.ply': ply,
      'rig.glb': glb,
      'head.aosrig': pack,
      'bindings.bin': bindings,
      ...extra,
    };
    const descriptor = async (): Promise<string> => {
      const entry = async (name: string): Promise<[string, { src: string; sha256: string }]> => [
        name,
        { src: name, sha256: await sha(files[name] as Uint8Array) },
      ];
      const d: Record<string, unknown> = {
        format: 'aosrig-splat',
        version: 1,
        rig: 'aosrig_v0',
        renderer: 'webgpu',
        units: 'm',
        splatCount: 1,
        headVertexCount: 3,
        jointNames: JOINTS,
        plyToCharacter: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        bounds: { center: [0, 0, 0], radius: 1 },
        files: Object.fromEntries(
          await Promise.all(['character.ply', 'rig.glb', 'head.aosrig', 'bindings.bin'].map(entry)),
        ),
      };
      if (withDescriptorKey)
        d.corrective = {
          index: 'corrective/index.json',
          sha256: await sha(new TextEncoder().encode(files['corrective/index.json'] as string)),
        };
      return JSON.stringify(d);
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/pkg\//, '');
        if (path === 'character.json') return new Response(await descriptor());
        if (!Object.hasOwn(files, path))
          return new Response('<html>not here</html>', { status: 404 });
        return new Response(files[path] as BodyInit);
      }),
    );
  }

  const sha = async (bytes: Uint8Array): Promise<string> =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');

  /** A binary PLY of `n` splats with the character properties. */
  function plyOf(n: number): Uint8Array {
    const props = [
      'x',
      'y',
      'z',
      'f_dc_0',
      'f_dc_1',
      'f_dc_2',
      'opacity',
      'scale_0',
      'scale_1',
      'scale_2',
      'rot_0',
      'rot_1',
      'rot_2',
      'rot_3',
    ];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${String(n)}\n${props
      .map((p) => `property float ${p}`)
      .join('\n')}\nend_header\n`;
    const body = new Float32Array(n * props.length);
    for (let i = 0; i < n; i++) {
      body[i * props.length + 6] = 2; // opacity logit
      body[i * props.length + 10] = 1; // rot w
    }
    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(head.length + body.byteLength);
    out.set(head);
    out.set(new Uint8Array(body.buffer), head.length);
    return out;
  }

  /** `AOSBND01` for `n` splats skinned to joint 0, not face-bound. */
  function bindingsOf(n: number): Uint8Array {
    const out = new Uint8Array(32 + n * 112);
    out.set(new TextEncoder().encode('AOSBND01'));
    const v = new DataView(out.buffer);
    v.setUint32(8, 1, true);
    v.setUint32(12, n, true);
    v.setUint32(16, 112, true);
    v.setUint32(20, 3, true);
    v.setUint32(24, JOINTS.length, true);
    const f = new Float32Array(out.buffer, 32, n * 28);
    for (let i = 0; i < n; i++) {
      f[i * 28 + 4] = 1;
      // the rest frame's inverse rows: identity, so the frame is not singular
      f[i * 28 + 12] = 1;
      f[i * 28 + 17] = 1;
      f[i * 28 + 22] = 1;
    }
    return out;
  }

  const correctionFiles = (): Record<string, Uint8Array | string> => ({
    'corrective/index.json': JSON.stringify(
      index((v) => {
        const c = (v.corrections as Record<string, unknown>[])[0];
        c.splatCount = 1;
        c.points = 2;
      }),
    ),
    'corrective/arms_up_90/fade.bin': halves([0.5]),
    'corrective/arms_up_90/side.bin': Uint8Array.from([1]),
    'corrective/arms_up_90/points.ply': plyOf(2),
    'corrective/arms_up_90/points_bindings.bin': bindingsOf(2),
    'corrective/arms_up_90/points_side.bin': Uint8Array.from([0, 1]),
  });

  it('loads a package without them exactly as before', async () => {
    serve({});
    const bundle = await loadAosrigSplatBundle('http://test/pkg/character.json');
    expect(bundle.corrective).toBeUndefined();
    expect(bundle.files.size).toBe(4);
  });

  it('carries the corrections found beside character.json', async () => {
    const warn = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    serve(correctionFiles());
    const bundle = await loadAosrigSplatBundle('http://test/pkg/character.json');
    expect(bundle.corrective?.length).toBe(1);
    expect(bundle.corrective?.[0].info.name).toBe('arms_up_90');
    expect(bundle.corrective?.[0].fade.length).toBe(2);
    expect(bundle.corrective?.[0].pointsSide.length).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks the index against the hash character.json gives, and says so when it fails', async () => {
    const warn = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    serve(correctionFiles(), true);
    const good = await loadAosrigSplatBundle('http://test/pkg/character.json');
    expect(good.corrective?.length).toBe(1);
    expect(good.descriptor.corrective?.index).toBe('corrective/index.json');
    expect(warn).not.toHaveBeenCalled();
    // the same descriptor, a changed side file: the sizes check catches it
    const files = correctionFiles();
    files['corrective/arms_up_90/side.bin'] = Uint8Array.from([1, 1]);
    serve(files, true);
    const bad = await loadAosrigSplatBundle('http://test/pkg/character.json');
    expect(bad.corrective).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [said, reason] = warn.mock.calls[0] as [string, Error];
    expect(said).toContain('not used');
    expect(reason.message).toContain('size');
  });

  it('fetches nothing of a part the host does not want', async () => {
    serve(correctionFiles());
    const fetched = (): string[] =>
      (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) =>
        new URL(u).pathname.replace(/^\/pkg\//, ''),
      );
    const noCorrective = await loadAosrigSplatBundle('http://test/pkg/character.json', undefined, {
      corrective: false,
    });
    expect(noCorrective.corrective).toBeUndefined();
    expect(fetched().some((u) => u.startsWith('corrective/'))).toBe(false);
    expect(fetched()).toContain('teeth.json');
    serve(correctionFiles());
    const noMouth = await loadAosrigSplatBundle('http://test/pkg/character.json', undefined, {
      mouth: false,
    });
    expect(noMouth.corrective?.length).toBe(1);
    expect(fetched()).not.toContain('teeth.json');
    expect(fetched()).not.toContain('mouth_hidden.bin');
  });

  it('refuses a descriptor whose corrective entry is not a plain path', () => {
    const d = {
      format: 'aosrig-splat',
      version: 1,
      rig: 'aosrig_v0',
      renderer: 'webgpu',
      units: 'm',
      splatCount: 1,
      headVertexCount: 3,
      jointNames: JOINTS,
      plyToCharacter: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      bounds: { center: [0, 0, 0], radius: 1 },
      files: Object.fromEntries(
        ['character.ply', 'rig.glb', 'head.aosrig', 'bindings.bin'].map((n) => [
          n,
          { src: n, sha256: 'a'.repeat(64) },
        ]),
      ),
    };
    expect(parseDescriptor({ ...d, corrective: { index: 'corrective/index.json' } })).toBeTruthy();
    expect(() => parseDescriptor({ ...d, corrective: { index: '../index.json' } })).toThrow(
      /corrective/,
    );
    expect(() =>
      parseDescriptor({ ...d, corrective: { index: 'x/i.json', sha256: 'zz' } }),
    ).toThrow(/corrective/);
  });
});
