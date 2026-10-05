// The character runtime: a loaded bundle plus a splat sink in, an imperative handle
// out.
//
// Replaces aos-threejs-poc/src/ogs/graph/neutralBranchSystem.ts and
// inference/headTeethEngine.js @ cdd63b10 — the mount and the per-frame engine, which
// were separate only because one was a React component's entry point and the other
// was not.
//
// THE THREE THINGS THAT MAKE THIS WORK, all inherited from the POC:
//
//   TWO SUBMISSIONS PER UPDATE, and the split is the ORT boundary, not an accident.
//   Every branch's rig deform, vertex transform, jacobians and plücker rays go into
//   ONE encoder, which is submitted before the first `await` — because ORT reads the
//   plücker buffer as an appearance input and only a submitted command is ordered
//   ahead of whatever ORT enqueues next. Every branch's two lift passes then go into a
//   SECOND encoder, submitted once at the end. There is no fence anywhere: one device
//   means one queue, and WebGPU executes submissions in order.
//
//   (It really was `3B + 1` submissions for B branches until the frame encoder was
//   threaded through `setPoseGpu`, `GpuPlucker.compute` and `lift`, each of which
//   created and submitted an encoder of its own — while this header claimed one.)
//
//   THE GEOM/APPEARANCE SPLIT. A rig change is a full pass; a camera change re-runs
//   only plücker + appr against the cached `code` latent, then re-lifts. On a 750²
//   head that is a re-colour rather than a re-decode.
//
//   LATEST-ONLY COALESCING. Two overlapping ORT sequences race the WebGPU EP's buffer
//   manager, so passes are serialized and a burst collapses to one re-run at the
//   newest state. `settled()` is how a test or a screenshot waits for that to drain.
//
// CALIBRATION IS TWO PASSES, and the order is load-bearing. Most branches fit their own
// rig -> bundle frame from their own mesh. The eyes/teeth branch cannot: its mesh is
// not in the DNA, so there is nothing to fit against. It BORROWS a sibling's frame —
// correct because every branch of a bundle is baked in one space — which means at least
// one ordinary branch must calibrate first.

import { Matrix4, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';

import type { ExpressionSpace } from './assets/characterManifest.js';
import { CharacterBranch, trim } from './branch.js';
import type { CharacterBundle } from './bundle/loadCharacterBundle.js';
import { prepareLiftDevice, type RendererLike } from './device/index.js';
import { attachOrtDevice, verifyOrtDevice } from './device/ortDevice.js';
import type { LiftPlacement } from './inference/GpuLifter.js';
import {
  createPoseAnchorBlender,
  parsePoseAnchors,
  poseAnchorsFileFor,
  type PoseAnchorBlender,
} from './inference/poseAnchors.js';
import { latestOnly } from './latestOnly.js';
import * as ort from './ort.js';
import { providersFor } from './decoder/ortSession.js';
import { LocalFrameCamera } from './render/localFrameCamera.js';
import { worldRotationQuaternion, quaternionToWxyz } from './render/worldRotation.js';
import { arkitToRig } from './rig/arkit/arkitToRig.js';
import { gatherFromRigNames } from './rig/arkit/rigGatherFromNames.js';
import { GnmRigBackend } from './rig/gnm/GnmRigBackend.js';
import { OrlRigBackend, orlDriveMode } from './rig/orl/OrlRigBackend.js';
import type { JointOverride, RigBackend } from './rig/RigBackend.js';
import { emptyAabb, growAabb } from './rig/skinMath.js';
import type { SlotRange, SplatSink } from './splatSink.js';

/** A body pose the animation layer hands over. */
export interface BodyPose {
  /** Per-joint parent-relative rotations, by the rig's own joint names. */
  bones?: readonly JointOverride[];
  /** Root translation in scene metres. Moves the character's `object3D`. */
  rootPos?: readonly [number, number, number];
}

/** Tuning a game may pass at creation. */
export interface CharacterOptions {
  /**
   * Apply the bundle's baked per-pose anchors when it ships them. DEFAULT OFF.
   *
   * They correct where the head IS — the training export fitted a rigid transform per
   * FRAME, and a face control set has no rigid head controls, so head placement is not
   * a function of the rig at all. The correction is real (the single row-0 anchor is
   * out by a p50 of 9.1 mm at the other trained poses) but the blend moves the head
   * whenever the nearest trained poses change, and during speech that happens on a
   * BLINK: measured, a blink steps the head 5.10 mm in ONE frame. A ~4.6 mm mean
   * correction does not pay for a head pop synchronised with blinking, so this is
   * opt-in until the neighbour search can ignore the lids.
   */
  poseAnchors?: boolean;
  /** Prefer the bundle's fp16-internal decoders. Default true. */
  preferFp16?: boolean;
  /** Log sink; defaults to `console.log`. */
  log?: (message: string) => void;
}

/** What `createCharacter` takes. */
export interface CreateCharacterOptions {
  renderer: RendererLike;
  /** The scene the character's root is added to. */
  scene: Object3D;
  /** The splat object this character writes its gaussians into. */
  sink: SplatSink;
  options?: CharacterOptions;
}

/** Where a character's memory went. */
export interface MemoryReport {
  /** Resident bundle bytes (decoders, meshes, rig pack). */
  bundleBytes: number;
  /** Approximate GPU bytes across every branch's lift and rig. */
  gpuBytes: number;
  /** Splat slots this character owns. */
  slots: number;
  /** Per branch: name, slots, GPU bytes. */
  branches: { name: string; slots: number; gpuBytes: number }[];
}

/** A live splat character. */
export interface Character {
  /** The scene node the character hangs under. */
  readonly object3D: Object3D;
  /** The branches that came alive, in manifest order. */
  readonly branches: readonly string[];
  /** What the animation layer is supposed to send. */
  readonly expressionSpace: ExpressionSpace;
  /** Which rig posed the face. */
  readonly rigKind: string;

  /**
   * Drive the rig directly, in the bundle's OWN control space.
   *
   * This is the raw vector the decoders were trained on — `rig_names.json` order for
   * an ORL bundle, `head_ext` for a GNM one. Prefer `setExpression` unless you are
   * authoring against a specific character.
   */
  setRig(controls: Float32Array): void;

  /**
   * Drive the face in the bundle's declared `expression_space`.
   *
   * ARKit-52 for an `arkit52` bundle, `head_ext` (387) or the reduced view (68) for a
   * GNM one. An ARKit vector reaching a GNM bundle with no `arkit_map` is REFUSED,
   * loudly: the two spaces are unrelated, and a silent reinterpretation is a face that
   * moves wrongly with nothing to see.
   */
  setExpression(weights: Float32Array): void;

  /** Pose the body: per-joint rotations for the rig, plus a root translation. */
  setBodyPose(pose: BodyPose | null): void;

  /** Look at a world point, or null to return to rest. */
  setLookAt(target: readonly [number, number, number] | null): void;

  /**
   * Advance one frame.
   *
   * Cheap and allocation-free when nothing changed: it compares the camera against the
   * last decoded view and re-runs the appearance pass only when it has genuinely
   * moved. The epsilon is 2 mm plus a turn/fov term, because a pass is an appr decode
   * plus a lift.
   */
  update(dt: number, camera: PerspectiveCamera): void;

  /** Resolves when every in-flight pass has drained. For tests and screenshots. */
  settled(): Promise<void>;

  /** Where this character's memory went. */
  memoryReport(): MemoryReport;

  /** Release every GPU buffer, ORT session, wasm heap and slot range. Idempotent. */
  dispose(): void;
}

/** How far the camera must move before the appearance pass re-runs. */
const CAMERA_EPSILON_METRES = 2e-3;
const CAMERA_EPSILON_QUAT = 1e-4;

/**
 * Bring a loaded bundle to life against a splat sink.
 *
 * @param bundle The already-loaded bundle, from `loadCharacterBundle`.
 * @param init The renderer whose device everything borrows, the scene to parent the
 * splat object under, the sink whose slots the branches are lifted into, and the
 * optional tuning in `init.options`.
 * @returns The live character: `setRig` / `setExpression` / `setBodyPose` /
 * `setLookAt` to drive it, `update` once a frame, and `dispose` to give back every
 * GPU buffer, ORT session and slot range.
 *
 * @throws {CharacterUnsupportedError} (from `./errors.ts`, via `prepareLiftDevice`)
 *   when the renderer is not on the WebGPU backend.
 *
 * @example
 * ```ts
 * const bundle = await loadCharacterBundle('/assets/characters/myra');
 * const character = await createCharacter(bundle, { renderer, scene, sink });
 * character.setExpression(arkitWeights);
 * character.update(dt, camera);
 * ```
 */
export async function createCharacter(
  bundle: CharacterBundle,
  init: CreateCharacterOptions,
): Promise<Character> {
  const options = init.options ?? {};
  const log =
    options.log ??
    ((message: string) => {
      console.log(message);
    });

  // The device order is load-bearing — see `device/index.ts`. `prepareLiftDevice`
  // throws `CharacterUnsupportedError` on the WebGL fallback, which is the one error a
  // caller is expected to branch on.
  const device = prepareLiftDevice(init.renderer);
  const attachment = attachOrtDevice(device);
  if (attachment.reason) log(`[character] ${attachment.reason}`);
  const providers = providersFor(attachment.shared);

  const manifest = bundle.manifest;
  const scene = bundle.scene;
  if (!scene.branches.length) {
    throw new Error(
      "character bundle: scene.json declares no mesh branch (a gaze-conditioned branch is the eye system's, not a mesh branch)",
    );
  }

  // ONE quaternion for both consumers — the lift turns the gaussians by it, the
  // plücker camera by its inverse, and they must be the SAME rotation. Rotate only one
  // and the geometry stands up while the view-dependent shading quietly reads from a
  // viewpoint 180° from the real one: no error, just wrong colour.
  const worldRotation = worldRotationQuaternion(manifest.scene.worldRotation);
  const placement: LiftPlacement = {
    worldScale: manifest.scene.worldScale,
    worldOffset: manifest.scene.worldOffset,
    worldRotation: quaternionToWxyz(worldRotation),
  };
  const pluckerFrame = {
    originScale: 1 / manifest.scene.worldScale,
    worldOffset: manifest.scene.worldOffset,
    worldRotation,
    momentScale: manifest.scene.momentScale,
  };

  const root = new Object3D();
  root.name = `character:${manifest.scene.subject || 'unnamed'}`;
  init.scene.add(root);
  root.add(init.sink.object3D);

  // Slots are reserved ONCE per branch and never move: the sort keeps an index ->
  // splat map across frames, so a branch that goes quiet writes opacity 0 rather than
  // shrinking. Reserved before anything is built, so a sink too small for the character
  // fails before a single ONNX session is created.
  const ranges: SlotRange[] = [];
  const branches: CharacterBranch[] = [];
  // Whether ORT is REALLY on the renderer's device. `attachOrtDevice` reports what it
  // asked for; only the getter, read once a session exists, reports what happened.
  let gpuBufferIo = attachment.gpuBufferIo;
  let deviceVerified = false;
  try {
    for (const assets of scene.branches) {
      ranges.push(init.sink.allocate(assets.uvRes * assets.uvRes));
    }
  } catch (e) {
    for (const range of ranges) init.sink.free(range);
    init.scene.remove(root);
    throw e;
  }

  const releaseSlots = (): void => {
    for (const range of ranges) init.sink.free(range);
    ranges.length = 0;
  };

  try {
    for (let i = 0; i < scene.branches.length; i++) {
      const assets = scene.branches[i];
      const spec = assets.spec;
      const bytesOf = (name: string) => bundle.bytes.getBytes(name);
      const fp16Of = (file: string) => {
        const sibling = file.endsWith('.onnx') ? `${file.slice(0, -5)}_fp16.onnx` : null;
        return sibling ? bytesOf(sibling) : undefined;
      };
      const sourceOf = (file: string) => {
        const resident = bytesOf(file);
        return resident
          ? { bytes: resident, fp16Bytes: fp16Of(file) }
          : { getFp32: () => bundle.resolver(file), fp16Bytes: fp16Of(file) };
      };
      const rig = await buildRigBackend(manifest, assets, device, bundle, log);
      const branch = new CharacterBranch({
        assets,
        device,
        sink: init.sink,
        range: ranges[i],
        placement,
        pluckerFrame,
        ort: ort as never,
        providers,
        gpuBufferIo: attachment.gpuBufferIo,
        preferFp16: options.preferFp16 ?? bundle.preferFp16,
        trunkBytes: spec.trunk ? bytesOf(spec.trunk) : undefined,
        geom: sourceOf(spec.geom),
        appr: sourceOf(spec.appr),
        rig,
        log,
      });
      await branch.init();
      // The FIRST session is what pins ORT's device, so this is the earliest moment
      // the question has an answer — and the last moment a wrong answer is still
      // cheap. A mismatch here and the lift would copy a foreign GPUBuffer, which is
      // a validation error and a dead avatar, not a slow path.
      if (!deviceVerified) {
        deviceVerified = true;
        if (gpuBufferIo && !(await verifyOrtDevice(device))) {
          gpuBufferIo = false;
          log(
            '[character] ORT did not adopt the renderer device — demoting every decoder output to the CPU',
          );
          for (const built of branches) built.setDownloadOutputs(true);
        }
      }
      if (!gpuBufferIo) branch.setDownloadOutputs(true);
      branches.push(branch);
    }
  } catch (e) {
    for (const branch of branches) branch.dispose();
    releaseSlots();
    init.scene.remove(root);
    throw e;
  }

  // --- calibration, two passes ---------------------------------------------
  const headBranch = branches.find((b) => b.name === 'head') ?? branches[0];
  const baseRig = headBranch.neutralRig();
  let bundleSpace: { lin: Float32Array; offset: Float32Array } | null = null;
  const deferred: CharacterBranch[] = [];
  for (const branch of branches) {
    if (!branch.hasRig) continue;
    const shell = branch.rigKind === 'orl' && branch !== headBranch && needsBorrowedFrame(branch);
    if (shell) {
      deferred.push(branch);
      continue;
    }
    await branch.calibrate(trim(baseRig, branch.rigDim));
    bundleSpace ??= branch.rigSpace;
  }
  for (const branch of deferred) {
    if (!bundleSpace) {
      log(
        `[character] branch '${branch.name}': no sibling published a rig space — the eyes/teeth stay at neutral`,
      );
    } else {
      branch.adoptRigSpace(bundleSpace);
    }
    await branch.calibrate(trim(baseRig, branch.rigDim), true);
  }

  // --- baked per-pose anchors (opt-in) --------------------------------------
  let anchorBlender: PoseAnchorBlender | null = null;
  if (options.poseAnchors) {
    anchorBlender = await loadPoseAnchors(bundle, manifest.rig.backend, headBranch, log);
  }

  // --- live state -----------------------------------------------------------
  const localCamera = new LocalFrameCamera();
  const lastCameraPos = { x: NaN, y: NaN, z: NaN };
  const lastCameraQuat = new Quaternion(NaN, NaN, NaN, NaN);
  let lastFov = NaN;

  const rigVector = new Float32Array(Math.max(headBranch.rigDim, manifest.rig.controlNames.length));
  // Where a caller's new vector is built before it is compared against `rigVector`.
  // The comparison is the whole point of the geom/appearance split: `setExpression`
  // raised `rigDirty` unconditionally, so an idle bundle character ran trunk + geom +
  // appr + lift sixty times a second for a face that had not moved.
  const rigScratch = new Float32Array(rigVector.length);
  // What the BRANCHES are actually handed: `rigVector` with the look-at folded into
  // the space's gaze segment. Separate on purpose — folding the gaze into `rigVector`
  // itself left four floats in it that no caller ever wrote, so the very next
  // `setExpression` compared a zero gaze against the applied one, reported a change
  // and ran a full pass. Every frame, for as long as the character was looking at
  // anything, which is the whole time an NPC tracks the player.
  const passVector = new Float32Array(rigVector.length);
  const arkitScratch = new Float32Array(188);
  let arkitGather: number[] | null = null;
  if (manifest.expressionSpace.kind === 'arkit52' && manifest.rig.controlNames.length) {
    try {
      arkitGather = gatherFromRigNames(manifest.rig.controlNames);
    } catch (e) {
      // Loud, and NOT fatal: the character still renders and can be driven through
      // `setRig`. Silently dropping the gather would read as a face that never moves.
      log(
        `[character] no ARKit gather for this control space — setExpression is unavailable: ${String(e)}`,
      );
    }
  }

  // The gaze segment, resolved ONCE. `segments.find(s => s.name === 'gaze')` ran on
  // every full pass, allocating a closure to answer a question about a manifest that
  // cannot change for the life of the character.
  const gazeSegment =
    manifest.expressionSpace.kind === 'gnm' || manifest.expressionSpace.kind === 'gnm68'
      ? (manifest.expressionSpace.segments.find((s) => s.name === 'gaze') ?? null)
      : null;

  let rigDirty = true;
  let cameraDirty = true;
  // A one-element box rather than a `let`: `runPass` is async and re-checks this
  // between awaits, and TS narrows a closed-over `let` to its initial value for every
  // read after the closure is created — which would make the teardown guard dead code.
  const state = { disposed: false };
  // Read through a function, never as a narrowed property: `dispose()` lands from
  // OUTSIDE this call stack, during any of the awaits below, and TS's control-flow
  // analysis models neither — it would prove the second check unreachable and the
  // pipeline would go on writing into freed buffers.
  const isDisposed = (): boolean => state.disposed;
  let lookAtWarned = false;
  // The target is POOLED and `lookAtSet` says whether it means anything. `setLookAt`
  // is per-frame on any character that tracks the player, and it used to allocate a
  // `Vector3` on every one of those calls.
  const lookAtTarget = new Vector3();
  let lookAtSet = false;
  const lookAtLocal = new Vector3();
  const rootPos: [number, number, number] = [0, 0, 0];
  // What the last `setBodyPose` wrote, so a repeat does not move the root — and, for
  // an ARKit bundle, what the last `setExpression` was handed, so an unchanged face
  // does not force a full decode.
  let rootPosSet = false;

  /**
   * Fold the look-at target into the rig vector as GNM's own gaze.
   *
   * `head_ext`'s last four floats ARE the gaze: `[pitch_L, yaw_L, pitch_R, yaw_R]` in
   * radians, head-local, pitch > 0 looking down and yaw > 0 toward character-left. So
   * a world point becomes two angles and the model poses the eyeballs itself — there
   * is no eye bone in the body rig to do it with.
   *
   * Both eyes are given the SAME angles rather than converged on the point. Vergence
   * needs each eyeball's own position, which lives in the `.aosrig` pack in head-local
   * metres while the target is in scene space; at conversational distance the
   * difference is under a degree, and getting it wrong is a cross-eyed character.
   * Convergence belongs with the eye branch, which owns both frames.
   *
   * @param vector The rig vector for this frame, written in place: only the four
   * floats of the space's `gaze` segment are touched, and nothing at all happens on a
   * non-GNM space or with no look-at target set.
   */
  function applyGaze(vector: Float32Array): void {
    const gaze = gazeSegment;
    if (!gaze || gaze.start + 4 > vector.length) return;
    if (!lookAtSet) {
      vector.fill(0, gaze.start, gaze.start + 4);
      return;
    }
    // Into the character's own frame: the head is +Z out of the face, +Y up,
    // +X subject-left.
    //
    // `root.matrixWorld` is already fresh: `update` walks the root's ANCESTORS to it
    // before anything reads it. The `updateMatrixWorld(true)` that used to stand here
    // was both the wrong direction — it recomposed the root's descendants, not the
    // parents whose transform the root's own world matrix is built from — and a
    // forced walk of the whole splat subtree once per pass.
    lookAtLocal.copy(lookAtTarget);
    lookAtLocal.applyMatrix4(scratchMatrix.copy(root.matrixWorld).invert());
    const length = lookAtLocal.length() || 1;
    const yaw = Math.atan2(lookAtLocal.x, lookAtLocal.z);
    const pitch = -Math.asin(clamp(lookAtLocal.y / length, -1, 1));
    const cy = clamp(yaw, -MAX_GAZE_YAW, MAX_GAZE_YAW);
    const cp = clamp(pitch, -MAX_GAZE_PITCH, MAX_GAZE_PITCH);
    vector[gaze.start] = cp;
    vector[gaze.start + 1] = cy;
    vector[gaze.start + 2] = cp;
    vector[gaze.start + 3] = cy;
  }

  /**
   * Move `rigScratch` into `rigVector`, reporting whether anything changed.
   *
   * @returns True when at least one control differs from what the rig is already
   * holding. Compared AFTER the store, so the two sides are both f32 and a double
   * that rounds to the same float is correctly not a change.
   */
  function commitRig(): boolean {
    let changed = false;
    for (let i = 0; i < rigVector.length; i++) {
      const previous = rigVector[i];
      rigVector[i] = rigScratch[i];
      if (rigVector[i] !== previous) changed = true;
    }
    return changed;
  }

  /**
   * Zero-pad `controls` into the rig vector, reporting whether anything changed.
   *
   * @param controls The caller's vector, of any length; anything past the rig's own
   * width is ignored and anything short of it reads as zero.
   * @returns True when the rig vector actually moved.
   */
  function writeRig(controls: Float32Array): boolean {
    rigScratch.fill(0);
    rigScratch.set(controls.subarray(0, Math.min(controls.length, rigScratch.length)));
    return commitRig();
  }

  const runPass = async (mode: 'full' | 'appearance'): Promise<void> => {
    if (isDisposed()) return;
    if (mode === 'full' && anchorBlender) {
      // BEFORE the poses below: the delta is part of the transform the pose applies, so
      // installing it after would render this frame in the previous frame's frame.
      if (anchorBlender.update(rigVector)) {
        for (const branch of branches) {
          branch.setPoseAnchorDelta(anchorBlender.lin, anchorBlender.offset);
        }
      }
    }

    // SUBMISSION ONE: every branch's rig deform, the copy into its lifter, the vertex
    // transform, the jacobians and the plücker rays. Submitted here, before the first
    // await, because ORT consumes the plücker buffer as an appearance input and only a
    // submitted command is ordered ahead of what ORT enqueues.
    const geometry = device.createCommandEncoder({ label: 'character_geometry' });
    if (mode === 'full') {
      // The caller's vector plus this frame's gaze. An appearance-only pass reuses
      // whatever the last full pass built here, which is exactly what its cached
      // `code` latent was decoded from.
      passVector.set(rigVector);
      applyGaze(passVector);
      for (const branch of branches) {
        branch.setControls(passVector);
        branch.encodePose(geometry);
        branch.applyPose(geometry);
      }
    }
    for (const branch of branches) branch.encodePlucker(geometry, localCamera);
    device.queue.submit([geometry.finish()]);

    // SUBMISSION TWO: every branch's two lift passes, recorded as each decode lands
    // and submitted once at the end.
    const lift = device.createCommandEncoder({ label: 'character_lift' });
    let lifted = false;
    for (const branch of branches) {
      if (isDisposed()) return;
      // An appearance pass reuses the cached `code` and the cached `geom_uv`, so the
      // geometry map is the very array the last full pass uploaded — unless this
      // branch has no cached pass to reuse, in which case geom really does re-run.
      let geomRan = mode === 'full';
      if (mode === 'full' || !branch.uvOutputs()) {
        geomRan = true;
        await branch.runGeom(passVector);
      }
      await branch.runAppearance();
      branch.liftLast(lift, !geomRan);
      lifted = true;
    }
    if (isDisposed()) return;
    device.queue.submit([lift.finish()]);
    if (lifted) init.sink.markGaussiansChanged();
  };

  // Coalesced: two overlapping ORT sequences race the WebGPU EP's buffer manager, so a
  // burst of rig or camera updates costs one extra pass at the NEWEST state.
  const pump = latestOnly(async (mode: 'full' | 'appearance') => {
    try {
      await runPass(mode);
    } catch (e) {
      console.error(`[character] ${mode} pass failed`, e);
    }
  });

  // The first pass, at the neutral rig, so the character is on screen before anything
  // drives it.
  rigVector.set(trim(baseRig, rigVector.length));
  setBoundingSphere(init.sink, branches, placement);
  await pump('full');
  rigDirty = false;

  log(
    `[character] '${manifest.scene.subject}' ready: ` +
      branches
        .map(
          (b) =>
            `${b.name} uv=${String(b.uvRes)} slots=${String(b.range.count)} rig=${b.rigKind} ` +
            `geom=${b.precision.geom} appr=${b.precision.appr}`,
        )
        .join(', '),
  );

  const character: Character = {
    object3D: root,
    branches: branches.map((b) => b.name),
    expressionSpace: manifest.expressionSpace,
    rigKind: manifest.rig.backend,

    setRig(controls) {
      if (writeRig(controls)) rigDirty = true;
    },

    setExpression(weights) {
      const space = manifest.expressionSpace;
      if (space.kind === 'arkit52') {
        if (!arkitGather) {
          throw new Error(
            "[character] this bundle's control space has no ARKit gather — drive it with setRig()",
          );
        }
        // The ARKit gather writes only `gather.length` controls, so the tail is
        // zeroed for the same reason the GNM path below does it: a rig vector is
        // whatever the caller last set, and a shorter push must not leave the
        // previous expression's tail behind.
        rigScratch.fill(0);
        arkitToRig(
          weights,
          arkitGather,
          rigScratch.subarray(0, arkitGather.length),
          arkitScratch,
          // NOT null. `arkitToRig` documents that a null rest is only correct for a
          // control space centred on zero; with `rig_range [0, 1]` it hands the
          // decoders an extreme corner they never trained on — measured on eyeline
          // V10-C, further from the training distribution than a real trained pose.
          // The branch's own reference rig IS that rest.
          trim(baseRig, arkitGather.length),
          manifest.scene.rigRange,
        );
        if (commitRig()) rigDirty = true;
        return;
      }
      // A GNM space takes `head_ext` (387) or its reduced view (68) directly. An
      // ARKit-52 vector arriving here would be reinterpreted as the first 52
      // expression coefficients — a face that moves, wrongly, with nothing to see.
      if (weights.length !== space.dim && weights.length !== 68) {
        throw new Error(
          `[character] this bundle's expression space is '${space.kind}' (${String(space.dim)} floats); ` +
            `got ${String(weights.length)}. An ARKit-52 vector needs expression_space.arkit_map, which this bundle does not declare.`,
        );
      }
      if (writeRig(weights)) rigDirty = true;
    },

    setBodyPose(pose) {
      if (!pose) return;
      if (pose.rootPos) {
        const moved =
          !rootPosSet ||
          rootPos[0] !== pose.rootPos[0] ||
          rootPos[1] !== pose.rootPos[1] ||
          rootPos[2] !== pose.rootPos[2];
        if (moved) {
          rootPosSet = true;
          rootPos[0] = pose.rootPos[0];
          rootPos[1] = pose.rootPos[1];
          rootPos[2] = pose.rootPos[2];
          root.position.set(rootPos[0], rootPos[1], rootPos[2]);
        }
      }
      if (pose.bones?.length) {
        // The BACKEND decides whether this moved anything. A converged head aim
        // resends the same quaternions every frame, and an ORL rig has no addressable
        // joints at all and says so by returning false — raising `rigDirty` on either
        // ran trunk + geom + appr + lift on a character that had not changed.
        let moved = false;
        for (const branch of branches) {
          if (branch.setJointOverrides(pose.bones)) moved = true;
        }
        if (moved) rigDirty = true;
      }
    },

    setLookAt(target) {
      const changed = target
        ? !lookAtSet ||
          lookAtTarget.x !== target[0] ||
          lookAtTarget.y !== target[1] ||
          lookAtTarget.z !== target[2]
        : lookAtSet;
      if (target) lookAtTarget.set(target[0], target[1], target[2]);
      lookAtSet = target !== null;
      const space = manifest.expressionSpace;
      if (space.kind === 'gnm' || space.kind === 'gnm68') {
        if (changed) rigDirty = true;
        return;
      }
      // An ARKit bundle reaches the eyes through `CTRL_L/R_eye.t*`, which the ARKit
      // gather does not write: gaze there belongs to the gaze-conditioned eye branch,
      // which owns both the eyeball frames and the head frame a world point has to
      // travel. Say so once rather than silently doing nothing.
      if (!lookAtWarned && target) {
        lookAtWarned = true;
        log(
          '[character] setLookAt needs the gaze-conditioned eye branch or a GNM expression space; ' +
            'this bundle declares neither, so the eyes stay at rest',
        );
      }
    },

    update(_dt, camera) {
      if (isDisposed()) return;
      // BEFORE the local camera reads it. The engine only refreshes matrices inside
      // `renderer.render`, which runs after every character has updated, so
      // `root.matrixWorld` here still describes where the avatar was LAST frame —
      // plücker rays and gaze one frame stale, which under motion is view-dependent
      // shading conditioned on a viewpoint that never existed. Ancestors only
      // (`updateParents = true`, `updateChildren = false`): the splat object under
      // the root has no transform of its own worth walking.
      root.updateWorldMatrix(true, false);
      localCamera.update(camera, root);
      // `cameraMoved` leaves the position it compared in `scratchVec`, so the commit
      // below reads it rather than asking the camera a second time.
      const moved = cameraMoved(localCamera, lastCameraPos, lastCameraQuat, lastFov);
      if (moved) {
        lastCameraPos.x = scratchVec.x;
        lastCameraPos.y = scratchVec.y;
        lastCameraPos.z = scratchVec.z;
        lastCameraQuat.copy(localCamera.quaternion);
        lastFov = localCamera.fov;
        cameraDirty = true;
      }
      if (rigDirty) {
        rigDirty = false;
        cameraDirty = false;
        void pump('full');
      } else if (cameraDirty) {
        cameraDirty = false;
        void pump('appearance');
      }
    },

    async settled() {
      // ONE await of the in-flight run's own promise, replays included. The old loop
      // spun: `pump(...)` resolves the moment a call is parked as the newest pending
      // arguments, so awaiting it while a pass was in flight returned an
      // already-resolved promise and the `while` burned a microtask per turn for the
      // whole length of the pass — and queued an appearance pass to do it.
      await pump.whenIdle();
    },

    memoryReport() {
      const perBranch = branches.map((b) => ({
        name: b.name,
        slots: b.range.count,
        gpuBytes: b.bytes(),
      }));
      return {
        bundleBytes: bundle.byteLength,
        gpuBytes: perBranch.reduce((total, b) => total + b.gpuBytes, 0),
        slots: perBranch.reduce((total, b) => total + b.slots, 0),
        branches: perBranch,
      };
    },

    dispose() {
      if (isDisposed()) return;
      state.disposed = true;
      for (const branch of branches) branch.dispose();
      releaseSlots();
      root.remove(init.sink.object3D);
      init.scene.remove(root);
    },
  };

  return character;
}

const scratchVec = /* @__PURE__ */ new Vector3();
const scratchMatrix = /* @__PURE__ */ new Matrix4();

/**
 * Clamp helper, kept local so the gaze maths reads in one place.
 *
 * @param value The number to bound, a gaze angle in radians at every call site.
 * @param lo The lower bound, returned for anything below it.
 * @param hi The upper bound, returned for anything above it.
 * @returns `value` confined to `[lo, hi]`.
 */
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Anatomically loose gaze limits — enough to stop a bad target rotating an eyeball
 *  into the skull. Anatomically loose on purpose: the clamp guards against a bad
 *  target, it does not model how far a real eye travels.
 */
const MAX_GAZE_YAW = (35 * Math.PI) / 180;
const MAX_GAZE_PITCH = (25 * Math.PI) / 180;

/**
 * Has the camera moved enough to be worth an appearance pass?
 *
 * @param camera This frame's viewer, already in the avatar's local frame.
 * @param lastPos The local-frame position the last appearance pass decoded at.
 * @param lastPos.x Its x, in metres.
 * @param lastPos.y Its y, in metres.
 * @param lastPos.z Its z, in metres.
 * @param lastQuat The local-frame orientation that pass decoded at; compared by dot
 * product, so a turn in place counts even though the position did not change.
 * @param lastFov That pass's vertical field of view, in degrees; any change at all
 * counts.
 * @returns True when the view has moved past the epsilon and the appearance pass —
 * an appr decode plus a lift — is worth re-running.
 */
function cameraMoved(
  camera: LocalFrameCamera,
  lastPos: { x: number; y: number; z: number },
  lastQuat: Quaternion,
  lastFov: number,
): boolean {
  camera.getFramePosition(scratchVec);
  if (
    Math.abs(scratchVec.x - lastPos.x) > CAMERA_EPSILON_METRES ||
    Math.abs(scratchVec.y - lastPos.y) > CAMERA_EPSILON_METRES ||
    Math.abs(scratchVec.z - lastPos.z) > CAMERA_EPSILON_METRES
  ) {
    return true;
  }
  // A turn in place changes every ray while the position does not, which a
  // position-only check misses entirely.
  if (Math.abs(camera.quaternion.dot(lastQuat)) < 1 - CAMERA_EPSILON_QUAT) return true;
  return camera.fov !== lastFov;
}

/**
 * True when a branch must be HANDED a frame rather than fitting its own.
 *
 * @param branch The branch to classify, by its own vertex count.
 * @returns True for a shell branch — eyes or teeth, a decimated stand-in with no
 * correspondence to the pack — which has no fit of its own to make and takes the
 * head's frame instead.
 */
function needsBorrowedFrame(branch: CharacterBranch): boolean {
  return orlDriveMode(branch.neutralVertices.length / 3) === 'shell';
}

/**
 * Build the rig backend for one branch, or null when the bundle declares none.
 *
 * @param manifest The bundle's manifest; its `rig` block picks the backend and
 * supplies the pack filename and control names.
 * @param assets The branch being built, whose neutral vertex count decides the ORL
 * drive mode and whose faces the shell mode needs.
 * @param device The renderer's GPUDevice, which the backend skins on.
 * @param bundle The bundle, for resident bytes and the lazy resolver the pack is
 * read through.
 * @param log Where the neutral-pose explanations go.
 * @returns The initialised backend, or null when the bundle declares no rig, when
 * this branch's vertex count matches no ORL drive mode, when the bundle ships no
 * control names, or when the rig failed to build — every one of which leaves the
 * branch at its neutral pose and says so.
 */
async function buildRigBackend(
  manifest: CharacterBundle['manifest'],
  assets: CharacterBundle['scene']['branches'][number],
  device: GPUDevice,
  bundle: CharacterBundle,
  log: (message: string) => void,
): Promise<RigBackend | null> {
  const rig = manifest.rig;
  if (rig.backend === 'none') return null;
  const verts = assets.mesh.neutralVertices.length / 3;

  if (rig.backend === 'gnm') {
    const backend = new GnmRigBackend({ packFile: rig.pack ?? undefined, log });
    await backend.init({
      device,
      getBytes: (name) => bundle.bytes.getBytes(name),
      fetchBytes: (name) => bundle.resolver(name),
      controlNames: rig.controlNames,
      expectVerts: verts,
    });
    return backend;
  }

  const mode = orlDriveMode(verts);
  if (mode === 'none') {
    // A genuine body, clothes or hair branch has no joints in a `head.dna`. Deliberate,
    // not a fallback: it renders at its neutral pose and says so.
    log(
      `[character] branch '${assets.name}': ${String(verts)} verts is neither head_lod0 nor the eyes/teeth shells — vertices come from its mesh`,
    );
    return null;
  }
  if (!rig.controlNames.length) {
    log(
      `[character] branch '${assets.name}': no control names in the bundle — branch stays at its neutral pose`,
    );
    return null;
  }
  const backend = new OrlRigBackend({
    mode,
    neutralVertices: mode === 'shell' ? assets.mesh.neutralVertices : undefined,
    faces: mode === 'shell' ? assets.mesh.faces : undefined,
    log,
  });
  try {
    await backend.init({
      device,
      getBytes: (name) => bundle.bytes.getBytes(name),
      fetchBytes: (name) => bundle.resolver(name),
      controlNames: rig.controlNames,
      expectVerts: mode === 'skin' ? verts : undefined,
    });
  } catch (e) {
    // Loud, then neutral — never a stub. A rig that will not build is a frozen face,
    // which looks exactly like a hung decoder unless it is reported.
    console.error(
      `[character] branch '${assets.name}': the rig failed to build — branch stays at its neutral pose`,
      e,
    );
    backend.dispose();
    return null;
  }
  return backend;
}

/**
 * Load and install the bundle's baked per-pose anchors, when it ships them.
 *
 * @param bundle The bundle, whose resolver the anchors file is fetched through and
 * whose `numPoses` says how many baked poses to expect.
 * @param rigKind Which rig posed the character, picking the rig-specific anchors
 * filename that is tried before the generic `pose_anchors.json`.
 * @param headBranch The head, whose `neutralRig()` supplies the preset rows the
 * blender interpolates between.
 * @param log Where the one-line "n baked poses from f" report goes.
 * @returns The blender, or null when the bundle declares no poses or ships no anchors
 * file — the normal case, and not an error.
 */
async function loadPoseAnchors(
  bundle: CharacterBundle,
  rigKind: string,
  headBranch: CharacterBranch,
  log: (message: string) => void,
): Promise<PoseAnchorBlender | null> {
  const presets = headBranch.neutralRig();
  const numPoses = bundle.manifest.scene.numPoses;
  if (!numPoses) return null;
  for (const name of [poseAnchorsFileFor(rigKind), 'pose_anchors.json']) {
    try {
      const bytes = await bundle.resolver(name);
      const anchors = parsePoseAnchors(JSON.parse(new TextDecoder().decode(bytes)), {
        rig: rigKind,
        numPoses,
      });
      log(`[character] pose anchors: ${String(anchors.count)} baked poses from ${name}`);
      return createPoseAnchorBlender({
        anchors,
        presets,
        presetRows: anchors.count,
        presetCols: presets.length,
      });
    } catch {
      /* a bundle with no anchors is the normal case */
    }
  }
  return null;
}

/**
 * Tell the sink where this character is.
 *
 * The sink never recomputes bounds from the GPU — reading a million centres back every
 * frame to find a sphere would cost more than the render — so the owner supplies them
 * from the rig's neutral bounds, which bound every pose comfortably.
 *
 * @param sink The sink to tell; it takes the sphere as given and never checks it.
 * @param branches Every branch of this character, whose neutral vertices are unioned
 * into one axis-aligned box in bundle space.
 * @param placement The bundle -> scene transform, whose `worldScale` and offset take
 * that box into the sink's own space.
 */
function setBoundingSphere(
  sink: SplatSink,
  branches: readonly CharacterBranch[],
  placement: LiftPlacement,
): void {
  // `rig/skinMath.ts`'s scan, the same one both rig backends' `vertsAABB` uses —
  // there is no second definition of "the bounds of a packed xyz array" to disagree
  // with this one.
  const box = emptyAabb();
  for (const branch of branches) growAabb(branch.neutralVertices, box);
  if (!Number.isFinite(box.minX)) return;
  const s = placement.worldScale;
  const centre: [number, number, number] = [
    ((box.minX + box.maxX) / 2) * s + placement.worldOffset[0],
    ((box.minY + box.maxY) / 2) * s + placement.worldOffset[1],
    ((box.minZ + box.maxZ) / 2) * s + placement.worldOffset[2],
  ];
  // Half the diagonal, with headroom for the splat extents the neutral bounds do not
  // include — a gaussian reaches past its centre, and an under-tight sphere culls the
  // character at the screen edge.
  const radius =
    0.5 * Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) * s * 1.25;
  sink.setBoundingSphere(centre, radius);
}
