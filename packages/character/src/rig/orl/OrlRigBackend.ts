// The exact MetaHuman rig as a `RigBackend`.
//
// Replaces aos-threejs-poc/src/ogs/graph/nodes/{OrlDeform,OrlShellDeform}.ts @
// cdd63b10, which were graph nodes with ports. The two are folded into one backend
// with a MODE, because what they actually are is two answers to the same question
// — "what does this DNA have to say about this branch's mesh?" — and keeping them
// apart made `OGSBranch.makeDeform` decide between them by vertex count anyway:
//
//   skin   the branch mesh IS MetaHuman `head_lod0` (24,049 verts), which is the
//          one mesh a `head.dna` bakes. Full blendshapes + LBS, in WGSL.
//   shell  the branch is the character's EYES AND TEETH, decimated to a
//          per-character stand-in (760-880 verts, matching no MetaHuman mesh).
//          Four rigid joint transforms, on the CPU — a WGSL pass over 800 verts
//          would cost more in dispatch than it saves. See ./shellDeform.ts.
//   (neither: a genuine body or hair branch has no such joints in a `head.dna`,
//    reports that, and renders at its NEUTRAL pose. Deliberate, not a fallback.)
//
// WHY THE HEAD PATH IS EQUIVALENT TO THE DISTILLATION IT REPLACES (measured,
// isaac-ogs head branch vs `rig2mesh_head.onnx`): compared as DISPLACEMENT FROM
// NEUTRAL — the domain that matters, because calibration folds the constant
// per-vertex difference into `corr` — the two agree to 0.26-0.70 mm median against
// 7-34 mm of actual motion. The absolute neutral shape differs by 3.96 mm median
// and the ONNX is origin-centred cm vs ORL's rig world space; `corr` absorbs both.
// 163/174 of a bundle's controls map to DNA GUI controls; the 11 that do not each
// move the head mesh <= 0.6 mm through the ONNX model, except `CTRL_C_eye.translateY`
// at 5.8 mm. Reference: jaw open is 32.6 mm.

import type { JointOverride, RigBackend, RigBackendInit, VertsAABB } from '../RigBackend.js';
import { aabbOf, invertAffine } from '../skinMath.js';
import { buildBlendshapeCsr } from './csr.js';
import { createOrlGpuDeform, type OrlGpuDeform } from './OrlGpuDeform.js';
import { createOrlRig, type OrlRig } from './orlRig.js';
import {
  assignShellJoints,
  poseShells,
  shellCentroids,
  splitShells,
  SHELL_JOINT_NAMES,
} from './shellDeform.js';

/**
 * MetaHuman `head_lod0` vertex count — what an ORL pack bakes. A branch mesh of
 * any other size is not a `head_lod0` and cannot be skinned by the DNA.
 */
export const ORL_HEAD_VERTS = 24049;

/**
 * Vertex ceiling for the decimated eyes/teeth stand-in the rigid shells drive.
 * Measured: eyeline 762, isaac 882; a real body/clothes branch is 32k-165k.
 *
 * A size test, not a name test, because the eyes/teeth branch is ITSELF named
 * `body` on some bundles while another bundle's `body` is a real body.
 */
export const ORL_SHELL_MAX_VERTS = 4096;

/** How this backend can drive one branch. */
export type OrlDriveMode = 'skin' | 'shell' | 'none';

/**
 * Decide the drive mode from the branch mesh alone.
 *
 * @param vertexCount The branch mesh's vertex count.
 * @returns `skin` at exactly `ORL_HEAD_VERTS`, `shell` at or below
 *   `ORL_SHELL_MAX_VERTS`, and `none` for anything bigger — a real body or hair
 *   branch, which renders at its neutral pose.
 */
export function orlDriveMode(vertexCount: number): OrlDriveMode {
  if (vertexCount === ORL_HEAD_VERTS) return 'skin';
  if (vertexCount <= ORL_SHELL_MAX_VERTS) return 'shell';
  return 'none';
}

/** Options a shell-mode backend needs beyond the shared `RigBackendInit`. */
export interface OrlRigBackendOptions {
  /** Which branch this backend drives; decides `skin` vs `shell`. */
  mode: OrlDriveMode;
  /** The branch's baked neutral vertices, in the BUNDLE's own space. Shell mode only. */
  neutralVertices?: Float32Array;
  /** The branch's triangle indices — the shell split is by connectivity. Shell mode only. */
  faces?: Uint32Array | Uint16Array;
  /** Log sink; defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * How near zero a joint's rest determinant may be before it counts as singular.
 *
 * Looser than `skinMath`'s own default because ORL works in CENTIMETRES: a
 * legitimate finger joint's rest transform has a determinant around 1, but a
 * degenerate one there is worth catching well before 1e-20.
 */
const ORL_SINGULAR_DETERMINANT = 1e-12;

/**
 * `rel = world · restInv`, row-major, written into `out` at joint `j`.
 *
 * @param world Posed world matrices, flat row-major 4x4.
 * @param wo Element index of the posed matrix (`j * 16`).
 * @param inv Inverted rest matrices, flat row-major 4x4.
 * @param io Element index of the rest inverse (`j * 16`).
 * @param out Destination, flat row-major 4x4. The bottom row is written as
 *   `[0, 0, 0, 1]` rather than multiplied out.
 * @param oo Element index to write at.
 */
function mulAffine(
  world: Float64Array,
  wo: number,
  inv: Float64Array,
  io: number,
  out: Float32Array,
  oo: number,
): void {
  for (let r = 0; r < 3; r++) {
    const a0 = world[wo + r * 4];
    const a1 = world[wo + r * 4 + 1];
    const a2 = world[wo + r * 4 + 2];
    const a3 = world[wo + r * 4 + 3];
    out[oo + r * 4] = a0 * inv[io] + a1 * inv[io + 4] + a2 * inv[io + 8] + a3 * inv[io + 12];
    out[oo + r * 4 + 1] =
      a0 * inv[io + 1] + a1 * inv[io + 5] + a2 * inv[io + 9] + a3 * inv[io + 13];
    out[oo + r * 4 + 2] =
      a0 * inv[io + 2] + a1 * inv[io + 6] + a2 * inv[io + 10] + a3 * inv[io + 14];
    out[oo + r * 4 + 3] =
      a0 * inv[io + 3] + a1 * inv[io + 7] + a2 * inv[io + 11] + a3 * inv[io + 15];
  }
  out[oo + 12] = 0;
  out[oo + 13] = 0;
  out[oo + 14] = 0;
  out[oo + 15] = 1;
}

/** OpenRigLogic as a `RigBackend`, in skinning or rigid-shell mode. */
export class OrlRigBackend implements RigBackend {
  readonly kind = 'orl' as const;
  private readonly mode: OrlDriveMode;
  private readonly log: (message: string) => void;
  private readonly neutralBundle: Float32Array;
  private readonly faces: Uint32Array | Uint16Array;

  private rig: OrlRig | null = null;
  private gpu: OrlGpuDeform | null = null;
  private device: GPUDevice | null = null;
  private controls = new Float32Array(0);
  private _controlNames: string[] = [];
  private _vertexCount = 0;
  private _aabb: VertsAABB = { min: [0, 0, 0], max: [0, 0, 0] };
  private uploadBuffer: GPUBuffer | null = null;

  // Shell mode.
  private shells: Int32Array[] = [];
  private jointOfShell: number[] = [];
  private candidates: number[] = [];
  private neutralRig: Float32Array | null = null;
  private restInv: Float64Array | null = null;
  private rel: Float32Array | null = null;
  private scratch: Float32Array | null = null;
  private shellReady = false;
  private warnedOverrides = false;

  constructor(options: OrlRigBackendOptions) {
    this.mode = options.mode;
    this.log =
      options.log ??
      ((message: string) => {
        console.log(message);
      });
    this.neutralBundle = options.neutralVertices ?? new Float32Array(0);
    this.faces = options.faces ?? new Uint32Array(0);
    if (this.mode === 'shell' && (!options.neutralVertices || !options.faces)) {
      throw new Error('OrlRigBackend: shell mode needs neutralVertices + faces');
    }
  }

  get controlNames(): readonly string[] {
    return this._controlNames;
  }

  get vertexCount(): number {
    return this._vertexCount;
  }

  get vertsAABB(): VertsAABB {
    return this._aabb;
  }

  get vertsBuffer(): GPUBuffer {
    const buffer = this.gpu?.buffer ?? this.uploadBuffer;
    if (!buffer) throw new Error('OrlRigBackend: init() has not run');
    return buffer;
  }

  /**
   * True once a shell-mode backend has adopted a frame and bound a shell.
   *
   * @returns True in skin mode always, and in shell mode once `adoptRigSpace` has
   *   matched at least one shell to a joint.
   */
  get isDriving(): boolean {
    return this.mode === 'skin' || this.shellReady;
  }

  async init(options: RigBackendInit): Promise<void> {
    this.device = options.device;
    this._controlNames = [...options.controlNames];
    this.controls = new Float32Array(this._controlNames.length);
    this.rig = await createOrlRig({
      getBytes: options.getBytes,
      controlNames: this._controlNames,
      // Shell mode must NOT assert the head's vertex count: it never returns the
      // rig's own mesh.
      expectVerts: this.mode === 'skin' ? (options.expectVerts ?? ORL_HEAD_VERTS) : 0,
      // The bundle's control list is MetaHuman-named, so a healthy map resolves
      // nearly all of it; anything near-empty means the wrong DNA for this bundle
      // and must fail loudly rather than render a frozen face.
      minMatched: Math.floor(this._controlNames.length * 0.8),
      log: this.log,
    });

    const rig = this.rig;
    if (this.mode === 'shell') {
      this._vertexCount = this.neutralBundle.length / 3;
      this.initShells(rig, options.device);
    } else {
      this._vertexCount = rig.V;
      this.initSkin(rig, options.device);
    }
    this._aabb = aabbOf(this.mode === 'shell' ? this.neutralBundle : rig.neutral);
  }

  private initSkin(rig: OrlRig, device: GPUDevice): void {
    const d = rig.deformer;
    const csr = buildBlendshapeCsr(d.V, d.buffers.bsIndex, d.buffers.bsDelta, d.bsTargets);
    this.gpu = createOrlGpuDeform(device, d, csr, rig.manifest.numBlendShapeChannels);
    this.log(
      `[character] orl: GPU deform ready (${String(csr.entries)} blendshape entries) — verts stay on-device`,
    );
  }

  private initShells(rig: OrlRig, device: GPUDevice): void {
    const names = rig.manifest.jointNames;
    if (!names) {
      // Loud and specific: an older pack is fine for the head and simply cannot
      // drive this branch. Naming the fix beats a branch that silently freezes.
      this.log(
        '[character] orl shells: this orl_pack.bin carries no jointNames — re-bake it to drive ' +
          'the eyes/teeth branch; staying at neutral',
      );
      this.allocateUpload(device);
      return;
    }
    this.candidates = SHELL_JOINT_NAMES.map((n) => names.indexOf(n));
    const missing = SHELL_JOINT_NAMES.filter((_, k) => this.candidates[k] < 0);
    if (missing.length === SHELL_JOINT_NAMES.length) {
      this.log(
        '[character] orl shells: none of the eye/teeth joints exist in this DNA — staying at neutral',
      );
      this.allocateUpload(device);
      return;
    }
    if (missing.length) {
      this.log(
        `[character] orl shells: DNA has no ${missing.join(', ')} — those shells stay at neutral`,
      );
    }
    this.shells = splitShells(this.faces, this.neutralBundle.length / 3);
    this.allocateUpload(device);
  }

  /**
   * Shell mode has no compute pass, so its verts go up through a plain buffer.
   *
   * @param device The device the lift consumes this branch's vertices on.
   */
  private allocateUpload(device: GPUDevice): void {
    this.uploadBuffer = device.createBuffer({
      label: 'orl_shell_verts',
      size: this.neutralBundle.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.scratch = new Float32Array(this.neutralBundle.length);
  }

  /**
   * Place this branch's shells in RIG space, using the frame a sibling branch
   * already fitted (the head's calibration).
   *
   * This branch cannot fit that frame itself: its mesh is not in the DNA, so there
   * is no correspondence to fit against. The head's frame is the right one to
   * borrow because both branches are baked in a single bundle space — measured, the
   * borrowed frame lands these shells 0.11-0.35 cm from the DNA's own eye and teeth
   * meshes.
   *
   * MUST run before calibration. Returns false when the branch stays neutral.
   *
   * @param lin The sibling's fitted rig -> bundle linear part, nine floats in the
   *   row-vector convention `v·lin + offset`. Inverted here to map this branch's
   *   neutral back into rig space.
   * @param offset The matching translation, three floats.
   * @returns True once at least one shell is bound to a joint. False — and the
   *   branch stays at its neutral pose — in skin mode, before `init`, when the pack
   *   carries no joint names, when the sibling's transform is singular, or when no
   *   shell centroid landed near an eye/teeth joint.
   */
  adoptRigSpace(lin: Float32Array, offset: Float32Array): boolean {
    const rig = this.rig;
    const names = rig?.manifest.jointNames;
    if (this.mode !== 'shell' || !rig || !names || !this.shells.length || !this.candidates.length) {
      return false;
    }
    // Bundle space -> rig space is the inverse of `v·lin + offset`.
    const inv = new Float64Array(16);
    const fwd = new Float64Array([
      lin[0],
      lin[3],
      lin[6],
      offset[0],
      lin[1],
      lin[4],
      lin[7],
      offset[1],
      lin[2],
      lin[5],
      lin[8],
      offset[2],
      0,
      0,
      0,
      1,
    ]);
    if (!invertAffine(fwd, 0, inv, 0, ORL_SINGULAR_DETERMINANT)) {
      this.log(
        '[character] orl shells: sibling rig-space transform is singular — staying at neutral',
      );
      return false;
    }
    const n = this.neutralBundle.length;
    const rigSpace = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const x = this.neutralBundle[i];
      const y = this.neutralBundle[i + 1];
      const z = this.neutralBundle[i + 2];
      rigSpace[i] = inv[0] * x + inv[1] * y + inv[2] * z + inv[3];
      rigSpace[i + 1] = inv[4] * x + inv[5] * y + inv[6] * z + inv[7];
      rigSpace[i + 2] = inv[8] * x + inv[9] * y + inv[10] * z + inv[11];
    }
    this.neutralRig = rigSpace;

    // Rest joint transforms, at the rig's own neutral controls.
    const d = rig.deformer;
    const { jointOut } = rig.evaluateRig(new Float32Array(this._controlNames.length));
    d.computeSkin(jointOut);
    const world = d.world;
    const J = d.J;
    const restInv = new Float64Array(J * 16);
    const origins = new Float32Array(J * 3);
    for (const j of this.candidates) {
      if (j < 0) continue;
      if (!invertAffine(world, j * 16, restInv, j * 16, ORL_SINGULAR_DETERMINANT)) {
        this.log(
          `[character] orl shells: joint ${String(j)} rest transform is singular — its shell stays at neutral`,
        );
      }
      origins[j * 3] = world[j * 16 + 3];
      origins[j * 3 + 1] = world[j * 16 + 7];
      origins[j * 3 + 2] = world[j * 16 + 11];
    }
    this.restInv = restInv;
    this.rel = new Float32Array(J * 16);

    const centroids = shellCentroids(rigSpace, this.shells);
    this.jointOfShell = assignShellJoints(
      centroids,
      origins,
      this.candidates.filter((j) => j >= 0),
    );
    const named = (j: number) => (j < 0 ? '(none)' : (names[j] ?? '(unnamed)'));
    this.log(
      `[character] orl shells: ${String(this.shells.length)} shells -> ` +
        this.shells.map((s, k) => `${String(s.length)}v:${named(this.jointOfShell[k])}`).join(', '),
    );
    this.shellReady = this.jointOfShell.some((j) => j >= 0);
    if (!this.shellReady) {
      this.log('[character] orl shells: no shell matched an eye/teeth joint — staying at neutral');
    }
    return this.shellReady;
  }

  setControls(controls: Float32Array): void {
    if (controls.length !== this.controls.length) {
      throw new Error(
        `OrlRigBackend.setControls: got ${String(controls.length)} controls, this rig takes ${String(this.controls.length)}`,
      );
    }
    this.controls.set(controls);
  }

  encode(encoder: GPUCommandEncoder): void {
    const rig = this.rig;
    const device = this.device;
    if (!rig || !device) throw new Error('OrlRigBackend: init() has not run');
    const gpu = this.gpu;
    if (this.mode === 'skin' && gpu) {
      const { jointOut, bsOut } = rig.evaluateRig(this.controls);
      gpu.deform(encoder, jointOut, bsOut);
      return;
    }
    // Shell mode is CPU: four 4x4 multiplies over ~800 vertices. The result is
    // uploaded rather than computed, which is why `encode` records nothing.
    const scratch = this.scratch;
    const upload = this.uploadBuffer;
    if (!scratch || !upload) return;
    const posed = this.poseInto(this.controls, scratch);
    device.queue.writeBuffer(upload, 0, posed.buffer, posed.byteOffset, posed.byteLength);
  }

  private poseInto(rigVec: Float32Array, out: Float32Array): Float32Array {
    const neutral = this.neutralRig;
    if (!this.shellReady || !this.rig || !neutral || !this.restInv || !this.rel) {
      // Not bound: the branch's own neutral, which is what "frozen" means here.
      out.set(neutral ?? this.neutralBundle);
      return out;
    }
    const d = this.rig.deformer;
    const { jointOut } = this.rig.evaluateRig(rigVec);
    d.computeSkin(jointOut);
    const world = d.world;
    for (const j of this.jointOfShell) {
      if (j >= 0) mulAffine(world, j * 16, this.restInv, j * 16, this.rel, j * 16);
    }
    return poseShells(neutral, this.shells, this.jointOfShell, this.rel, out);
  }

  /**
   * Calibration path. Deliberately uses the CPU deform even when the GPU one is
   * live: `corr = neutral - runCpu(baseRig)` is added to every GPU-produced frame,
   * so the two must agree.
   *
   * @param controls One value per name in `controlNames`.
   * @returns A fresh array of posed vertices as xyz triples, in CENTIMETRES — the
   *   rig's own mesh in skin mode, this branch's rigid-shell pose in shell mode.
   *   Never the reused scratch, since the caller keeps it.
   */
  runCpu(controls: Float32Array): Promise<Float32Array> {
    if (!this.rig) throw new Error('OrlRigBackend: init() has not run');
    if (this.mode === 'shell') {
      return Promise.resolve(this.poseInto(controls, new Float32Array(this.neutralBundle.length)));
    }
    return Promise.resolve(Float32Array.from(this.rig.evaluate(controls)));
  }

  /**
   * No addressable joint namespace yet — head aim rides the body rig, not the DNA.
   *
   * @param overrides Ignored. A non-empty list logs once, so a caller wondering why
   *   its aim does nothing is told rather than left guessing.
   * @returns Always false: nothing moved, so a caller gating its rig dirty flag on
   *   this must NOT re-run a pass. That is the whole reason the method reports a
   *   result rather than returning void — an inert override used to force a full
   *   decode of an idle head every single frame.
   */
  setJointOverrides(overrides: readonly JointOverride[]): boolean {
    // Intentionally inert. RigLogic's head/neck pose quaternions are DERIVED raw
    // controls with no GUI source, so an override here would move nothing and read as a
    // broken rig. Head aim belongs on the body skeleton, and saying so once beats a
    // caller wondering why its aim does nothing.
    if (overrides.length && !this.warnedOverrides) {
      this.warnedOverrides = true;
      this.log(
        '[character] orl: this rig has no addressable joints — head aim belongs on the body skeleton',
      );
    }
    return false;
  }

  bytes(): number {
    return (this.gpu?.bytes() ?? 0) + (this.uploadBuffer?.size ?? 0);
  }

  dispose(): void {
    this.gpu?.destroy();
    this.gpu = null;
    this.uploadBuffer?.destroy();
    this.uploadBuffer = null;
    // Paired with createOrlRig(): the rig is SHARED with any sibling branch driving
    // the same pack, so dropping the reference is not enough — the last holder to
    // release is what frees the wasm heap.
    this.rig?.release();
    this.rig = null;
    this.neutralRig = null;
    this.restInv = null;
    this.rel = null;
    this.scratch = null;
    this.shellReady = false;
  }
}
