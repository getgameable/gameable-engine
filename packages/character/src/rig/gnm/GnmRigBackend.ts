// Google's parametric head (GNM) as a `RigBackend`.
//
// The rig -> vertices stage is a LINEAR MODEL plus skinning, so it runs as two
// small WGSL dispatches rather than as inference: per vertex,
// `v = neutral + Σ_c expr[c]·B[c][v]`, then the gaze rotation about each eye joint,
// then the baked neck seam, then LBS — all in `wgsl/gnm_blend.wgsl`, which shares
// its skinning half with ORL through `wgsl/lbs_common.wgsl`.
//
// THE CONTROL SPACE IS `head_ext`: 387 floats, 383 expression (left_eye 100,
// right_eye 100, lower_face 150, tongue 32, pupils 1) followed by gaze
// `[pitch_L, yaw_L, pitch_R, yaw_R]` in radians. There is NO JAW and no neck: neck
// and head rotation live in the body joints `neck_01`/`neck_02`/`head`, which reach
// this backend through `setJointWorlds` rather than through the control vector.
//
// UNITS ARE METRES, which differs from ORL's centimetres. Nothing here converts:
// the bundle's `world_scale` is the one conversion and it happens once, in the
// lift's placement uniform. A backend that "helpfully" scaled would apply it twice.
//
// GATE: `test/gnm.test.ts` holds `gnmReference.ts` — which reads the same pack this
// does — to `tools/gnm_reference.py` at 1e-3 cm, and measures the fp16 basis
// quantisation error separately so a regression in one is not mistaken for the
// other.

import { gnmBlendWgsl } from '../../generated/index.js';
import type { JointOverride, RigBackend, RigBackendInit, VertsAABB } from '../RigBackend.js';
import { aabbOf, invertAffine, packSkinRows } from '../skinMath.js';
import { headExtNames, parseAosRig, unpackHeadExt, type AosRigPack } from './gnmPack.js';
import { gazeToEyeRotationsInto, gnmPose, skinMatrices } from './gnmReference.js';

/** Options for `GnmRigBackend`. */
export interface GnmRigBackendOptions {
  /** Bundle-relative name of the `.aosrig` pack. From `scene.json`'s `rig.pack`. */
  packFile?: string;
  log?: (message: string) => void;
}

/** Default pack name when a manifest declares none. */
export const GNM_PACK_FILE = 'gnm_head.aosrig';

/** The blend pipeline and everything it binds. Built and destroyed as one. */
interface GnmPipeline {
  readonly pipeline: GPUComputePipeline;
  readonly bindGroup: GPUBindGroup;
  readonly out: GPUBuffer;
  readonly skinRows: GPUBuffer;
  readonly expr: GPUBuffer;
  readonly params: GPUBuffer;
}

/** GNM as a `RigBackend`. */
export class GnmRigBackend implements RigBackend {
  readonly kind = 'gnm' as const;
  private readonly packFile: string;
  private readonly log: (message: string) => void;

  private pack: AosRigPack | null = null;
  private device: GPUDevice | null = null;
  // ONE nullable field for the whole pipeline, not seven: they are created together in
  // `buildPipeline` and destroyed together in `dispose`, so a caller that has checked
  // one has checked all of them.
  private gpu: GnmPipeline | null = null;
  private buffers: GPUBuffer[] = [];

  private headExt = new Float32Array(0);
  private exprPadded = new Float32Array(0);
  private jointWorld: Float32Array = new Float32Array(0);
  private skinRows = new Float32Array(0);
  private paramsBuffer = new ArrayBuffer(80);
  // The two views over `paramsBuffer`, built once. `encode` used to construct both on
  // every rig change, which is two allocations per frame per character for a
  // reinterpretation of eighty bytes that never move.
  private paramsU32 = new Uint32Array(this.paramsBuffer);
  private paramsF32 = new Float32Array(this.paramsBuffer);
  private _controlNames: string[] = [];
  private _aabb: VertsAABB = { min: [0, 0, 0], max: [0, 0, 0] };

  // Two dirty flags, not one. The expression half moves every time the face does and
  // the skin rows only when the body's neck joints do, so raising one for the other
  // uploaded 42 KB of unchanged joint matrices on every talking frame.
  private exprDirty = true;
  private skinRowsDirty = true;

  // Built in `init()`, not per call: rebuilding a Map from `header.joints` inside
  // `setJointOverrides` allocated one Map, J strings' worth of hashing and two
  // `Float32Array(J*16)` on every single frame the head aim moved.
  private jointIndex = new Map<string, number>();
  private jointLocal = new Float32Array(0);
  private jointWorldScratch = new Float32Array(0);
  private skinScratch = new Float32Array(0);
  private headExtSplit: { expr: Float32Array; gaze: Float32Array } = {
    expr: new Float32Array(0),
    gaze: new Float32Array(0),
  };

  // What `setJointOverrides` last pushed: the rotation per joint plus which joints
  // were named at all, so a joint DROPPED from the list counts as a change too.
  private lastOverrideRot = new Float32Array(0);
  private lastOverrideMask = new Uint8Array(0);
  private overrideMask = new Uint8Array(0);
  private overridesPushed = false;

  constructor(options: GnmRigBackendOptions = {}) {
    this.packFile = options.packFile ?? GNM_PACK_FILE;
    this.log =
      options.log ??
      ((message: string) => {
        console.log(message);
      });
  }

  get controlNames(): readonly string[] {
    return this._controlNames;
  }

  get vertexCount(): number {
    return this.pack?.vertexCount ?? 0;
  }

  get vertsAABB(): VertsAABB {
    return this._aabb;
  }

  get vertsBuffer(): GPUBuffer {
    if (!this.gpu) throw new Error('GnmRigBackend: init() has not run');
    return this.gpu.out;
  }

  /**
   * The parsed pack — the topology and UVs a caller may want for a preview mesh.
   *
   * @returns The pack parsed by `init`.
   */
  get assets(): AosRigPack {
    if (!this.pack) throw new Error('GnmRigBackend: init() has not run');
    return this.pack;
  }

  async init(options: RigBackendInit): Promise<void> {
    await this.initWithoutDevice(options);
    const pack = this.assets;
    this.device = options.device;
    this.gpu = this.buildPipeline(pack, options.device);
    this.refreshSkinRows(pack);
    this.log(
      `[character] gnm: ${String(pack.vertexCount)} verts, ${String(pack.coeffCount)} expression coefficients, ` +
        `${String(pack.header.joints.length)} joints (${pack.header.joints.map((j) => j.name).join(', ')})`,
    );
  }

  /**
   * Parse the pack and set up everything the CPU side needs, without building the WGSL
   * pipeline: for a head pass built elsewhere (the TSL node, `gnmNode.ts`), which reads
   * {@link frameValues} each frame. `encode` and `vertsBuffer` stay unavailable.
   *
   * @param options As `init`, without the device.
   * @returns Nothing.
   */
  async initWithoutDevice(options: Omit<RigBackendInit, 'device'>): Promise<void> {
    const bytes = options.getBytes(this.packFile) ?? (await options.fetchBytes?.(this.packFile));
    if (!bytes) {
      throw new Error(
        `[character] gnm: '${this.packFile}' is not in this bundle — bake it with tools/gnm_pack.py`,
      );
    }
    const pack = parseAosRig(bytes);
    this.pack = pack;

    if (options.expectVerts && pack.vertexCount !== options.expectVerts) {
      throw new Error(
        `[character] gnm: pack has ${String(pack.vertexCount)} vertices, the branch mesh has ${String(options.expectVerts)}` +
          ' — the decoders were trained on a different topology',
      );
    }
    // The control names are the LAYOUT's, not the bundle's: `head_ext` is GNM's own
    // parameter block and a bundle cannot rename or reorder it. `controlNames` on
    // `RigBackendInit` is the ORL path's; here it is only checked for width, and a
    // mismatch is reported rather than thrown because an ARKit-driven bundle
    // legitimately supplies a narrower vector that the expression mapper widens.
    this._controlNames = headExtNames(pack.header.headExt);
    if (options.controlNames.length && options.controlNames.length !== pack.header.headExt.dim) {
      this.log(
        `[character] gnm: the bundle declares ${String(options.controlNames.length)} controls but head_ext is ` +
          `${String(pack.header.headExt.dim)} — the expression mapper must widen before setControls`,
      );
    }

    this.headExt = new Float32Array(pack.header.headExt.dim);
    // The uniform is vec4-packed, so the expression half rounds up to whole vec4s.
    this.exprPadded = new Float32Array(Math.ceil(pack.coeffCount / 4) * 4);
    this.jointWorld = Float32Array.from(pack.restWorld);
    const J = pack.header.joints.length;
    this.skinRows = new Float32Array(J * 12);
    // Everything the per-frame paths write into, allocated once.
    this.jointIndex = new Map(pack.header.joints.map((j, i) => [j.name, i]));
    this.jointLocal = new Float32Array(J * 16);
    this.jointWorldScratch = new Float32Array(J * 16);
    this.skinScratch = new Float32Array(J * 16);
    this.lastOverrideRot = new Float32Array(J * 4);
    this.lastOverrideMask = new Uint8Array(J);
    this.overrideMask = new Uint8Array(J);
    this.overridesPushed = false;
    this.headExtSplit = {
      expr: new Float32Array(pack.header.headExt.exprDim),
      gaze: new Float32Array(pack.header.headExt.gazeDim),
    };
    // THE BOUNDS MUST DESCRIBE `vertsBuffer`, NOT THE MODEL. The pack keeps the neutral
    // HEAD-LOCAL (so the expression basis and the gaze rotation stay in the frame they are
    // defined in) but the shader emits vertices in the body's BIND space, because
    // `bindTransform` is folded into the skin matrices. At rest the skinning is
    // `world · inverse(rest) · bindTransform` = `bindTransform`, so that one matrix is the
    // whole difference — and on the shipped head it is a metre of it, since head-local is
    // centred on the head and bind space is centred on the character's feet. Reporting the
    // head-local bounds put every caller's bounding sphere a metre below the gaussians,
    // where the sort's depth bins do not reach them.
    this._aabb = aabbOf(restNeutral(pack));
    this.refreshSkinRows(pack);
  }

  /**
   * This frame's values for the blend, as `encode` would upload them: the expression
   * coefficients (unscaled, padded to whole vec4s), the params block (eye positions at
   * floats 4..6 and 8..10, the two gaze quaternions at 12..19) and the skin rows (three
   * row-major vec4 per joint). The arrays are this backend's own; do not keep them.
   *
   * @returns Views over the backend's arrays.
   */
  frameValues(): { expr: Float32Array; params: Float32Array; skinRows: Float32Array } {
    const pack = this.pack;
    if (!pack) throw new Error('GnmRigBackend: init() has not run');
    this.fillFrame(pack);
    return { expr: this.exprPadded, params: this.paramsF32, skinRows: this.skinRows };
  }

  /**
   * Write the expression and params arrays from the current `head_ext`.
   *
   * @param pack The parsed pack.
   * @returns Nothing.
   */
  private fillFrame(pack: AosRigPack): void {
    const { expr, gaze } = unpackHeadExt(this.headExt, pack.header.headExt, this.headExtSplit);
    this.exprPadded.fill(0);
    this.exprPadded.set(expr);
    const u = this.paramsU32;
    const f = this.paramsF32;
    u[0] = pack.vertexCount;
    u[1] = pack.coeffCount;
    u[2] = pack.maxInfluence;
    u[3] = pack.stitchLocal ? 1 : 0;
    f[4] = pack.eyePositions[0];
    f[5] = pack.eyePositions[1];
    f[6] = pack.eyePositions[2];
    f[8] = pack.eyePositions[3];
    f[9] = pack.eyePositions[4];
    f[10] = pack.eyePositions[5];
    const q = gazeToEyeRotationsInto(gaze, gazeRotations);
    for (let k = 0; k < 8; k++) f[12 + k] = q[k];
  }

  private buildPipeline(pack: AosRigPack, device: GPUDevice): GnmPipeline {
    const J = pack.header.joints.length;
    const code = gnmBlendWgsl
      .replace(/SKIN_ROWS/g, String(J * 3))
      .replace(/EXPR_VEC4/g, String(Math.ceil(pack.coeffCount / 4)))
      .replace(/MAX_COEFF/g, String(pack.coeffCount));
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code, label: 'gnm_blend' }),
        entryPoint: 'main',
      },
    });

    const storage = (data: ArrayBufferView, label: string): GPUBuffer => {
      const buf = device.createBuffer({
        label,
        size: Math.max(4, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
      this.buffers.push(buf);
      return buf;
    };

    const bufNeutral = storage(pack.neutral, 'gnm_neutral');
    const bufBasis = storage(pack.basis, 'gnm_basis');
    const bufBasisScale = storage(pack.basisScale, 'gnm_basis_scale');
    const bufEyeWeight = storage(pack.eyeWeights, 'gnm_eye_weight');
    // A bind group must be complete even when the bake carried no seam, so the
    // stitch binding falls back to a 3-float dummy the shader never reads.
    const bufStitch = storage(pack.stitchLocal ?? new Float32Array(3), 'gnm_stitch');
    // WGSL storage has no u16.
    const bufSkinIdx = storage(Uint32Array.from(pack.skinIndex), 'gnm_skin_idx');
    const bufSkinW = storage(pack.skinWeight, 'gnm_skin_w');

    const out = device.createBuffer({
      label: 'gnm_out_verts',
      size: pack.vertexCount * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.buffers.push(out);

    const uniform = (size: number, label: string): GPUBuffer => {
      const buf = device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.buffers.push(buf);
      return buf;
    };
    const skinRows = uniform(J * 12 * 4, 'gnm_skin_rows');
    const expr = uniform(this.exprPadded.byteLength, 'gnm_expr');
    const params = uniform(80, 'gnm_params');

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bufNeutral } },
        { binding: 1, resource: { buffer: bufBasis } },
        { binding: 2, resource: { buffer: bufBasisScale } },
        { binding: 3, resource: { buffer: bufEyeWeight } },
        { binding: 4, resource: { buffer: bufStitch } },
        { binding: 5, resource: { buffer: bufSkinIdx } },
        { binding: 6, resource: { buffer: bufSkinW } },
        { binding: 7, resource: { buffer: out } },
        { binding: 8, resource: { buffer: skinRows } },
        { binding: 9, resource: { buffer: expr } },
        { binding: 10, resource: { buffer: params } },
      ],
    });
    return { pipeline, bindGroup, out, skinRows, expr, params };
  }

  /**
   * Set the whole `head_ext` vector.
   *
   * A shorter vector is zero-padded, which is exactly what the reduced ML view
   * (68 floats) means — `block.expand` pads per region, so a caller holding the
   * reduced view must widen it first rather than passing it here.
   *
   * @param controls Up to `head_ext.dim` floats: the expression coefficients, then
   *   the four gaze angles in radians. A longer vector throws.
   */
  setControls(controls: Float32Array): void {
    if (!this.pack) throw new Error('GnmRigBackend: init() has not run');
    const dim = this.pack.header.headExt.dim;
    if (controls.length > dim) {
      throw new Error(
        `GnmRigBackend.setControls: got ${String(controls.length)} floats, head_ext is ${String(dim)}`,
      );
    }
    // Compared, not just written. An idle face pushes the same vector 60 times a
    // second and each push used to re-upload the expression uniform and the params
    // block; the compare is `dim` floats against a buffer already in cache.
    let changed = false;
    for (let i = 0; i < this.headExt.length; i++) {
      const next = i < controls.length ? controls[i] : 0;
      const previous = this.headExt[i];
      this.headExt[i] = next;
      if (this.headExt[i] !== previous) changed = true;
    }
    if (changed) this.exprDirty = true;
  }

  /**
   * Where the body rig's joints are this frame, `J*16` row-major world matrices in
   * the pack's own compact joint order.
   *
   * Defaults to the pack's rest, which makes the skinning the identity — a head
   * posed at bind. The animation layer supplies the real matrices; the head does
   * not solve them, because neck and head rotation are the BODY's joints.
   *
   * @param worlds `J*16` row-major world matrices, in METRES, in the pack's compact
   *   joint order. The skin rows are recomputed here, not per frame.
   */
  setJointWorlds(worlds: Float32Array): void {
    if (!this.pack) throw new Error('GnmRigBackend: init() has not run');
    const expected = this.pack.header.joints.length * 16;
    if (worlds.length !== expected) {
      throw new Error(
        `GnmRigBackend.setJointWorlds: got ${String(worlds.length)} floats, this pack has ` +
          `${String(this.pack.header.joints.length)} joints (${String(expected)})`,
      );
    }
    this.jointWorld.set(worlds);
    this.refreshSkinRows(this.pack);
  }

  /**
   * Per-joint rotation overrides, by name — the procedural head-aim path.
   *
   * Applied as a parent-relative rotation on top of the joint's rest, then
   * propagated down the pack's own parent chain, so aiming `head` carries the eyes
   * with it exactly as skinning would.
   *
   * @param overrides Joint name plus a `(w, x, y, z)` rotation. A name this pack
   *   does not carry is skipped silently — the body rig has joints the head does
   *   not. Each call rebuilds from the rest pose, so overrides do not accumulate.
   * @returns True when this call actually moved a joint. False on a repeat of the
   *   rotations already pushed, which is what an idle head sends 60 times a second —
   *   and on a repeat NOTHING is recomputed, so the caller may leave its own rig
   *   dirty flag down.
   */
  setJointOverrides(overrides: readonly JointOverride[]): boolean {
    if (!this.pack) throw new Error('GnmRigBackend: init() has not run');
    const pack = this.pack;
    const J = pack.header.joints.length;
    const mask = this.overrideMask;
    mask.fill(0);
    let changed = !this.overridesPushed;
    for (const override of overrides) {
      const j = this.jointIndex.get(override.joint);
      if (j === undefined) continue;
      mask[j] = 1;
      const o = j * 4;
      for (let k = 0; k < 4; k++) {
        const previous = this.lastOverrideRot[o + k];
        this.lastOverrideRot[o + k] = override.rotation[k];
        if (this.lastOverrideRot[o + k] !== previous) changed = true;
      }
    }
    // A joint that WAS overridden and no longer is has to fall back to its rest, so
    // the set of named joints is part of the comparison, not just their rotations.
    for (let j = 0; j < J && !changed; j++)
      if (mask[j] !== this.lastOverrideMask[j]) changed = true;
    if (!changed) return false;
    this.lastOverrideMask.set(mask);
    this.overridesPushed = true;

    // Local rest = parent⁻¹ · world; recompose with the override, then walk forward.
    const local = this.jointLocal;
    for (let j = 0; j < J; j++) {
      const parent = pack.jointParents[j];
      if (parent < 0) local.set(pack.restWorld.subarray(j * 16, j * 16 + 16), j * 16);
      else mulInverseInto(pack.restWorld, parent * 16, pack.restWorld, j * 16, local, j * 16);
    }
    for (let j = 0; j < J; j++) {
      if (mask[j] === 0) continue;
      applyRotation(local, j * 16, this.lastOverrideRot, j * 4);
    }
    const world = this.jointWorldScratch;
    for (let j = 0; j < J; j++) {
      const parent = pack.jointParents[j];
      if (parent < 0) world.set(local.subarray(j * 16, j * 16 + 16), j * 16);
      else mulInto(world, parent * 16, local, j * 16, world, j * 16);
    }
    this.setJointWorlds(world);
    return true;
  }

  private refreshSkinRows(pack: AosRigPack): void {
    // The CPU reference's own routine, so the two paths cannot compute it differently.
    const skin = skinMatrices(pack, this.jointWorld, this.skinScratch);
    // Only the rows that CHANGED make the uniform dirty: an aim that has converged
    // still calls this, and re-uploading identical bytes is a write per frame per
    // character for nothing.
    if (packSkinRows(skin, pack.header.joints.length, this.skinRows)) this.skinRowsDirty = true;
  }

  encode(encoder: GPUCommandEncoder): void {
    const gpu = this.gpu;
    const pack = this.pack;
    const device = this.device;
    if (!gpu || !pack || !device) throw new Error('GnmRigBackend: init() has not run');
    if (this.exprDirty) {
      this.fillFrame(pack);
      device.queue.writeBuffer(
        gpu.expr,
        0,
        this.exprPadded.buffer,
        this.exprPadded.byteOffset,
        this.exprPadded.byteLength,
      );
      device.queue.writeBuffer(gpu.params, 0, this.paramsBuffer);
      this.exprDirty = false;
    }
    if (this.skinRowsDirty) {
      device.queue.writeBuffer(
        gpu.skinRows,
        0,
        this.skinRows.buffer,
        this.skinRows.byteOffset,
        this.skinRows.byteLength,
      );
      this.skinRowsDirty = false;
    }

    const pass = encoder.beginComputePass({ label: 'gnm_blend' });
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, gpu.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pack.vertexCount / 64));
    pass.end();
  }

  /**
   * The CPU reference, for calibration. Never per frame — see `gnmReference.ts`.
   *
   * @param controls A `head_ext` vector; a short one is zero-padded and a long one
   *   truncated, since this runs off the calibration path rather than the hot one.
   * @returns The posed vertices as `(V,3)` in METRES, skinned against the joint
   *   worlds currently set.
   */
  runCpu(controls: Float32Array): Promise<Float32Array> {
    if (!this.pack) throw new Error('GnmRigBackend: init() has not run');
    const headExt = new Float32Array(this.pack.header.headExt.dim);
    headExt.set(controls.subarray(0, Math.min(controls.length, headExt.length)));
    return Promise.resolve(gnmPose(this.pack, headExt, this.jointWorld));
  }

  bytes(): number {
    return this.buffers.reduce((total, b) => total + b.size, 0) + (this.pack?.byteLength ?? 0);
  }

  dispose(): void {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.gpu = null;
    this.pack = null;
  }
}

/**
 * The neutral mesh where `vertsBuffer` will put it: seam applied, then `bindTransform`.
 *
 * @param pack The parsed pack.
 * @returns `(V,3)` vertices in the body's bind space, metres — a fresh array, built once
 *   at init and used only for the bounds.
 */
function restNeutral(pack: AosRigPack): Float32Array {
  const m = pack.bindTransform;
  const out = new Float32Array(pack.neutral.length);
  for (let i = 0; i < pack.neutral.length; i += 3) {
    const x = pack.neutral[i] + (pack.stitchLocal?.[i] ?? 0);
    const y = pack.neutral[i + 1] + (pack.stitchLocal?.[i + 1] ?? 0);
    const z = pack.neutral[i + 2] + (pack.stitchLocal?.[i + 2] ?? 0);
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return out;
}

// Module scratch for the joint maths below. `setJointOverrides` runs per frame on a
// character whose head is aiming, and every one of these used to be a fresh
// allocation inside the per-joint loop.
const invScratch = /* @__PURE__ */ new Float64Array(16);
const mulScratch = /* @__PURE__ */ new Float64Array(12);
const rotScratch = /* @__PURE__ */ new Float64Array(9);
const rot3Scratch = /* @__PURE__ */ new Float64Array(9);
const gazeRotations = /* @__PURE__ */ new Float64Array(8);

/**
 * `out = inverse(a) · b`, row-major 4x4 affine.
 *
 * @param a Matrices holding the left operand, flat.
 * @param ao Element index of the matrix to invert (`j * 16`).
 * @param b Matrices holding the right operand, flat.
 * @param bo Element index of the right operand.
 * @param out Destination matrices, flat. Written element by element, so it must not
 *   overlap `a` or `b`. The bottom row is set to `[0, 0, 0, 1]` rather than
 *   multiplied out.
 * @param oo Element index to write at.
 */
function mulInverseInto(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  out: Float32Array,
  oo: number,
): void {
  const inv = invScratch;
  invertAffine(a, ao, inv);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      out[oo + r * 4 + c] =
        inv[r * 4] * b[bo + c] +
        inv[r * 4 + 1] * b[bo + 4 + c] +
        inv[r * 4 + 2] * b[bo + 8 + c] +
        inv[r * 4 + 3] * (c === 3 ? 1 : 0);
    }
  }
  out[oo + 12] = 0;
  out[oo + 13] = 0;
  out[oo + 14] = 0;
  out[oo + 15] = 1;
}

/**
 * `out = a · b`, row-major 4x4 affine.
 *
 * @param a Matrices holding the left operand, flat.
 * @param ao Element index of the left operand (`j * 16`).
 * @param b Matrices holding the right operand, flat.
 * @param bo Element index of the right operand.
 * @param out Destination matrices, flat. The product is accumulated in a scratch
 *   first, so `out` may be the same array as `a` or `b` — which the forward walk
 *   relies on.
 * @param oo Element index to write at.
 */
function mulInto(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  out: Float32Array,
  oo: number,
): void {
  const t = mulScratch;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      t[r * 4 + c] =
        a[ao + r * 4] * b[bo + c] +
        a[ao + r * 4 + 1] * b[bo + 4 + c] +
        a[ao + r * 4 + 2] * b[bo + 8 + c] +
        a[ao + r * 4 + 3] * (c === 3 ? 1 : 0);
    }
  }
  for (let i = 0; i < 12; i++) out[oo + i] = t[i];
  out[oo + 12] = 0;
  out[oo + 13] = 0;
  out[oo + 14] = 0;
  out[oo + 15] = 1;
}

/**
 * Post-multiply the rotation part of a row-major 4x4 by a quaternion `(w,x,y,z)`.
 *
 * @param m Matrices, flat. Modified in place; the translation column is untouched,
 *   so the joint rotates about its own origin.
 * @param off Element index of the matrix to rotate (`j * 16`).
 * @param quats Flat `(w, x, y, z)` rotations, assumed unit length.
 * @param qo Element index of this joint's rotation (`j * 4`).
 */
function applyRotation(m: Float32Array, off: number, quats: ArrayLike<number>, qo: number): void {
  const w = quats[qo];
  const x = quats[qo + 1];
  const y = quats[qo + 2];
  const z = quats[qo + 3];
  const r = rotScratch;
  r[0] = 1 - 2 * (y * y + z * z);
  r[1] = 2 * (x * y - z * w);
  r[2] = 2 * (x * z + y * w);
  r[3] = 2 * (x * y + z * w);
  r[4] = 1 - 2 * (x * x + z * z);
  r[5] = 2 * (y * z - x * w);
  r[6] = 2 * (x * z - y * w);
  r[7] = 2 * (y * z + x * w);
  r[8] = 1 - 2 * (x * x + y * y);
  const t = rot3Scratch;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      t[i * 3 + j] =
        m[off + i * 4] * r[j] + m[off + i * 4 + 1] * r[3 + j] + m[off + i * 4 + 2] * r[6 + j];
    }
  }
  for (let i = 0; i < 3; i++) {
    m[off + i * 4] = t[i * 3];
    m[off + i * 4 + 1] = t[i * 3 + 1];
    m[off + i * 4 + 2] = t[i * 3 + 2];
  }
}
