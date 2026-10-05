import {
  Matrix4,
  Vector3,
  type Bone,
  type Object3D,
  type SkinnedMesh,
  type Camera,
  type WebGPURenderer,
} from 'three/webgpu';
import { GnmRigBackend } from '../rig/gnm/GnmRigBackend.js';
import { createFittedArkitMap } from '../expression/arkitFitted.js';
import { createArkitToGnmMap } from '../expression/arkitToGnmDefault.js';
import type { SplatSink, SlotRange } from '../splatSink.js';
import {
  headJointOf,
  parseBindings,
  parseGaussianPly,
  type AosrigSplatBundle,
  type AosrigSplatDescriptor,
  type GaussianPly,
} from './format.js';
import { createSomaPoser } from './soma.js';
import { createAosrigMouth, type AosrigMouth, type AosrigMouthOptions } from './mouthRuntime.js';
import {
  MAX_CORRECTIONS_PLAYED,
  armAngleDeg,
  blendWeight,
  fadedCount,
  newLanes,
  ownLanes,
  parseFade,
  parseSide,
  type CorrectiveDrive,
} from './corrective.js';

import { bandShapes, hiddenLanes, parseMouthHidden, type MouthHidden } from './mouthHidden.js';
import { packGaussianChunk } from './packFast.js';
import { restVertices, type FaceSplats } from './mouth.js';
import { createGnmNode } from '../rig/gnm/gnmNode.js';
import { createTslDeform } from './tslDeform.js';
import { createBoundInputs } from './boundSplatNode.js';

/** The lips' band splats' sizes are capped as the lips part there (kind 3): the node's switch, on. */
const BAND_CAP = 1;

/** The closed mouth's inside points (`mouth_hidden.bin`) while the character draws. */
export interface AosrigMouthHiddenState {
  /** Listed splats, and how many of them are the lip line's plugs and the lips' band. */
  readonly count: number;
  readonly plugs: number;
  readonly band: number;
  /** Fade them (and move the plugs) with the lips' gap. Off, they draw as any other splat. */
  enabled: boolean;
}

/** A character's pose corrections while it draws (`corrective/`, see corrective.ts). */
export interface AosrigCorrectiveState {
  /** The corrections played, in the index's order: name, new splats, own splats that fade. */
  readonly corrections: readonly { name: string; points: number; faded: number }[];
  /**
   * Each drive's arm elevation on the last frame, degrees from hanging: correction 0's left
   * and right, then correction 1's.
   */
  readonly angles: Float32Array;
  /** The weights the GPU was given on the last frame, in the same order. */
  readonly weights: Float32Array;
  /** Play the corrections. Off, every weight is 0: the character draws exactly as one without them. */
  enabled: boolean;
}

/** Splats packed between pauses when a build is given one. */
const PACK_SLICE = 16384;

/**
 * One chunk's records and harmonics, packed in slices with `pause` awaited between them (a build behind a
 * character already on screen), or in one go without it. The same arrays either way.
 *
 * @param ply The parsed PLY.
 * @param bindings The parsed bindings.
 * @param translation `plyToCharacter`.
 * @param start First splat.
 * @param count How many.
 * @param pause Awaited between slices, when given.
 * @returns What `packGaussianChunk` returns.
 */
async function packChunk(
  ply: GaussianPly,
  bindings: Float32Array,
  translation: number[],
  start: number,
  count: number,
  pause?: () => Promise<void>,
): Promise<{ records: Float32Array; sh: Float32Array; shCount: number }> {
  if (!pause) return packGaussianChunk(ply, bindings, translation, start, count);
  const records = new Float32Array(count * 44),
    sh = new Float32Array(Math.max(1, count * ply.shCount));
  let hasSh = false;
  for (let from = 0; from < count; from += PACK_SLICE) {
    const n = Math.min(PACK_SLICE, count - from);
    const part = packGaussianChunk(ply, bindings, translation, start + from, n);
    records.set(part.records, from * 44);
    if (part.shCount > 0) {
      sh.set(part.sh, from * ply.shCount);
      hasSh = true;
    }
    await pause();
  }
  return { records, sh: hasSh ? sh : new Float32Array(1), shCount: hasSh ? ply.shCount : 0 };
}

/**
 * The face's points as the mouth's builder reads them (rest centres, opacities, bindings),
 * over the parsed PLY. A function of its own so the runtime's closures never hold the PLY's
 * view (the whole file's bytes) or the bindings' copy: the object lives only while the
 * mouth is built.
 *
 * @param ply The parsed PLY.
 * @param bindings The parsed bindings.
 * @param shift `plyToCharacter`'s translation.
 * @returns The face, for `createAosrigMouth`.
 */
function faceSplatsOf(ply: GaussianPly, bindings: Float32Array, shift: number[]): FaceSplats {
  const at = (name: string): number => (ply.properties.get(name) ?? 0) * 4;
  const xAt = at('x'),
    yAt = at('y'),
    zAt = at('z'),
    opacityAt = at('opacity');
  return {
    count: bindings.length / 28,
    position(i, out) {
      const o = i * ply.stride;
      out[0] = ply.data.getFloat32(o + xAt, true) + shift[3];
      out[1] = ply.data.getFloat32(o + yAt, true) + shift[7];
      out[2] = ply.data.getFloat32(o + zAt, true) + shift[11];
    },
    opacity(i) {
      return 1 / (1 + Math.exp(-ply.data.getFloat32(i * ply.stride + opacityAt, true)));
    },
    bindings,
  };
}

/**
 * The lips' band splats' own shapes, read from the PLY (see `bandShapes`); a function of its
 * own for the same reason as `faceSplatsOf`.
 *
 * @param hidden The list.
 * @param ply The parsed PLY.
 * @returns Two vec4 per band splat.
 */
function bandShapesOf(hidden: MouthHidden, ply: GaussianPly): Float32Array {
  const lane = (name: string): number => (ply.properties.get(name) ?? 0) * 4;
  const rotAt = [0, 1, 2, 3].map((k) => lane(`rot_${String(k)}`));
  const scaleAt = [0, 1, 2].map((k) => lane(`scale_${String(k)}`));
  return bandShapes(
    hidden,
    (row, out) => {
      for (let k = 0; k < 4; k++) out[k] = ply.data.getFloat32(row * ply.stride + rotAt[k], true);
    },
    (row, out) => {
      for (let k = 0; k < 3; k++)
        out[k] = Math.exp(ply.data.getFloat32(row * ply.stride + scaleAt[k], true));
    },
  );
}

/**
 * Where a character's skin matrices come from: version 1's glTF skeleton, or version 2's
 * skeleton through its poser (which also turns the twist helpers).
 */
interface SkinSource {
  /** The bone of each of the descriptor's joints, in its order. */
  readonly bones: readonly Object3D[];
  /**
   * Write each joint's skin matrix (`inverse(rig) . world . inverse bind`, column-major).
   *
   * @param out 16 floats per joint.
   * @param inverseRig The rig's inverse world, current.
   */
  write(out: Float32Array, inverseRig: Matrix4): void;
}

/**
 * Version 1: the skinned mesh in `rig.glb`, its bones matched to the descriptor's names.
 *
 * @param d The descriptor.
 * @param rig The cloned glTF scene.
 * @returns The skin source.
 */
function glbSkin(d: AosrigSplatDescriptor, rig: Object3D): SkinSource {
  let mesh: SkinnedMesh | undefined;
  rig.traverse((node) => {
    if ((node as Partial<SkinnedMesh>).isSkinnedMesh && !mesh) mesh = node as SkinnedMesh;
  });
  if (!mesh) throw new Error('aosrig-splat: GLB has no skeleton');
  const skeleton = mesh.skeleton;
  const boneIndices = d.jointNames.map((name) => skeleton.bones.findIndex((b) => b.name === name));
  if (boneIndices.some((i) => i < 0))
    throw new Error('aosrig-splat: GLB joint names disagree with bindings');
  const skin = new Matrix4();
  return {
    bones: boneIndices.map((i) => skeleton.bones[i]),
    write(out, inverseRig) {
      for (let j = 0; j < boneIndices.length; j++) {
        const i = boneIndices[j];
        skin
          .multiplyMatrices(inverseRig, skeleton.bones[i].matrixWorld)
          .multiply(skeleton.boneInverses[i]);
        skin.toArray(out, j * 16);
      }
    },
  };
}

/**
 * Version 2: the skeleton's bones under `rig` (`createSomaRig`'s), posed by the package's
 * rule. The poser reads the bones' own rotations and places, so the rig's world is not used.
 *
 * @param bundle The loaded package.
 * @param rig The rig the animator drives.
 * @returns The skin source.
 */
function somaSkin(bundle: AosrigSplatBundle, rig: Object3D): SkinSource {
  const soma = bundle.soma;
  if (!soma) throw new Error('aosrig-splat: a version 2 package without its skeleton');
  const byName = new Map<string, Object3D>();
  rig.traverse((node) => {
    if ((node as Partial<Bone>).isBone && !byName.has(node.name)) byName.set(node.name, node);
  });
  const bones = soma.skeleton.names.map((name) => {
    const bone = byName.get(name);
    if (!bone) throw new Error(`aosrig-splat: the rig has no joint ${name}`);
    return bone;
  });
  const poser = createSomaPoser(soma.skeleton, bones);
  return {
    bones,
    write(out) {
      poser.pose(out);
    },
  };
}

/** A GPU character driven by the engine body animator and GNM expression controls. */
export interface AosrigSplatRuntime {
  /** Native GNM expression mapping used by the body animator's face layer. */
  readonly mapper: ReturnType<typeof createArkitToGnmMap>;
  /**
   * The inside of the mouth (teeth, gums, tongue, and the teeth's own points), when the package
   * carries them, the head pack its mouth and the host asked for it; else null.
   */
  readonly mouth: AosrigMouth | null;
  /** The pose corrections, when the package carries `corrective/`; else null. */
  readonly corrective: AosrigCorrectiveState | null;
  /** The closed mouth's inside points, when the package carries `mouth_hidden.bin`; else null. */
  readonly hiddenPoints: AosrigMouthHiddenState | null;
  /** Pose face, body and splats after AnimationMixer and procedural aim have run. */
  render(expression: Float32Array, gaze: ArrayLike<number>, camera: Camera): void;
  /** Free owned GPU resources and slot range. The caller owns the sink. */
  dispose(): void;
}

/**
 * Bind an animated skeleton to the exported Gaussian cloud: version 2's aosrig-v2 skeleton
 * (`createSomaRig` of the bundle's) or version 1's aosrig_v0 glTF rig.
 *
 * The face and the splats deform in two TSL compute passes (`tslDeform.ts`) that the renderer
 * runs once a frame, on WebGPU or, as transform feedback, on the WebGL2 fallback.
 *
 * @param options Verified export, its rig, the renderer and the splat sink.
 * @param options.bundle The loaded package.
 * @param options.rig The body rig the bindings follow.
 * @param options.sink The splat sink the gaussians are written to (with storage `nodes`).
 * @param options.renderer The renderer that owns the sink; runs the passes.
 * @returns A deformation runtime; call render after the body animator updates.
 * @example
 * ```ts
 * const character = await createAosrigSplat({ bundle, rig, sink, renderer });
 * character.render(expression, [0, 0, 0, 0], camera);
 * ```
 */
export async function createAosrigSplat(options: {
  bundle: AosrigSplatBundle;
  rig: Object3D;
  /** The sink. On WebGL2 it holds this character alone (its every slot is written each frame). */
  sink: SplatSink;
  renderer: WebGPURenderer;
  /** The renderer is on the WebGL2 fallback: transform-feedback compute, PBO reads. */
  webgl?: boolean;
  /** Free a storage attribute's GPU buffers (`@gameable/splat`'s `releaseStorageAttribute`). */
  releaseBuffer?: (attribute: object) => void;
  /**
   * Draw the inside of the mouth when the package carries it: a second sink for the teeth's
   * points. Omit to draw the character without it.
   */
  mouth?: AosrigMouthOptions;
  /**
   * Awaited between slices of the build's main-thread work, so frames keep drawing while a character is
   * built behind one already on screen. Omit to build in one go.
   */
  pause?: () => Promise<void>;
}): Promise<AosrigSplatRuntime> {
  const { bundle, rig, sink, renderer, releaseBuffer } = options,
    d = bundle.descriptor;
  const webgl = options.webgl === true;
  const requiredFile = (name: string): Uint8Array => {
    const bytes = bundle.files.get(name);
    if (!bytes) throw new Error(`aosrig-splat: missing ${name}`);
    return bytes;
  };
  const bindings = parseBindings(requiredFile('bindings.bin'), d);
  const ply = parseGaussianPly(requiredFile('character.ply'), d.splatCount);
  await options.pause?.();
  // The pose corrections: read now so a bad folder is refused before anything is allocated,
  // and never the reason a character does not load.
  const corrections: {
    name: string;
    drives: CorrectiveDrive[];
    fade: Float32Array;
    side: Uint8Array;
    pointsSide: Uint8Array;
    ply: GaussianPly | null;
    bindings: Float32Array | null;
    points: number;
  }[] = [];
  try {
    const listed = bundle.corrective ?? [];
    if (listed.length > MAX_CORRECTIONS_PLAYED)
      console.warn(
        `aosrig-splat: ${String(listed.length)} pose corrections; the engine plays the first ${String(MAX_CORRECTIONS_PLAYED)}`,
      );
    for (const c of listed.slice(0, MAX_CORRECTIONS_PLAYED)) {
      const points = c.info.points;
      corrections.push({
        name: c.info.name,
        drives: c.info.drives,
        fade: parseFade(c.fade, d.splatCount),
        side: parseSide(c.side, d.splatCount),
        pointsSide: parseSide(c.pointsSide, points),
        ply: points > 0 ? parseGaussianPly(c.points, points) : null,
        bindings: points > 0 ? parseBindings(c.bindings, { ...d, splatCount: points }) : null,
        points,
      });
    }
  } catch (error) {
    console.warn('aosrig-splat: the pose corrections are not used:', error);
    corrections.length = 0;
  }
  const extraPoints = corrections.reduce((n, c) => n + c.points, 0);
  // The closed mouth's inside points: the same way, optional and never fatal.
  let hidden: MouthHidden | null = null;
  if (bundle.mouthHidden) {
    try {
      hidden = parseMouthHidden(bundle.mouthHidden, d.splatCount, d.headVertexCount);
    } catch (error) {
      console.warn("aosrig-splat: the closed mouth's inside points are not used:", error);
    }
  }
  const skinSource = d.version === 2 ? somaSkin(bundle, rig) : glbSkin(d, rig);
  const jointBones = skinSource.bones;
  const backend = new GnmRigBackend({
    packFile: 'head.aosrig',
    log: () => undefined,
  });
  let range: SlotRange | undefined;
  let head: ReturnType<typeof createGnmNode> | null = null;
  try {
    await backend.initWithoutDevice({
      getBytes: (n: string) => bundle.files.get(n),
      controlNames: [],
      expectVerts: d.headVertexCount,
    });
    await options.pause?.();
    const headExt = backend.assets.header.headExt;
    let mapper: ReturnType<typeof createArkitToGnmMap> | null = null;
    if (bundle.faceArkit) {
      try {
        mapper = createFittedArkitMap(bundle.faceArkit, headExt);
      } catch (error) {
        console.warn(
          'aosrig-splat: the face table does not fit this head; the stopgap plays:',
          error,
        );
      }
    }
    mapper ??= createArkitToGnmMap(headExt);
    const controls = new Float32Array(mapper.dim);
    const matrices = new Float32Array(128 * 16);
    range = sink.allocate(d.splatCount + extraPoints);
    // On WebGL2 the deformation writes every slot of the sink, the ones outside this character
    // invisible: a sink there holds one character, and one already in it would be blanked.
    if (webgl && range.offset !== 0)
      throw new Error('aosrig-splat: on WebGL2 a sink holds one character; give each its own sink');
    const allocatedRange = range;
    sink.setBoundingSphere(d.bounds.center, d.bounds.radius);
    // Packed in slices of this many splats, so a build behind a character on screen can pause.
    const chunkSize = 262144;
    // The head at rest (for the plugs' moves) and the lips' band splats' own shapes, in one
    // buffer.
    const restHead = new Float32Array(restVertices(backend.assets));
    const bandShape = hidden ? bandShapesOf(hidden, ply) : new Float32Array(8);
    const auxData = new Float32Array(restHead.length + bandShape.length);
    auxData.set(restHead);
    auxData.set(bandShape, restHead.length);
    const bandAt = restHead.length;
    // The node's inputs, allocated once; each chunk goes in as it is packed and is then let go.
    // The harmonics' width is the widest file's (a correction's points may carry fewer).
    const shCount = Math.max(ply.shCount, ...corrections.map((c) => c.ply?.shCount ?? 0));
    const inputs = createBoundInputs(allocatedRange.count, shCount, auxData);
    for (let start = 0; start < d.splatCount; start += chunkSize) {
      const count = Math.min(chunkSize, d.splatCount - start);
      const {
        records,
        sh,
        shCount: chunkSh,
      } = await packChunk(ply, bindings, d.plyToCharacter, start, count, options.pause);
      ownLanes(records, start, count, corrections);
      hiddenLanes(records, start, count, hidden);
      inputs.add(records, sh, chunkSh, count, start);
      await options.pause?.();
    }
    // The corrections' own new splats, after the character's, each shown by its side's weight.
    let extraStart = d.splatCount;
    corrections.forEach((c, index) => {
      if (!c.ply || !c.bindings) return;
      for (let start = 0; start < c.points; start += chunkSize) {
        const count = Math.min(chunkSize, c.points - start);
        const packed = packGaussianChunk(c.ply, c.bindings, d.plyToCharacter, start, count);
        newLanes(packed.records, count, index, c.pointsSide.subarray(start, start + count));
        inputs.add(packed.records, packed.sh, packed.shCount, count, extraStart + start);
      }
      extraStart += c.points;
    });
    head = createGnmNode(backend.assets, webgl);
    const deform = createTslDeform({
      inputs,
      offset: allocatedRange.offset,
      joints: d.jointNames.length,
      bandAt,
      head,
      sink,
      renderer,
      webgl,
      ...(releaseBuffer ? { releaseBuffer } : {}),
    });
    // The arms that drive the corrections: joints as indices, read each frame.
    const drives = corrections.flatMap((c, index) =>
      c.drives.map((drive) => ({
        slot: index * 2 + drive.side,
        upper: jointBones[d.jointNames.indexOf(drive.bone[0])],
        lower: jointBones[d.jointNames.indexOf(drive.bone[1])],
        frame: d.jointNames.indexOf(drive.frame),
        drive,
      })),
    );
    const angles = new Float32Array(4),
      weights = new Float32Array(4);
    const correctionStats = corrections.map((c) => ({
      name: c.name,
      points: c.points,
      faded: fadedCount(c.fade),
    }));
    // The lanes are packed and the drives read: the per-splat arrays and the parsed PLYs go.
    corrections.length = 0;
    const corrective: AosrigCorrectiveState | null = correctionStats.length
      ? {
          corrections: correctionStats,
          angles,
          weights,
          enabled: true,
        }
      : null;
    const upperAt = new Vector3(),
      lowerAt = new Vector3();
    const hiddenPoints: AosrigMouthHiddenState | null = hidden
      ? {
          count: hidden.count,
          plugs: hidden.plugs,
          band: hidden.band,
          enabled: true,
        }
      : null;
    const axes = new Float32Array(8);
    if (hidden) {
      axes.set(hidden.up, 0);
      axes.set(hidden.forward, 4);
    }
    const inverse = new Matrix4(),
      cameraPosition = new Vector3();
    // The mouth's inside: optional, and never the reason a character does not load.
    let mouth: AosrigMouth | null = null;
    const headJoint = d.jointNames.indexOf(headJointOf(d));
    const headSkin = matrices.subarray(headJoint * 16, headJoint * 16 + 16);
    if (options.mouth && bundle.teeth && backend.assets.mouth) {
      try {
        mouth = createAosrigMouth({
          // the head pass's output, which the mouth's own passes read
          head: { attribute: deform.head.outputAttribute, capacity: deform.head.capacity },
          webgl,
          renderer,
          ...(releaseBuffer ? { releaseBuffer } : {}),
          pack: backend.assets,
          teeth: bundle.teeth,
          plyShift: [d.plyToCharacter[3], d.plyToCharacter[7], d.plyToCharacter[11]],
          face: faceSplatsOf(ply, bindings, d.plyToCharacter),
          character: sink,
          options: options.mouth,
        });
      } catch (error) {
        if (options.mouth.onError) options.mouth.onError(error);
        else console.warn('aosrig-splat: the mouth interior was not built:', error);
      }
    }
    let disposed = false;
    return {
      mapper,
      mouth,
      corrective,
      hiddenPoints,
      render(expression, gaze, camera) {
        if (disposed) return;
        controls.fill(0);
        const expressions = backend.assets.header.headExt.exprDim;
        for (let i = 0; i < Math.min(controls.length, expression.length); i++)
          controls[i] = expression[i];
        controls[expressions] += -gaze[0];
        controls[expressions + 1] += gaze[1];
        controls[expressions + 2] += -gaze[2];
        controls[expressions + 3] += gaze[3];
        backend.setControls(controls);
        rig.updateWorldMatrix(true, true);
        inverse.copy(rig.matrixWorld).invert();
        skinSource.write(matrices, inverse);
        // The pose corrections' weights: each arm's elevation, read in its frame joint's rest
        // orientation (the joint's turn since rest is its skin matrix), through the drive's curve.
        if (corrective) {
          weights.fill(0);
          for (const { slot, upper, lower, frame, drive } of drives) {
            upperAt.setFromMatrixPosition(upper.matrixWorld).applyMatrix4(inverse);
            lowerAt.setFromMatrixPosition(lower.matrixWorld).applyMatrix4(inverse);
            const theta = armAngleDeg(
              lowerAt.x - upperAt.x,
              lowerAt.y - upperAt.y,
              lowerAt.z - upperAt.z,
              matrices.subarray(frame * 16, frame * 16 + 16),
            );
            angles[slot] = theta;
            if (corrective.enabled) weights[slot] = blendWeight(theta, drive);
          }
        }
        camera.getWorldPosition(cameraPosition);
        sink.object3D.worldToLocal(cameraPosition);
        const mouthOpen = mouth !== null && mouth.update(controls, headSkin, camera);
        const node = deform.node;
        node.camera.set(cameraPosition.x, cameraPosition.y, cameraPosition.z, 0);
        node.weights.fromArray(weights);
        node.up.set(axes[0], axes[1], axes[2], hiddenPoints?.enabled ? 1 : 0);
        node.forward.set(axes[4], axes[5], axes[6], BAND_CAP);
        node.setBones(matrices);
        deform.head.update(backend.frameValues());
        deform.dispatch();
        sink.markGaussiansChanged();
        if (mouthOpen) {
          // The mouth's passes read the head pass the deformation just ran.
          mouth?.dispatch();
          mouth?.teeth.markGaussiansChanged();
          mouth?.drawOffscreen();
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        mouth?.dispose();
        deform.dispose();
        backend.dispose();
        sink.free(allocatedRange);
      },
    };
  } catch (error) {
    for (const attribute of head?.attributes ?? []) {
      releaseBuffer?.(attribute);
      attribute.dispose();
    }
    backend.dispose();
    if (range) sink.free(range);
    throw error;
  }
}
