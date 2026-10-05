// One live branch: rig -> verts -> decoders -> lift -> the sink's slots.
//
// Replaces aos-threejs-poc/src/ogs/graph/nodes/OGSBranch.ts @ cdd63b10. That file was
// two things at once — a node-graph grouping node with declared ports, and the live
// container that actually owned a branch's runtime. Only the second survives: a game
// engine has no blueprint editor to rewire ports for, and every bundle ran the same
// chain anyway.
//
// WHAT IT OWNS: a `RigBackend` (or none), the trunk/geom/appr chain, its own plücker
// at its own `uv_res`, and its own `GpuLifter` writing into its own slot range. One
// plücker PER BRANCH, not one shared: a shared instance destroys and rebuilds its
// buffer whenever the dims change, and a head (750²) and a teeth branch (256²)
// alternate every frame.
//
// THE ONE DELIBERATE READBACK is `calibrate()`, at load: the rig -> bundle similarity
// and the per-vertex `corr` are fitted from a CPU deform, and afterwards the
// correction lives in the lift's transform pass and the vertices never touch the CPU
// again.

import type { BranchAssets } from './assets/loadMultiRegionScene.js';
import { BranchDecoders, type DecoderSource } from './decoder/branchDecoders.js';
import type { DecoderKind, OrtEnvLike } from './decoder/decoderBuild.js';
import type { OrtLike } from './decoder/DecoderSession.js';
import type { OrtLike as OrtSessionLike } from './decoder/ortSession.js';
import { liftInputToNodeTensor, nodeTensorToLiftInput, type NodeTensor } from './decoder/types.js';
import { calibrate, type Calibration } from './inference/calibrate.js';
import { GpuLifter, type LiftPlacement } from './inference/GpuLifter.js';
import { GpuPlucker } from './inference/GpuPlucker.js';
import type { PluckerCamera, PluckerFrame } from './inference/plucker.js';
import { composeSimilarity } from './inference/poseAnchors.js';
import type { JointOverride, RigBackend } from './rig/RigBackend.js';
import type { SlotRange, SplatSink } from './splatSink.js';

/** Everything a branch needs to come alive. */
export interface CharacterBranchOptions {
  assets: BranchAssets;
  device: GPUDevice;
  sink: SplatSink;
  range: SlotRange;
  placement: LiftPlacement;
  /** The camera frame this branch's plücker travels. */
  pluckerFrame: PluckerFrame;
  ort: OrtEnvLike & OrtLike & OrtSessionLike;
  providers: string[];
  /** True when ORT is on the renderer's device and outputs may stay on gpu-buffers. */
  gpuBufferIo: boolean;
  preferFp16: boolean;
  trunkBytes?: Uint8Array;
  geom: DecoderSource;
  appr: DecoderSource;
  /** The rig that poses this branch, or null to render at its neutral mesh. */
  rig: RigBackend | null;
  onDowngrade?: (kind: DecoderKind | 'lift', reason: string) => void;
  log?: (message: string) => void;
}

/** One branch of a live character. */
export class CharacterBranch {
  readonly name: string;
  readonly range: SlotRange;
  private readonly assets: BranchAssets;
  private readonly device: GPUDevice;
  private readonly pluckerFrame: PluckerFrame;
  private readonly log: (message: string) => void;

  private readonly decoders: BranchDecoders;
  private readonly lifter: GpuLifter;
  private plucker: GpuPlucker | null = null;
  /** The rays `encodePlucker` recorded, consumed by the next `runAppearance`. */
  private pluckerTensor: NodeTensor | null = null;
  private rigBackend: RigBackend | null;

  /**
   * Pose vertices the lift is anchored to. Own buffer — the mesh's `neutralVertices`
   * must never be mutated. On the gpu-resident path the verts never come back to the
   * CPU, so this stays at the neutral and only the lifter's device buffer moves.
   */
  private readonly verts: Float32Array;

  // The rig -> checkpoint anchoring, folded into the lifter's ONE vert-transform pass:
  // `v' = v·M + offset + (corr ? corr[i] : 0)`. `anchorLin` is ROW-major, applied as
  // `v·M`, and stays identity until `calibrate()` has run.
  private anchorLin = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private anchorOffset = new Float32Array(3);
  // What `calibrate()` fitted, kept UNMODIFIED. The pair above is the LIVE one and
  // moves with a baked per-pose delta, so every delta must compose onto the row-0 fit
  // rather than onto last frame's result — otherwise the deltas accumulate and the
  // head walks away.
  private baseAnchorLin = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private baseAnchorOffset = new Float32Array(3);
  private anchored = false;

  /** Why calibration refused this branch's rig, or null. */
  calibrationError: string | null = null;
  private disposed = false;

  constructor(options: CharacterBranchOptions) {
    this.name = options.assets.name;
    this.assets = options.assets;
    this.device = options.device;
    this.range = options.range;
    this.pluckerFrame = options.pluckerFrame;
    this.log =
      options.log ??
      ((message: string) => {
        console.log(message);
      });
    this.rigBackend = options.rig;
    this.verts = new Float32Array(options.assets.mesh.neutralVertices);

    const spec = options.assets.spec;
    this.lifter = new GpuLifter(
      options.device,
      options.assets.mesh,
      options.sink.buffers,
      options.range,
      options.placement,
      {
        // All six live OUTSIDE the ONNX: the trainer biases, bounds and clamps the
        // geom decoder's log-scale AFTER the decoder, so the lift has to. Absent means
        // the pre-v5 behaviour, which is byte-identical for an older bundle.
        scaleLogBias: spec.scaleLogBias,
        scaleLogMax: spec.scaleLogMax,
        triKappa: spec.triKappa,
        sliverQMin: spec.sliverQMin,
        uvErode: spec.uvErode,
        sigmaMax: spec.sigmaMax,
        sigmaOffset: spec.sigmaOffset,
      },
    );

    this.decoders = new BranchDecoders({
      ort: options.ort,
      providers: options.providers,
      label: this.name,
      gpuBufferIo: options.gpuBufferIo,
      preferFp16: options.preferFp16,
      trunk: options.trunkBytes ? { bytes: options.trunkBytes } : undefined,
      geom: options.geom,
      appr: options.appr,
      onDowngrade: options.onDowngrade,
    });
  }

  /** Build the decoder sessions and the plücker. */
  async init(): Promise<void> {
    await this.decoders.init();
    // The plücker's ORT tensor must live where appr reads it, which is the renderer's
    // device once `attachOrtDevice` has run.
    this.plucker = new GpuPlucker(this.device);
    // A branch without a rig never poses, so its jacobians are computed once.
    this.lifter.computeJacobians(this.verts);
  }

  /**
   * The branch's UV resolution; its splat count is the square.
   *
   * @returns The side length of the square UV maps the decoders emit, so the branch
   * occupies `uvRes * uvRes` slots in the sink.
   */
  get uvRes(): number {
    return this.assets.uvRes;
  }

  /**
   * The control width this branch's decoders take.
   *
   * @returns How many rig controls the trunk expects; `setControls` and `runGeom`
   * trim or zero-pad to exactly this width.
   */
  get rigDim(): number {
    return this.assets.rigDim;
  }

  /**
   * The branch's baked neutral vertices, in the bundle's own space.
   *
   * @returns The live `mesh.bin` view, flat `xyz` per vertex, in the trained frame
   * and the bundle's own units — not the working copy the rig poses.
   */
  get neutralVertices(): Float32Array {
    return this.assets.mesh.neutralVertices;
  }

  /**
   * True when a rig backend poses this branch.
   *
   * @returns False for a branch that never had one and for one whose backend was
   * dropped by a failed calibration; either way it renders at its neutral.
   */
  get hasRig(): boolean {
    return this.rigBackend !== null;
  }

  /**
   * Which rig actually posed this branch, for the one-line ready log.
   *
   * @returns The backend's kind — `orl` or `gnm` — or `'none'` when the branch is
   * not rig-driven.
   */
  get rigKind(): string {
    return this.rigBackend?.kind ?? 'none';
  }

  /**
   * Whether the decoders resolved to fp16.
   *
   * @returns `'fp16'` or `'fp32'` per decoder, reporting what the sessions were
   * actually built from rather than what the bundle offered.
   */
  get precision(): { geom: string; appr: string } {
    return {
      geom: this.decoders.geomUsedFp16 ? 'fp16' : 'fp32',
      appr: this.decoders.apprUsedFp16 ? 'fp16' : 'fp32',
    };
  }

  /**
   * The rig to decode a neutral at: the branch's reference rig (row 0 of its rig
   * params) when the bundle ships one, else zeros.
   *
   * An all-zero vector is NOT a rest pose in general. A control space declaring
   * `rig_range [0,1]` rests nowhere near zero, and a myra-style space is a unit
   * quaternion per bone — zeroing it hands the trunk a vector tens of units from
   * anything it trained on, and the code latent comes out far wider than the decoder
   * ever saw: a recognisable face smeared by oversized splats.
   *
   * @returns A fresh copy of the reference rig — `rigDim` controls, safe for the
   * caller to keep — or a `rigDim`-wide zero vector when the bundle ships none.
   */
  neutralRig(): Float32Array {
    const reference = this.assets.referenceRig;
    return reference ? new Float32Array(reference) : new Float32Array(this.rigDim);
  }

  /**
   * This branch's fitted rig -> bundle frame, once calibration has run.
   *
   * @returns The BASE fit — a row-major 3x3 `lin` and a 3-vector `offset`, applied as
   * `v·lin + offset` to take rig output into bundle space, before any per-pose delta —
   * or null while the branch is uncalibrated or its fit was refused.
   */
  get rigSpace(): { lin: Float32Array; offset: Float32Array } | null {
    // The BASE fit, deliberately. A borrowing branch places its shells in rig space
    // ONCE, and the frame that placement is defined against is the row-0 one; handing
    // it whatever pose delta happened to be installed would bake a single arbitrary
    // pose's correction into the shells permanently.
    return this.anchored ? { lin: this.baseAnchorLin, offset: this.baseAnchorOffset } : null;
  }

  /**
   * One-time per-vertex anchor. Returns false when the branch will NOT be posed — no
   * rig, a vertex-count mismatch, or a fit whose residual says this rig is not this
   * mesh's. In the last case `calibrationError` carries the reason.
   *
   * `borrowedFrame` marks a branch that was HANDED a sibling's frame rather than
   * fitting its own: its mesh is a decimated stand-in with no correspondence to the
   * pack, so its residual measures how well the head's frame happens to place a
   * different mesh — expected to be worse, and saying nothing about whether the DNA is
   * this character's. Judging it there froze eyes and teeth that bind and drive
   * correctly, while the head worked.
   *
   * @param baseRig The control vector to fit at — the rest pose the branch's
   * `neutral_vertices` were exported at, so rig output and mesh describe one shape.
   * @param borrowedFrame True when this branch was handed a sibling's frame rather
   * than fitting its own, which exempts it from the residual verdict.
   * @returns True when the branch is now anchored and will be posed; false when it
   * has no rig, the vertex counts disagree, or the fit was refused — in which case
   * the backend has been dropped and `calibrationError` carries the reason.
   */
  async calibrate(baseRig: Float32Array, borrowedFrame = false): Promise<boolean> {
    const rig = this.rigBackend;
    if (!rig) return false;
    const pred = await rig.runCpu(baseRig);
    const neutral = this.neutralVertices;
    if (pred.length !== neutral.length) {
      this.log(
        `[character] branch '${this.name}': rig produced ${String(pred.length / 3)} vertices, the mesh has ` +
          `${String(neutral.length / 3)} — live pose disabled`,
      );
      this.dropRig();
      return false;
    }

    let fit: Calibration;
    try {
      fit = calibrate(pred, neutral);
    } catch (e) {
      // The reflection refusal has to land in the SAME place as the residual verdict
      // below — it is the same verdict, reached earlier — or a mirrored mesh takes the
      // whole character down instead of freezing one branch.
      this.calibrationError = `${(e as Error).message} — wrong rig for this character, or a vertex-order mismatch`;
      console.error(`[character] branch '${this.name}': ${this.calibrationError}`);
      this.dropRig();
      return false;
    }

    if (!borrowedFrame && fit.tolerance > 0 && fit.residual > fit.tolerance) {
      // Units are the BUNDLE's, which is not always centimetres, so the numbers are
      // reported bare against a tolerance derived from the same mesh rather than
      // labelled with a unit that would be wrong half the time.
      this.calibrationError =
        `the rig does not fit this bundle's mesh (residual ${fit.residual.toExponential(2)} vs tolerance ` +
        `${fit.tolerance.toExponential(2)}, bundle units, after scale+rotation+translation) — wrong rig ` +
        'for this character, or a vertex-order mismatch';
      console.error(`[character] branch '${this.name}': ${this.calibrationError}`);
      this.dropRig();
      return false;
    }
    if (borrowedFrame && fit.tolerance > 0 && fit.residual > fit.tolerance) {
      this.log(
        `[character] branch '${this.name}': borrowed rig space places it ` +
          `${(fit.residual / fit.tolerance).toFixed(1)}x past the head's own tolerance — shells still driven`,
      );
    }

    this.anchorLin.set(fit.lin);
    this.anchorOffset.set(fit.offset);
    this.baseAnchorLin.set(fit.lin);
    this.baseAnchorOffset.set(fit.offset);
    this.anchored = true;
    this.lifter.setDeformLinear(fit.lin, fit.offset);
    this.lifter.setVertCorrection(fit.corr);
    return true;
  }

  /**
   * Re-place this branch by a baked per-pose delta, in BUNDLE space.
   *
   * `delta` is ONE transform for the whole bundle: what varies pose to pose is the
   * training export's `GlobalRigid(t)`, a single rigid fit of the entire baked mesh,
   * so every branch takes the SAME delta on top of its own row-0 anchor and their
   * relative placement is preserved exactly.
   *
   * Cheap enough for the per-frame path: a 3x3 compose plus a uniform write. It
   * touches neither `corr` (not pose-dependent — it is the rig-vs-wrap shape gap) nor
   * the jacobians, so nothing is re-uploaded. A no-op before calibration and on a
   * branch whose fit was refused: this only re-places a fit that already passed.
   *
   * @param dLin The delta's rotation and scale as nine values, row-major 3x3, applied
   * to a row vector as `v·M + o`.
   * @param dOff The delta's translation, three values in bundle units.
   * @returns True when the delta was composed onto the base anchor and pushed to the
   * lifter; false on an uncalibrated or rigless branch, where it is a no-op.
   */
  setPoseAnchorDelta(dLin: ArrayLike<number>, dOff: ArrayLike<number>): boolean {
    if (!this.anchored || !this.rigBackend) return false;
    composeSimilarity(
      this.baseAnchorLin,
      this.baseAnchorOffset,
      dLin,
      dOff,
      this.anchorLin,
      this.anchorOffset,
    );
    this.lifter.setDeformLinear(this.anchorLin, this.anchorOffset);
    return true;
  }

  /**
   * Hand the rig its new control vector. CPU-only; `encodePose` does the GPU half.
   *
   * @param rig The controls, in the backend's own control-name order; trimmed or
   * zero-padded to the backend's width. A no-op on a branch with no rig.
   */
  setControls(rig: Float32Array): void {
    if (!this.rigBackend) return;
    this.rigBackend.setControls(trim(rig, this.rigBackend.controlNames.length));
  }

  /**
   * Per-joint rotation overrides, for a backend that has an addressable skeleton.
   *
   * @param overrides The joints to drive directly, layered on top of the controls.
   * Silently ignored by a backend with no addressable skeleton, and by a branch with
   * no rig at all.
   * @returns True when the backend reports that something actually moved. False for
   * a branch with no rig, a backend with no addressable joints, and a repeat of the
   * rotations already pushed — so the caller can leave its rig dirty flag down and
   * skip a whole decode.
   */
  setJointOverrides(overrides: readonly JointOverride[]): boolean {
    return this.rigBackend?.setJointOverrides?.(overrides) ?? false;
  }

  /**
   * Hand this branch a sibling's fitted frame, for a rig that cannot fit its own.
   *
   * MUST run before `calibrate`, and the ordering is why it is not a separate public
   * step the caller could forget: adopting AFTER calibrating placed the shells against
   * a frame that had already been used, silently, and the only symptom was eyes and
   * teeth in the wrong place.
   *
   * @param space The sibling's fitted frame, from its `rigSpace`.
   * @param space.lin The frame's rotation and scale, row-major 3x3.
   * @param space.offset The frame's translation, in bundle units.
   * @returns True when the backend took the frame; false when it has none to adopt
   * into, in which case the branch must fit its own.
   */
  adoptRigSpace(space: { lin: Float32Array; offset: Float32Array }): boolean {
    const rig = this.rigBackend as {
      adoptRigSpace?: (lin: Float32Array, offset: Float32Array) => boolean;
    } | null;
    return rig?.adoptRigSpace?.(space.lin, space.offset) ?? false;
  }

  /**
   * Record this branch's rig deform into `encoder`.
   *
   * Everything is one submission per frame: the rig pass, the copy into the lifter's
   * vertex buffer, the transform, the jacobians and the plücker rays. There is no
   * fence between them because one device means one queue and WebGPU executes
   * recorded commands in order.
   *
   * @param encoder The frame's command encoder, recorded into but never submitted
   * here. A no-op on a branch with no rig; throws when the branch has one but was
   * never calibrated, since posing against an unfitted frame misplaces it silently.
   */
  encodePose(encoder: GPUCommandEncoder): void {
    const rig = this.rigBackend;
    if (!rig) return;
    if (!this.anchored) {
      throw new Error(`CharacterBranch "${this.name}": calibrate before posing`);
    }
    rig.encode(encoder);
  }

  /**
   * Copy the rig's posed vertices into the lifter and rebuild the jacobians.
   *
   * Recorded into the SAME encoder `encodePose` just wrote into, immediately after
   * it: the copy reads what the rig pass writes, and commands inside one encoder
   * execute in the order they were recorded. It was a separate submission per branch
   * until the frame encoder was threaded through.
   *
   * @param encoder The frame's command encoder, recorded into but never submitted
   * here. A no-op on a branch with no rig.
   */
  applyPose(encoder: GPUCommandEncoder): void {
    const rig = this.rigBackend;
    if (!rig) return;
    this.lifter.setPoseGpu(
      { gpuBuffer: rig.vertsBuffer, byteLength: rig.vertexCount * 3 * 4 },
      encoder,
    );
  }

  /**
   * rig -> trunk -> code -> geom -> `geom_uv`. Caches `code` for the appearance pass.
   *
   * @param rig The control vector; trimmed or zero-padded to this branch's `rigDim`.
   * @returns The geometry decoder's `geom_uv` map, on the shared device when ORT
   * accepted it and as a CPU array otherwise.
   */
  async runGeom(rig: Float32Array): Promise<NodeTensor> {
    const trimmed = trim(rig, this.rigDim);
    return this.decoders.runGeom({ loc: 'cpu', data: trimmed, dims: [1, this.rigDim] });
  }

  /**
   * Record this branch's plücker rays for `camera` into `encoder`.
   *
   * SPLIT OUT of `runAppearance` so the rays join the frame's one encoder instead of
   * submitting their own. The caller must submit `encoder` before awaiting
   * `runAppearance`, because ORT reads the ray buffer as an appr input and only a
   * submitted command is ordered ahead of whatever ORT enqueues.
   *
   * The CPU fallback that used to live here was unreachable — `init()` always builds
   * the plücker — and a second implementation of these rays could only disagree with
   * the shader silently, so it is gone.
   *
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   * @param camera The viewer, already expressed in the avatar's LOCAL frame — the
   * plücker rays are built from it, and the appearance decoder trained in that frame.
   */
  encodePlucker(encoder: GPUCommandEncoder, camera: PluckerCamera): void {
    const plucker = this.plucker;
    if (!plucker) throw new Error(`CharacterBranch "${this.name}": init before encodePlucker`);
    const H = this.uvRes;
    this.pluckerTensor = liftInputToNodeTensorFromOrt(
      plucker.compute(camera, H, H, this.pluckerFrame, encoder),
      [1, 6, 1, H, H],
    );
  }

  /**
   * `{cached code, the rays `encodePlucker` recorded}` -> appr -> `color_uv`.
   *
   * @returns The appearance decoder's `color_uv` map, one `uvRes * uvRes` image.
   */
  async runAppearance(): Promise<NodeTensor> {
    const plucker = this.pluckerTensor;
    if (!plucker) {
      throw new Error(`CharacterBranch "${this.name}": encodePlucker before runAppearance`);
    }
    return this.decoders.runAppearance(plucker);
  }

  /**
   * Lift the last full pass's UV maps into this branch's slots.
   *
   * @param uvs The decoder outputs to turn into gaussians.
   * @param uvs.geom_uv The geometry map, from `runGeom`.
   * @param uvs.color_uv The appearance map, from `runAppearance`.
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   * @param skipGeomUpload True on an appearance-only pass, where `geom_uv` is the
   * very array the last full pass already uploaded.
   */
  lift(
    uvs: { geom_uv: NodeTensor; color_uv: NodeTensor },
    encoder: GPUCommandEncoder,
    skipGeomUpload = false,
  ): void {
    this.lifter.lift(
      nodeTensorToLiftInput(uvs.geom_uv),
      nodeTensorToLiftInput(uvs.color_uv),
      encoder,
      { skipGeomUpload },
    );
  }

  /**
   * The decoder outputs of the last full pass, or null before one.
   *
   * @returns The cached `geom_uv` and `color_uv` the next lift would consume, or null
   * until both a geometry and an appearance pass have run.
   */
  uvOutputs(): { geom_uv: NodeTensor; color_uv: NodeTensor } | null {
    return this.decoders.uvOutputs();
  }

  /**
   * Lift the last pass's outputs, refusing to lift a pass that never happened.
   *
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   * @param skipGeomUpload True on an appearance-only pass — see {@link lift}.
   */
  liftLast(encoder: GPUCommandEncoder, skipGeomUpload = false): void {
    const uvs = this.decoders.uvOutputs();
    if (!uvs) throw new Error(`CharacterBranch "${this.name}": lift before a decode`);
    this.lift(uvs, encoder, skipGeomUpload);
  }

  /**
   * Demote every decoder's gpu-buffer outputs to CPU. Sticky.
   *
   * @param on True to download every decoder output to a CPU array, which is the
   * fallback when ORT did not take the renderer's device. It stays set until turned
   * off again — a cross-device buffer is a validation error, not a slow path.
   */
  setDownloadOutputs(on: boolean): void {
    this.decoders.setDownloadOutputs(on);
  }

  /**
   * Approximate GPU bytes this branch holds.
   *
   * @returns The lifter's buffers plus the rig backend's, for `memoryReport()`. It
   * excludes the sink's storage buffers, which the character shares.
   */
  bytes(): number {
    return this.lifter.bytes() + (this.rigBackend?.bytes() ?? 0);
  }

  private dropRig(): void {
    this.rigBackend?.dispose();
    this.rigBackend = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropRig();
    this.decoders.dispose();
    this.plucker?.destroy();
    this.plucker = null;
    this.pluckerTensor = null;
    this.lifter.destroy();
  }
}

/**
 * Fit a rig vector to a branch's declared width, zero-padding a short one.
 *
 * @param rig The caller's control vector, of any length.
 * @param dim The width the branch's decoders take.
 * @returns `rig` itself when the widths already agree — no copy on the per-frame
 * path — else a new `dim`-wide array, truncated or zero-padded at the tail.
 */
export function trim(rig: Float32Array, dim: number): Float32Array {
  if (rig.length === dim) return rig;
  const out = new Float32Array(dim);
  out.set(rig.subarray(0, Math.min(dim, rig.length)));
  return out;
}

/**
 * The plücker's ORT tensor as a `NodeTensor`.
 *
 * @param tensor Whatever `GpuPlucker.compute` returned — it carries a `gpuBuffer` on
 * the shared-device path and CPU `data` otherwise.
 * @param dims The tensor's shape, `[1, 6, 1, H, H]`, which also gives the byte length
 * of the gpu-buffer form.
 * @returns The same rays as the tensor shape the appearance session takes, keeping
 * them on the device wherever they already are.
 */
function liftInputToNodeTensorFromOrt(tensor: unknown, dims: readonly number[]): NodeTensor {
  const t = tensor as { gpuBuffer?: GPUBuffer; data?: unknown };
  if (t.gpuBuffer) {
    const n = dims.reduce((a, b) => a * b, 1);
    return liftInputToNodeTensor({ gpuBuffer: t.gpuBuffer, byteLength: n * 4 }, dims);
  }
  return { loc: 'cpu', data: t.data as Float32Array, dims };
}
