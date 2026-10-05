// One clip driving several separately-skinned part GLBs as a single body.
//
// Each part carries its OWN copy of the skeleton, and that is the point: fusing them
// into a union-skeleton rig gives the clip duplicate bone names to bind against, and it
// picks one arbitrarily. Every part binds the same clip by bone name instead, so they
// move together while staying separately addressable.
//
// A part carries only the bones it needs — the face mesh has the spine/neck/head
// chain plus ~840 facial bones, not the fingers — so the clip is filtered per part.
// Binding it unfiltered logs one warning per unresolvable track (310 for the face)
// and drowns the signal these scenes exist to show.
//
// The clip itself is reduced to bone ROTATIONS first (`poseTracksOnly`), which is not an
// optimisation: the MetaHuman clip's `root` quaternion is a 90 degree turn about X that
// lays the whole body on its side.
//
// Ported from aos-threejs-poc/src/lib/partRigDrive.js @ cdd63b10

import { AnimationClip, AnimationMixer, Group, Matrix4 } from 'three/webgpu';
import type { AnimationAction, Object3D, SkinnedMesh } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { BRANCH_PARTS } from './partBranchVertices.js';
import { captureHeadRest, headRigidDelta, type HeadRest } from './headRigidDrive.js';

// Face, body and the three clothing pieces. Derived from the branch map rather than
// listed again: the two would drift, and a part loaded but not mapped to a branch is
// dead weight while a part mapped but not loaded throws.
export const DEFAULT_PART_NAMES: string[] = Object.values(BRANCH_PARTS).flat();

/** One part GLB, as `PartRigDrive` takes it. */
export interface PartScene {
  /** The SOURCE FILE's name, not the loaded mesh's — see the constructor. */
  name: string;
  scene: Object3D;
  mesh?: SkinnedMesh;
}

/** Per-part bookkeeping, for the fit report. */
export interface PartRigPart {
  name: string;
  scene: Object3D;
  mixer: AnimationMixer;
  action: AnimationAction;
  boundTracks: number;
  clipTracks: number;
  bones: number;
  meshes: number;
  vertices: number;
}

/**
 * Node a track drives: `"Armature/pelvis.quaternion"` → `"pelvis"`.
 *
 * @param trackName The clip track's name, path and property joined by a dot.
 * @returns The last path segment before the property, or `null` when the name carries no
 *   property suffix at all.
 */
export function trackTargetName(trackName: string): string | null {
  const dot = trackName.lastIndexOf('.');
  if (dot < 0) return null;
  return trackName.slice(0, dot).split('/').pop() ?? null;
}

// The clip's two transform-carrying roots. `root` holds a 90 degree turn about X — the
// source file's Z-up convention — and `Armature` holds its unit scale; either one applied
// to the skeleton moves the whole body rather than posing it.
const STRIP_TARGETS = new Set(['root', 'Armature']);

/**
 * The clip as a pose: bone ROTATIONS only, none from the transform-carrying roots.
 *
 *  Positions and scales are dropped rather than trusted. A skeleton's pose is its bone
 *  rotations at the rig's own bind offsets, so rotations alone retarget cleanly, while a
 *  position track pins the clip to the units and the root motion of the file it came
 *  from. Same rule as glbVertexDriver and AvatarModel.pruneUnbindableTracks.
 *
 * @param clip The clip as the GLB shipped it.
 * @returns A new clip of the same name and duration carrying only the quaternion tracks,
 *   minus those targeting `root` or `Armature`.
 */
export function poseTracksOnly(clip: AnimationClip): AnimationClip {
  const tracks = clip.tracks.filter((track) => {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0 || track.name.slice(dot + 1) !== 'quaternion') return false;
    return !STRIP_TARGETS.has(trackTargetName(track.name) ?? '');
  });
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Track names split by whether `nodeNames` can resolve their target node.
 *
 * @param trackNames The clip's track names.
 * @param nodeNames Every node name in the part's subtree.
 * @returns The names that resolve and those that do not, each in input order.
 */
export function splitTracksByBinding(
  trackNames: readonly string[],
  nodeNames: ReadonlySet<string>,
): { bound: string[]; unbound: string[] } {
  const bound: string[] = [];
  const unbound: string[] = [];
  for (const trackName of trackNames) {
    const target = trackTargetName(trackName);
    if (target && nodeNames.has(target)) bound.push(trackName);
    else unbound.push(trackName);
  }
  return { bound, unbound };
}

/** A GLB as bytes, so a game resolves it by asset id rather than by URL. */
export type GlbSource = ArrayBuffer | Uint8Array;

/**
 * Parse GLB bytes with `GLTFLoader`, which wants an `ArrayBuffer` of its own.
 *
 * @param bytes The GLB, as a buffer or a view; a view is copied so a shared buffer's other
 *   bytes are not handed to the loader.
 * @returns A promise for the loaded scene root and its animation clips.
 */
function parseGlb(bytes: GlbSource): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buffer =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      buffer,
      '',
      (gltf) => {
        resolve({ scene: gltf.scene, animations: gltf.animations });
      },
      reject,
    );
  });
}

/**
 * Names of every node in `root`'s subtree.
 *
 * @param root The subtree root, itself included.
 * @returns The set of node names, which is what a track target is matched against.
 */
function subtreeNodeNames(root: Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse((object) => names.add(object.name));
  return names;
}

/**
 * Whether `object` is a `SkinnedMesh`.
 *
 *  A guard rather than `(object as SkinnedMesh).isSkinnedMesh`: three types the marker
 *  as the literal `true`, so the cast makes the test always-true and the "not a skinned
 *  mesh" branch — which is every Bone and every Group in the GLB — reads as dead.
 *
 * @param object Any node out of a GLB subtree.
 * @returns Whether its `isSkinnedMesh` marker is set, narrowing the type when it is.
 */
function isSkinnedMesh(object: Object3D): object is SkinnedMesh {
  return (object as Partial<SkinnedMesh>).isSkinnedMesh === true;
}

/**
 * The one skinned mesh a part GLB exists to carry.
 *
 * @param root The part GLB's scene root.
 * @returns The first skinned mesh found in traversal order; throws when there is none.
 */
function partMesh(root: Object3D): SkinnedMesh {
  // A one-element box, not a `let`: `traverse` takes a callback, and TS narrows a
  // closed-over `let` to its initial value for the code AFTER the call.
  const found: SkinnedMesh[] = [];
  root.traverse((object) => {
    if (!found.length && isSkinnedMesh(object)) found.push(object);
  });
  if (!found.length) throw new Error(`partRigDrive: part '${root.name}' has no skinned mesh`);
  return found[0];
}

/**
 * The skinned mesh named `name` anywhere under `root`.
 *
 *  GLTFLoader suffixes a node whose name a sibling already took, so a mesh authored as
 *  `…FaceMesh` can load as `…FaceMesh_1`; match either.
 *
 * @param root The rig GLB's scene root.
 * @param name The part's authored mesh name, without any loader-added `_N` suffix.
 * @returns That skinned mesh; throws when the GLB carries no mesh of that name.
 */
function namedPartMesh(root: Object3D, name: string): SkinnedMesh {
  const found: SkinnedMesh[] = [];
  root.traverse((object) => {
    if (found.length || !isSkinnedMesh(object)) return;
    if (object.name === name || object.name.replace(/_\d+$/, '') === name) {
      found.push(object);
    }
  });
  if (!found.length) throw new Error(`partRigDrive: no skinned mesh '${name}' in the rig GLB`);
  return found[0];
}

/**
 * Bone, mesh and vertex totals for a subtree — the numbers the fit report prints.
 *
 * @param root The subtree to walk, usually one part's skinned mesh.
 * @returns The bone count, the skinned-mesh count, and the summed position-attribute count,
 *   which is CORNERS rather than unique vertices on the non-indexed part geometry.
 */
function countGeometry(root: Object3D): { bones: number; meshes: number; vertices: number } {
  let bones = 0;
  let meshes = 0;
  let vertices = 0;
  root.traverse((object) => {
    if ((object as { isBone?: boolean }).isBone) bones++;
    if (isSkinnedMesh(object)) {
      meshes++;
      vertices += object.geometry.attributes.position.count;
    }
  });
  return { bones, meshes, vertices };
}

/**
 * The subset of `clip` that resolves against `part`, as a clip of its own.
 *
 * @param clip The already pose-reduced clip.
 * @param part The subtree the tracks must bind against.
 * @param name A label for the new clip, defaulting to the part node's own name.
 * @returns A clip named `<clip>@<name>`, same duration, carrying only the bindable tracks —
 *   which is what keeps the mixer from warning once per unresolvable track.
 */
export function clipForPart(
  clip: AnimationClip,
  part: Object3D,
  name: string = part.name,
): AnimationClip {
  const names = subtreeNodeNames(part);
  const { bound } = splitTracksByBinding(
    clip.tracks.map((track) => track.name),
    names,
  );
  const keep = new Set(bound);
  const tracks = clip.tracks.filter((track) => keep.has(track.name));
  return new AnimationClip(`${clip.name}@${name}`, clip.duration, tracks);
}

/**
 * The head rest, or null — a part rig with no head bone still drives every other part.
 *
 * @param scene The first part's scene root, or `undefined` when there are no parts.
 * @returns The captured head rest, or `null` when the subtree carries no `head` node.
 */
function captureHeadRestOrNull(scene: Object3D | undefined): HeadRest | null {
  if (!scene) return null;
  try {
    return captureHeadRest(scene, 'partRigDrive: ');
  } catch {
    return null;
  }
}

/** One clip bound to every part of a rig, played as a single body. */
export class PartRigDrive {
  readonly headRest: HeadRest | null;
  readonly clip: AnimationClip;
  readonly group: Group;
  readonly meshes: Record<string, SkinnedMesh>;
  readonly parts: PartRigPart[];
  readonly mixers: AnimationMixer[];
  readonly scenes: Object3D[];
  private readonly _headDelta: Matrix4;

  /**
   * @param partScenes One entry per part; `name` is the SOURCE FILE's, not the loaded
   *   mesh's — GLTFLoader suffixes a node whose name a mesh already took, and the
   *   branch lookup keys on the file name.
   * @param clip The clip every part binds by bone name; reduced to bone rotations on
   *   the way in, so `this.clip` is the pose actually played.
   */
  constructor(partScenes: PartScene[], clip: AnimationClip) {
    // REST FIRST, before the mixers below pose anything: the hair rides this delta and
    // it is measured from the bind pose its trained neutral belongs to. Absent on a rig
    // with no head bone, which is a rig that simply cannot carry hair.
    this.headRest = captureHeadRestOrNull(partScenes[0]?.scene);
    this._headDelta = new Matrix4();
    this.clip = poseTracksOnly(clip);
    this.group = new Group();
    this.group.name = 'PartRig';
    this.meshes = {};
    // Several parts may share ONE scene — a multi-part rig GLB carries every part over a
    // single bone hierarchy. Then there is one skeleton, one mixer and one action; the
    // per-scene clip filter and the duplicate-bone-name problem both simply don't arise.
    const mixerFor = new Map<
      Object3D,
      { mixer: AnimationMixer; action: AnimationAction; boundTracks: number }
    >();
    this.parts = partScenes.map(({ name, scene, mesh }) => {
      let shared = mixerFor.get(scene);
      if (!shared) {
        const sceneClip = clipForPart(this.clip, scene, scene.name || name);
        const mixer = new AnimationMixer(scene);
        const action = mixer.clipAction(sceneClip);
        action.play();
        this.group.add(scene);
        shared = { mixer, action, boundTracks: sceneClip.tracks.length };
        mixerFor.set(scene, shared);
      }
      this.meshes[name] = mesh ?? partMesh(scene);
      return {
        name,
        scene,
        mixer: shared.mixer,
        action: shared.action,
        boundTracks: shared.boundTracks,
        clipTracks: this.clip.tracks.length,
        ...countGeometry(this.meshes[name]),
      };
    });
    // One update per distinct scene: driving a shared mixer once per part would advance
    // the clock N times a frame and play the dance N times too fast.
    this.mixers = [...mixerFor.values()].map((entry) => entry.mixer);
    this.scenes = [...mixerFor.keys()];
  }

  /**
   * Where the head bone has moved since rest, in the BRANCH frame, at the current pose.
   *  Null when the rig carries no head bone. Reused buffer — copy anything you keep.
   *
   * @returns The rigid delta the hair rides, or `null` when there is no head bone.
   */
  headDelta(): Matrix4 | null {
    return this.headRest ? headRigidDelta(this.headRest, this._headDelta) : null;
  }

  /**
   * Playhead within the clip — the action's looping time, not the mixer's clock.
   *
   * @returns Seconds into the clip, wrapped by the loop; 0 when the rig has no parts.
   */
  get time(): number {
    return this.parts[0]?.action.time ?? 0;
  }

  update(delta: number): void {
    for (const mixer of this.mixers) mixer.update(delta);
    this.refreshBones();
  }

  /**
   * Land the pose at `time` without advancing playback — a scrub, not a step.
   *
   * @param time Seconds into the clip to land on.
   */
  setTime(time: number): void {
    for (const mixer of this.mixers) mixer.setTime(time);
    this.refreshBones();
  }

  /**
   * Push the mixer's new bone LOCALS out to their world matrices.
   *
   *  Not optional and not a render concern: the mixer writes bone position/quaternion,
   *  while `applyBoneTransform` reads `bone.matrixWorld`. Skip this and every vertex comes
   *  back at its bind position forever — the clip's clock advances and the body does not
   *  move. A rig that happens to be mounted in a rendered scene gets this for free from
   *  three's own traversal, which is exactly why relying on that hides the bug until the
   *  first caller drives an unmounted rig.
   */
  refreshBones(): void {
    // NOT `updateMatrixWorld(true)`. Every bone here has `matrixAutoUpdate` on, so
    // the plain walk already recomposes each local matrix and marks its world matrix
    // stale by itself — `force` adds nothing but a second unconditional recompose of
    // every node in the subtree, every frame, on a whole body skeleton.
    for (const scene of this.scenes) scene.updateMatrixWorld();
  }

  dispose(): void {
    for (const mixer of this.mixers) mixer.stopAllAction();
    for (const scene of this.scenes) {
      for (const mixer of this.mixers) mixer.uncacheRoot(scene);
    }
  }
}

/**
 * Load ONE multi-part rig GLB plus a clip GLB into a drivable rig.
 *
 *  This is the bundle's own layout: `rig.glb` holds one skinned mesh per body part over a
 *  SINGLE bone hierarchy, so the clip binds by bone name with nothing ambiguous to
 *  resolve. `partNames` is what the branch map expects to find, and a name the GLB does
 *  not carry throws rather than driving a body with a piece missing.
 *
 * @param rigGlb `rig.glb` as bytes.
 * @param clipGlb The clip GLB as bytes; its FIRST animation is the one bound, and a GLB with
 *   none throws.
 * @param partNames Which meshes to pull out of the rig GLB, defaulting to every part the
 *   branch map names.
 * @returns The drivable rig: one mixer over the shared scene, with each part's mesh keyed by
 *   its file name for the branch scatter.
 */
export async function loadPartRigFromGlb(
  rigGlb: GlbSource,
  clipGlb: GlbSource,
  partNames: string[] = DEFAULT_PART_NAMES,
): Promise<PartRigDrive> {
  const [rig, clipGltf] = await Promise.all([parseGlb(rigGlb), parseGlb(clipGlb)]);
  if (clipGltf.animations.length === 0) {
    throw new Error('partRigDrive: the clip GLB carries no animation clip');
  }
  const clip = clipGltf.animations[0];
  const parts = partNames.map((name) => ({
    name,
    scene: rig.scene,
    mesh: namedPartMesh(rig.scene, name),
  }));
  return new PartRigDrive(parts, clip);
}
