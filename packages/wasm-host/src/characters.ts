/**
 * The character bridge: the guest's `spawn-character` family, wired to real
 * splat heads.
 *
 * **Why this is its own module.** `engineAdapter.ts` reaches every host module
 * through `engine.get(...)` and imports their types `type`-only, so a game that
 * leaves a module out gets a warning instead of a crash. The character stack is
 * different: `gameable/character` pulls in `onnxruntime-web` and
 * `gameable/splat` pulls in the animated splat fork, and making `wasm-host`
 * depend on either at runtime would put megabytes into every game that never
 * spawns a character. So this file is the **optional** half of the package —
 * `gameable/host/characters` — and the adapter only ever names
 * {@link CharacterBridge}, which is a type and disappears at compile time.
 * Importing this module is the opt-in.
 *
 * **Four paths, chosen by the manifest's `rig.backend`.**
 *
 * - `skinned` — a glTF/GLB with `JOINTS_0`/`WEIGHTS_0` and its clips embedded.
 *   One parse per URL, `SkeletonUtils.clone` per character, an
 *   `AnimationMixer` on top. No WebGPU, no decoder, no baked pack: this is the
 *   path a whole body takes, and the only one that draws on the WebGL
 *   fallback.
 * - `aosrig-splat` — a character the Gameable studio exported: its package
 *   (`loadAosrigSplatBundle`), its body skeleton and clips on the same animator
 *   as `skinned`, its splats built by `buildAosrigCharacter` and posed each
 *   frame, and shadows from its body mesh. On WebGPU and the WebGL2 fallback.
 * - `gnm` — a head. `GnmRigBackend` plus `createRigPreview` puts one gaussian
 *   on every vertex and poses them on the GPU every frame. It is a debug
 *   renderer and it looks like one — a point cloud tinted by skinning joint —
 *   but it is the real rig, driven by the real animator, from the real
 *   commands.
 * - `bundle` — the decoder path, meshes plus geometry and appearance ONNX
 *   branches plus a calibration, through `createCharacter`. Off by default; no
 *   bundle in this repository has branches yet.
 *
 * **Where a frame goes.**
 *
 * ```text
 * set-character-state ─┐
 * set-clip-weights ────┤
 * set-expression ──────┼─► CharacterState ─► Animator.update(dt, { bodyYaw })
 * look-at ─────────────┘                            │
 *                                 skinned ◄─────────┼─────────► gnm
 *                                    │                            │
 *                     .jointOverrides onto           .expression ─┐
 *                        three's live bones          .gaze ───────┤
 *                                    │                            ▼
 *                        AnimationMixer already     GnmRigBackend.setControls()
 *                        posed the skeleton                       │
 *                                    │                 RigPreview.render()
 *                                    ▼                            │
 *                            SkinnedMesh draws        AnimatedSplat gaussians
 * ```
 */
// `gameable/character` and `gameable/splat` are named type-only here: the first pulls in
// `onnxruntime-web` and the second the animated splat fork, and naming either at the top level would
// put both in the eager chunk of every game that imports this module. The dynamic `import()`s in the
// boot paths are the only runtime references.
import {
  createAnimator,
  type Animator,
  type AnimatorUpdateContext,
  type SkeletonNames,
} from '@gameable/animation';
import {
  Group,
  Matrix3,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh as SkinnedMeshObject,
  Vector3,
} from 'three/webgpu';
import type { AnimationClip, Bone, Material, Mesh, SkinnedMesh } from 'three/webgpu';
import type { Entity } from '@gameable/sdk';
import type { AosrigSplatBundle, SomaSkeleton } from '@gameable/character';
import type {
  AnimatedGaussianSplat,
  KeyLightEstimate,
  ShadowPlace,
  ShadowQuality,
  SplatService,
  SplatShadows,
} from '@gameable/splat';
import {
  type SkeletonProfile,
  SOMA_PROFILE,
  profileFor,
  aosMetaOf,
  locomotionIndexOf,
} from './characters/profiles.js';
import type {
  SkinnedGltf,
  CharacterBridgeOptions,
  CharacterShadows,
  CharacterBridge,
} from './characters/types.js';
import type { MutableJointOverride, AimBone, LiveCharacter } from './characters/live.js';
import { stepFade, upgradeCharacter } from './characters/upgrade.js';
import {
  defaultLoadGltf,
  loadSkeletonUtils,
  yawOf,
  passThrough,
  resolveSibling,
  fileNameOf,
} from './characters/util.js';

export { aosMetaOf, locomotionIndexOf } from './characters/profiles.js';
export type {
  SkinnedGltf,
  CharacterBridgeOptions,
  CharacterShadows,
  CharacterSpawnRequest,
  CharacterBridgeEntry,
  CharacterPath,
  CharacterBridge,
  CharacterUpgradeOptions,
} from './characters/types.js';

/** Gaussians reserved per character. One per head vertex, with room to spare. */
const DEFAULT_CAPACITY = 32_768;

/**
 * How far above the entity's own origin the head sits, in metres.
 *
 * An entity's transform is its physics body's centre, and a capsule's centre is
 * roughly its navel. Sixty centimetres up is where a head goes on a 1.8 m
 * humanoid; a game with other proportions passes its own.
 */
const DEFAULT_HEAD_OFFSET: readonly [number, number, number] = [0, 0.6, 0];

/** Object-space height the head is fitted to, in metres. */
const DEFAULT_HEAD_HEIGHT = 0.35;

/** ARKit-52 is the one expression space a guest may send that is not the bundle's. */
const ARKIT_COUNT = 52;

/** Reused for reading a character's facing; nothing here allocates per frame. */
const scratchQuaternion = new Quaternion();

/** Reused for the head-aim override premultiply on the skinned path. */
const scratchDelta = new Quaternion();

/**
 * The one `BodyPose` the decoder path hands over, rewritten per character.
 *
 * `Character.setBodyPose` reads it synchronously and keeps nothing, so one object
 * serves every character and every frame.
 */
const scratchBodyPose: { bones: readonly MutableJointOverride[] } = { bones: [] };

/**
 * The pooled body pose, pointed at `joints`.
 *
 * @param joints This character's override records.
 *
 * @returns The shared pose object. Valid until the next call.
 */
function bodyPoseScratch(joints: readonly MutableJointOverride[]): {
  bones: readonly MutableJointOverride[];
} {
  scratchBodyPose.bones = joints;
  return scratchBodyPose;
}

/**
 * Build a character bridge.
 *
 * Hand the result to `createEngineAdapter` as `{ characters: bridge }` and the
 * six character commands stop being no-ops.
 *
 * @param options Engine, renderer, scene and capacity.
 *
 * @returns The bridge. Nothing loads until the first `spawn-character`.
 *
 * @example
 * ```ts
 * import { createEngineAdapter } from 'gameable/host';
 * import { createCharacterBridge } from 'gameable/host/characters';
 *
 * const characters = createCharacterBridge({
 *   engine,
 *   renderer: engine.renderer,
 *   scene: engine.scene,
 * });
 * const adapter = createEngineAdapter(engine, { modules, characters });
 * ```
 */
export function createCharacterBridge(options: CharacterBridgeOptions): CharacterBridge {
  const { engine } = options;
  const renderer = options.renderer ?? engine.renderer;
  const fallbackParent = options.scene ?? engine.scene;
  const capacity = options.capacityPerCharacter ?? DEFAULT_CAPACITY;
  const headOffset = options.headOffset ?? DEFAULT_HEAD_OFFSET;
  const headHeight = options.headHeight ?? DEFAULT_HEAD_HEIGHT;
  const useDecoders = options.decoders ?? false;
  const loadGltf = options.loadGltf ?? defaultLoadGltf;

  /**
   * One parse per URL, however many characters share the file.
   *
   * The PROMISE is cached, not the result: three spawns in one frame all find
   * the same in-flight load rather than starting three of them.
   */
  const parsed = new Map<string, Promise<SkinnedGltf>>();

  const warned = new Set<string>();
  const warnSink =
    options.warn ??
    ((message: string): void => {
      console.warn(message);
    });
  const logSink =
    options.log ??
    ((message: string): void => {
      console.log(message);
    });

  /**
   * Warn once per distinct message.
   *
   * @param message What went wrong.
   *
   * @returns Nothing.
   */
  /**
   * A character's own load failed for good: warn, and tell the host on its own channel.
   *
   * @param character The character that stays a placeholder.
   * @param message What happened.
   * @returns Nothing.
   */
  function loadFailed(character: { entity: Entity; bundleId: string }, message: string): void {
    warn(message);
    options.onLoadFailed?.({ entity: character.entity, bundleId: character.bundleId, message });
  }

  function warn(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    warnSink(message);
  }

  const live = new Map<Entity, LiveCharacter>();
  const restOrientations = new Map<Entity, Map<string, Quaternion>>();
  const attachments = new Map<Entity, { body: Entity; hidden: Object3D[] }>();
  /** The same records as an array, so `update` iterates without an iterator. */
  const order: LiveCharacter[] = [];

  // `caps.characters` is false on the WebGL fallback, where the compute pass the
  // rig runs on does not exist. Degrade, never throw: a game opened on a machine
  // without WebGPU should still be playable with capsules.
  const available = engine.ctx.caps.characters;
  // An exported character's passes are TSL: on the WebGL fallback three runs them as transform
  // feedback, and gameable/splat sorts its gaussians on the CPU.
  const webgl = !engine.ctx.caps.webgpu;
  // Whether an exported character was loaded: its shared clip pack is let go on dispose.
  let exportedLoaded = false;
  if (!available) {
    warn(
      'gameable: splat characters (rig backend "gnm" or "orl") need WebGPU and this renderer ' +
        'is on the WebGL fallback, so they keep their placeholders. Skinned glTF characters ' +
        '(backend "skinned") still draw.',
    );
  }

  // Shadows start with the first exported character (the splat package is imported then);
  // until then the facade keeps what the host asked for.
  const shadowsWanted = options.shadows !== false && available;
  let shadowSystem: SplatShadows | null = null;
  let shadowQuality: ShadowQuality | 'auto' =
    options.shadows === false ? 'off' : (options.shadows ?? 'auto');
  const shadowPlaces = new Map<AnimatedGaussianSplat, ShadowPlace>();
  let shadowLight: KeyLightEstimate | null = null;
  let serviceSeen = 0;
  let splatService: SplatService | null | undefined;
  const shadows: CharacterShadows = {
    get quality() {
      if (!shadowsWanted) return 'off';
      return shadowSystem?.quality ?? (shadowQuality === 'auto' ? 'off' : shadowQuality);
    },
    get info() {
      return shadowSystem?.info ?? null;
    },
    setQuality(quality) {
      if (!shadowsWanted) return;
      shadowQuality = quality;
      shadowSystem?.setQuality(quality);
    },
    addPlace(splat, place = {}) {
      if (!shadowsWanted) return;
      shadowPlaces.set(splat, place);
      shadowSystem?.addPlace(splat, place);
    },
    removePlace(splat) {
      shadowPlaces.delete(splat);
      shadowSystem?.removePlace(splat);
    },
    setKeyLight(light) {
      shadowLight = light;
      shadowSystem?.setKeyLight(light);
    },
  };

  /**
   * The shadow system, started the first time an exported character is ready.
   *
   * @param splatModule The splat package, already imported by the caller.
   * @returns The system, or null when shadows are off.
   */
  function startShadows(splatModule: typeof import('@gameable/splat')): SplatShadows | null {
    if (!shadowsWanted) return null;
    if (shadowSystem) return shadowSystem;
    // A splat build without shadows (an older package, a test double) simply has none.
    if (typeof splatModule.createSplatShadows !== 'function') return null;
    shadowSystem = splatModule.createSplatShadows(renderer, fallbackParent, {
      quality: shadowQuality,
    });
    for (const [splat, place] of shadowPlaces) shadowSystem.addPlace(splat, place);
    if (shadowLight) shadowSystem.setKeyLight(shadowLight);
    return shadowSystem;
  }

  /**
   * Places the splat service put in the scene since the last look: each receives.
   *
   * @returns Nothing.
   */
  function findServicePlaces(): void {
    if (!shadowSystem) return;
    if (splatService === undefined) {
      try {
        splatService = engine.get('splat');
      } catch {
        splatService = null;
      }
    }
    const added = splatService?.added;
    if (!added || added.length === serviceSeen) return;
    for (let i = serviceSeen; i < added.length; i += 1) {
      const object = added[i] as Partial<AnimatedGaussianSplat>;
      if (
        typeof object.setShadowReceiver !== 'function' ||
        shadowPlaces.has(added[i] as AnimatedGaussianSplat)
      )
        continue;
      shadows.addPlace(added[i] as AnimatedGaussianSplat);
    }
    serviceSeen = added.length;
  }

  /**
   * The rig mesh at rest, in the character's space (where the package's gaussians rest).
   *
   * @param rig The cloned rig.
   * @returns Positions and normals of every skinned mesh.
   */
  function rigSurfaceOf(rig: Object3D): { positions: Float32Array; normals: Float32Array } {
    const positions: number[] = [];
    const normals: number[] = [];
    const point = new Vector3();
    const normal = new Vector3();
    const normalMatrix = new Matrix3();
    rig.traverse((node) => {
      const mesh = node as Partial<SkinnedMesh>;
      if (mesh.isSkinnedMesh !== true || !mesh.geometry || !mesh.bindMatrix) return;
      if (!mesh.geometry.hasAttribute('normal')) return;
      const p = mesh.geometry.getAttribute('position');
      const n = mesh.geometry.getAttribute('normal');
      normalMatrix.getNormalMatrix(mesh.bindMatrix);
      for (let v = 0; v < p.count; v += 1) {
        point.fromBufferAttribute(p, v).applyMatrix4(mesh.bindMatrix);
        normal.fromBufferAttribute(n, v).applyMatrix3(normalMatrix).normalize();
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
      }
    });
    return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
  }

  /**
   * Give a HEAD-only character its animator, now that the expression space is
   * known.
   *
   * The skinned path does not use this: it has a real skeleton to hand the
   * animator, so it needs neither the synthetic neck chain built below nor an
   * expression space that is anything but ARKit-52.
   *
   * @param character The record.
   * @param dim Channels in the bundle's expression vector.
   * @param map ARKit-52 into that space, or null for an ARKit-52 bundle.
   *
   * @returns Nothing.
   */
  function makeHeadAnimator(
    character: LiveCharacter,
    dim: number,
    map: ((arkit: Float32Array, out: Float32Array) => void) | null,
  ): void {
    character.native = new Float32Array(dim);
    const animator = createAnimator({
      root: character.root,
      expressionSpace:
        map === null ? { kind: 'arkit52', dim: ARKIT_COUNT } : { kind: 'gnm', dim, map },
    });
    character.animator = animator;

    // Head aim looks its joints up by name under the root every frame, and a
    // rig-only character has no skeleton for it to find — so give it one. The
    // chain carries no offsets: the aim wants orientations, and the head's
    // world POSITION is the root's, which is already where the head is.
    let chain: Object3D = character.root;
    for (const joint of animator.jointOverrides.keys()) {
      const bone = new Object3D();
      bone.name = joint;
      chain.add(bone);
      chain = bone;
    }

    // Everything the guest has already said applies from the very first frame.
    animator.setState(character.state);
  }

  /**
   * The rig path: an `.aosrig` pack, a backend, a sink and a debug lift.
   *
   * @param character The record being filled in.
   * @param pack The manifest's `rig.pack`, relative to the entry's directory.
   * @param src The manifest `src`, used when the registry resolves no URL.
   *
   * @returns Resolves once the head draws, or falls back.
   */
  async function bootGnm(character: LiveCharacter, pack: string, src: string): Promise<void> {
    if (pack === '') {
      warn(
        `gameable: character "${character.bundleId}" says backend "gnm" but names no ` +
          '`rig.pack`; the placeholder stays.',
      );
      return;
    }
    const packUrl = resolveSibling(engine.assets.url(character.bundleId) ?? src, pack);
    const packFile = fileNameOf(packUrl);

    try {
      // Both halves of the heavy stack, loaded only now. Same rationale as
      // `bootBundle`: creating the bridge should cost an `AnimationMixer`, not
      // 646 KB of splat fork plus the ONNX runtime, for a game whose characters
      // are all skinned bodies.
      const [
        { createArkitToGnmMap, createRigPreview, GnmRigBackend, jointTint, prepareLiftDevice },
        { createAnimatedSplat },
      ] = await Promise.all([import('@gameable/character'), import('@gameable/splat')]);
      if (cancelled(character)) return;

      // The renderer owns the device; this borrows it and checks the one limit
      // the lift needs. It throws `CharacterUnsupportedError` on WebGL.
      const device = prepareLiftDevice(renderer);
      const response = await fetch(packUrl);
      if (!response.ok) throw new Error(`${packUrl}: HTTP ${String(response.status)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cancelled(character)) return;

      const backend = new GnmRigBackend({ packFile });
      await backend.init({
        device,
        // The pack is the only file this path needs, and it is already here.
        getBytes: (wanted) => (wanted === packFile ? bytes : undefined),
        controlNames: [],
      });
      if (cancelled(character)) {
        backend.dispose();
        return;
      }

      const sink = await createAnimatedSplat(renderer, { capacity });
      if (cancelled(character)) {
        backend.dispose();
        sink.dispose();
        return;
      }
      character.sink = sink;
      character.holder.add(sink.object3D);

      const assets = backend.assets;
      const preview = await createRigPreview({
        device,
        sink,
        backend,
        // Region colour, not appearance: this is the debug renderer and it
        // should never be mistaken for a finished character.
        tint: jointTint(assets),
        height: headHeight,
      });
      if (cancelled(character)) {
        preview.dispose();
        return;
      }
      character.preview = preview;
      character.kind = 'gnm-rig';

      const layout = assets.header.headExt;
      const mapper = createArkitToGnmMap(layout);
      character.controls = new Float32Array(layout.dim);
      character.gazeOffset = layout.gazeDim >= 4 ? layout.exprDim : -1;
      makeHeadAnimator(character, mapper.dim, mapper.map);
      character.joints = jointOverridesFor(character);

      character.ready = true;
      character.onAttached?.();
    } catch (cause) {
      loadFailed(
        character,
        `gameable: the GNM rig for "${character.bundleId}" (${packUrl}) did not load ` +
          `(${String(cause)}); the placeholder stays.`,
      );
    }
  }

  /**
   * Parse a glTF once, however many characters spawn from it.
   *
   * @param url The resolved URL.
   *
   * @returns The shared parse promise.
   */
  function loadGltfCached(url: string): Promise<SkinnedGltf> {
    let pending = parsed.get(url);
    if (pending === undefined) {
      pending = loadGltf(url);
      parsed.set(url, pending);
    }
    return pending;
  }

  /** Release geometry owned by a verified, per-instance export GLB. */
  function disposeOwnedRig(character: LiveCharacter): void {
    if (!character.ownsRig || !character.rig) return;
    const geometries = new Set<SkinnedMesh['geometry']>();
    const materials = new Set<Material>();
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    character.rig.traverse((node) => {
      const mesh = node as Partial<SkinnedMesh>;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material)
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          materials.add(material);
      if (mesh.skeleton) skeletons.add(mesh.skeleton);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
    character.rig.removeFromParent();
    character.ownsRig = false;
  }

  /**
   * The skinned path: a glTF body with its clips inside it.
   *
   * This is the path that needs no WebGPU, no decoder and no baked pack — one
   * `SkeletonUtils.clone` per character over a single parse, an
   * `AnimationMixer` per character, and the animator on top.
   *
   * @param character The record being filled in.
   * @param src The manifest `src`, used when the registry resolves no URL.
   * @param exported An exported package, drawn as its splats over this body.
   * @param body A body already built (an exported package's version 2 skeleton and clips):
   *   no glTF is loaded, and the rig has no mesh of its own.
   * @param body.rig The rig the animator drives.
   * @param body.animations Its clips.
   * @param body.profile Its bone names for the animator and the head aim.
   *
   * @returns Resolves once the body draws, or falls back.
   */
  async function bootSkinned(
    character: LiveCharacter,
    src: string,
    exported?: AosrigSplatBundle,
    body?: { rig: Object3D; animations: readonly AnimationClip[]; profile: SkeletonProfile },
  ): Promise<void> {
    const url = exported ? src : (engine.assets.url(character.bundleId) ?? src);
    try {
      let rig: Object3D;
      let animations: readonly AnimationClip[];
      if (body) {
        rig = body.rig;
        animations = body.animations;
      } else {
        const gltf = await loadGltfCached(url);
        if (cancelled(character)) return;
        // `Object3D.clone` would give every copy of the body the FIRST one's
        // skeleton; `SkeletonUtils.clone` rebinds each clone to its own bones and
        // shares the geometry and the materials by reference, which is the whole
        // reason three spawns cost one parse and one buffer upload.
        const skeletonUtils = await loadSkeletonUtils();
        if (cancelled(character)) return;
        rig = skeletonUtils.clone(gltf.scene);
        animations = gltf.animations;
      }

      let skinned = 0;
      rig.traverse((node) => {
        if ((node as Partial<SkinnedMesh>).isSkinnedMesh !== true) return;
        skinned += 1;
        // Bind-pose bounds, not posed bounds: a raised arm or a lean reaches
        // outside the box three culls against and the whole body blinks out.
        node.frustumCulled = false;
        if (exported) node.visible = false;
      });
      if (skinned === 0 && !body) {
        warn(
          `gameable: the character glTF for "${character.bundleId}" (${url}) has no skinned ` +
            'mesh, so there is nothing for an animator to drive; the placeholder stays. A ' +
            '`rig: { backend: "skinned" }` entry must point at a GLB with JOINTS_0/WEIGHTS_0.',
        );
        return;
      }

      // Feet on the floor. The holder carries the head offset for every other
      // path; a body's own origin is between its feet, so it wants the ground
      // offset instead of it, not on top of it.
      character.holder.position.set(
        character.local[0],
        character.local[1] + character.groundOffset,
        character.local[2],
      );
      character.holder.add(rig);
      character.rig = rig;
      character.ownsRig = exported !== undefined;
      // Capture MODEL-space rest orientation before the animator changes it.
      const rest = new Map<string, Quaternion>();
      const visit = (node: Object3D, parent: Quaternion): void => {
        const rotation = parent.clone().multiply(node.quaternion);
        rest.set(node.name, rotation);
        for (const child of node.children) visit(child, rotation);
      };
      visit(rig, new Quaternion());
      restOrientations.set(character.entity, rest);

      const profile = body?.profile ?? profileFor(rig);
      character.profile = profile;
      let locomotion = locomotionIndexOf(animations, url);
      // A walk blend with no standing clip walks in place when the character stands still (the
      // blend's slowest clip plays at its slowest), so a built body's blend needs a clip tagged
      // as locomotion at speed 0. Version 1's rig always carried one (`idle`).
      if (body && locomotion !== null && !locomotion.clips.some((clip) => clip.speed === 0))
        locomotion = null;
      // Said, never warned, for a built body: its package carries no walk blend yet, as its
      // format says, and a host that treats a warning as a failure must not refuse it for that.
      if (locomotion === null && body)
        logSink(
          `gameable: the character "${character.bundleId}" has no standing clip tagged as ` +
            'locomotion (speed 0), so `set-character-state` cannot blend walk and run. The ' +
            'clips still play through `set-clip-weights`.',
        );
      else if (locomotion === null) {
        warn(
          `gameable: the character glTF for "${character.bundleId}" (${url}) has no animation ` +
            'tagged `extras.aos.locomotion`, so `set-character-state` cannot blend walk and ' +
            'run. The clips still play through `set-clip-weights`.',
        );
      }

      if (exported) {
        const [characterModule, splatModule] = await Promise.all([
          import('@gameable/character'),
          import('@gameable/splat'),
        ]);
        const { buildAosrigCharacter, yieldingPause } = characterModule;
        const { createAnimatedSplat, releaseStorageAttribute } = splatModule;
        if (cancelled(character)) return;
        // The export's colours (sRGB unless its descriptor says otherwise) and the studio's kernel,
        // and the inside of the mouth when the package carries the teeth's points (seen through
        // the lips' opening, a soft mask the mouth renders for itself).
        const built = await buildAosrigCharacter({
          bundle: exported,
          rig,
          renderer,
          webgl,
          mouth: true,
          pause: yieldingPause(),
          makeSink: (request) => createAnimatedSplat(renderer, request),
          releaseBuffer: (attribute) => {
            releaseStorageAttribute(renderer, attribute);
          },
          onMouthError: (error) => {
            console.warn(
              `gameable: character "${character.bundleId}" draws without its mouth interior: ${String(error)}`,
            );
          },
        });
        const runtime = built.runtime;
        character.sink = built.sink;
        character.teethSink = built.teethSink;
        character.holder.add(built.sink.object3D);
        // The light the character was captured under, read once while its bytes are here
        // (tens of milliseconds): the shadows' direction when no place says otherwise.
        if (
          shadowsWanted &&
          typeof splatModule.estimateKeyLightFromSurfels === 'function' &&
          typeof characterModule.capturedLightSamples === 'function'
        ) {
          try {
            const samples = characterModule.capturedLightSamples(exported, rigSurfaceOf(rig));
            character.capturedLight = splatModule.estimateKeyLightFromSurfels(samples);
          } catch (cause) {
            warn(
              `gameable: character "${character.bundleId}" could not read the light it was ` +
                `captured under (${String(cause)}); its shadows use the default light.`,
            );
          }
        }
        // The GPU has everything now: the package's bytes (the PLY, the bindings, the head
        // pack, the mouth's and the corrections' files) are not kept, nor the parsed clips
        // (the animator holds them as tracks), except the head and the skeleton when a fuller
        // copy of the same character may follow.
        if (options.extras?.keepSharedFiles && exported.shared)
          character.sharedFiles = exported.shared;
        exported.files.clear();
        delete exported.soma;
        delete exported.teeth;
        delete exported.corrective;
        delete exported.mouthHidden;
        if (cancelled(character)) {
          runtime.dispose();
          return;
        }
        character.boundSplats = runtime;
        rig.traverse((node) => {
          if ((node as Partial<Mesh>).isMesh) node.visible = false;
        });
      }
      const faceMapper = character.boundSplats?.mapper;
      const bones: SkeletonNames = { root: profile.root, head: profile.head };
      const animator = createAnimator({
        root: rig,
        expressionSpace: faceMapper
          ? { kind: 'gnm', dim: faceMapper.dim, map: faceMapper.map }
          : { kind: 'arkit52', dim: ARKIT_COUNT },
        locomotion: locomotion ?? undefined,
        bones,
        headAim: { joints: profile.headAim },
      });
      character.animator = animator;
      character.native = new Float32Array(faceMapper?.dim ?? ARKIT_COUNT);

      for (const clip of animations) {
        animator.addClip(clip.name, clip, { loop: aosMetaOf(clip).loop });
        character.clips.push(clip.name);
      }

      // Resolved once. `update` runs this list every frame and a
      // `getObjectByName` per aimed joint per character per frame is the one
      // graph walk a 114-bone body cannot afford.
      const aimBones: AimBone[] = [];
      for (const [joint] of profile.headAim) {
        const bone = rig.getObjectByName(joint);
        if (bone === undefined) continue;
        aimBones.push({
          joint,
          bone: bone as Bone,
          base: new Quaternion(),
          applied: new Quaternion(),
        });
      }
      character.aimBones = aimBones;

      // Everything the guest has already said applies from the very first frame.
      animator.setState(character.state);
      character.kind = exported ? 'aosrig-splat' : 'skinned';
      character.ready = true;
      if (exported && character.sink) {
        const splatModule = await import('@gameable/splat');
        if (cancelled(character)) return;
        const bounds = exported.descriptor.bounds;
        // Shadows are a finish, never a condition: a failure here leaves the character drawn.
        try {
          startShadows(splatModule)?.addCharacter(character, {
            rig,
            holder: character.holder,
            splat: character.sink.splat,
            radius: bounds.radius + Math.hypot(bounds.center[0], bounds.center[2]) + 0.1,
            headBone: profile.head,
            ...(profile.feet ? { footBones: profile.feet } : {}),
            captured: character.capturedLight ?? null,
          });
        } catch (cause) {
          warn(
            `gameable: character "${character.bundleId}" draws without shadows (${String(cause)}).`,
          );
        }
      }
      character.onAttached?.();
    } catch (cause) {
      if (exported) {
        character.boundSplats?.dispose();
        character.boundSplats = undefined;
        character.teethSink?.dispose();
        character.teethSink = null;
        character.sink?.dispose();
        character.sink = null;
        disposeOwnedRig(character);
        character.ready = false;
      }
      loadFailed(
        character,
        `gameable: the character ${body ? 'package' : 'glTF'} for "${character.bundleId}" ` +
          `(${url}) did not load (${String(cause)}); the placeholder stays.`,
      );
    }
  }

  /**
   * The decoder path: a full bundle through `createCharacter`.
   *
   * Off by default — see {@link CharacterBridgeOptions.decoders}. No bundle in
   * this repository has branches yet, so this path has never run against real
   * bytes; it is here so that the day one does, the wiring is already right.
   *
   * @param character The record being filled in.
   * @param src The manifest `src`, whose directory is the bundle.
   *
   * @returns Resolves once the character draws, or falls back.
   */
  async function bootBundle(character: LiveCharacter, src: string): Promise<void> {
    const url = engine.assets.url(character.bundleId) ?? src;
    const directory = url.slice(0, url.lastIndexOf('/') + 1);
    try {
      // Dynamic, and the only place the decoder half of `gameable/character`
      // is named. Nothing in this module imports either package statically any
      // more, so rolldown really does get to put `Character.ts`, its ONNX
      // runtime and the splat fork in chunks a game that never opens a bundle
      // never downloads.
      const [{ createCharacter, loadCharacterBundle }, { createAnimatedSplat }] = await Promise.all(
        [import('@gameable/character'), import('@gameable/splat')],
      );
      const bundle = await loadCharacterBundle(directory);
      if (cancelled(character)) return;
      const sink = await createAnimatedSplat(renderer, { capacity });
      character.sink = sink;
      const built = await createCharacter(bundle, {
        renderer,
        // `createCharacter` reparents the sink under its own root, so the root
        // goes under the holder and the whole character moves with the entity.
        scene: character.holder,
        sink,
      });
      if (cancelled(character)) {
        built.dispose();
        return;
      }
      character.character = built;
      character.kind = 'bundle';
      makeHeadAnimator(
        character,
        built.expressionSpace.dim,
        built.expressionSpace.kind === 'arkit52' ? null : passThrough,
      );
      // The decoder path drives the same addressable skeleton the GNM preview does,
      // so it gets the same override records — `update` forwards them through
      // `setBodyPose`, which is how a bundle character's neck turns at all.
      character.joints = jointOverridesFor(character);
      character.ready = true;
      character.onAttached?.();
    } catch (cause) {
      loadFailed(
        character,
        `gameable: character bundle "${character.bundleId}" at ${directory} did not load ` +
          `(${String(cause)}); the placeholder stays.`,
      );
    }
  }

  /**
   * Put a version 2 package's body mesh (`body.glb`, at the bind, skinned on the skeleton's
   * joints by name) on its rig, bound to the rig's own bones with the skeleton's inverse binds,
   * hidden: the shadows draw every skinned mesh under a character's rig into their depth maps.
   *
   * @param bytes The GLB.
   * @param root The rig's root.
   * @param bones The rig's bones, in the skeleton's order.
   * @param skeleton The skeleton.
   * @returns Resolves once the mesh is on the rig.
   */
  async function attachSomaBody(
    bytes: Uint8Array,
    root: Object3D,
    bones: readonly Bone[],
    skeleton: SomaSkeleton,
  ): Promise<void> {
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }),
    );
    try {
      const gltf = await loadGltf(url);
      const index = new Map(skeleton.names.map((name, i) => [name, i]));
      const meshes: SkinnedMesh[] = [];
      gltf.scene.traverse((node) => {
        if ((node as Partial<SkinnedMesh>).isSkinnedMesh === true) meshes.push(node as SkinnedMesh);
      });
      if (meshes.length === 0) throw new Error('body.glb has no skinned mesh');
      for (const source of meshes) {
        const joints = source.skeleton.bones.map((bone) => {
          const i = index.get(bone.name);
          if (i === undefined)
            throw new Error(`body.glb skins a joint the skeleton lacks: ${bone.name}`);
          return i;
        });
        const mesh = new SkinnedMeshObject(source.geometry, source.material);
        mesh.name = 'body';
        mesh.bind(
          new Skeleton(
            joints.map((i) => bones[i]),
            joints.map((i) => skeleton.joints[i].inverseBind.clone()),
          ),
          source.bindMatrix,
        );
        mesh.frustumCulled = false;
        mesh.visible = false;
        root.add(mesh);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Choose a path for a character and follow it.
   *
   * @param character The record being filled in.
   *
   * @returns Resolves once the character draws, or falls back.
   */
  async function boot(character: LiveCharacter): Promise<void> {
    const entry = engine.assets.entry(character.bundleId);
    if (entry === undefined) {
      warn(`gameable: character bundle "${character.bundleId}" is not in the manifest`);
      return;
    }
    const rig = entry.rig;
    // First, because it is the only path with no WebGPU gate in front of it: a
    // skinned body is an `AnimationMixer` and a draw call, so it renders on the
    // WebGL fallback exactly as it does on WebGPU.
    if (rig?.backend === 'aosrig-splat') {
      try {
        const { loadAosrigSplatBundle, createSomaRig, somaAnimationClip, yieldingPause } =
          await import('@gameable/character');
        exportedLoaded = true;
        const descriptorUrl = engine.assets.url(character.bundleId) ?? entry.src;
        const bundle = await loadAosrigSplatBundle(descriptorUrl, undefined, {
          // the engine keeps drawing while the character is unpacked
          pause: yieldingPause(),
          mouth: options.extras?.mouth ?? true,
          corrective: options.extras?.corrective ?? true,
          sharedClips: options.extras?.sharedClips ?? true,
          ...(options.extras?.keepSharedFiles ? { keepShared: true } : {}),
          ...(rig.clips?.length ? { clipFiles: rig.clips } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        if (cancelled(character)) return;
        // Version 2: the body is the package's skeleton, built here, with its clips (and the
        // shared ones the manifest names) as the animator's tracks.
        const soma = bundle.soma;
        if (soma) {
          const body = createSomaRig(soma.skeleton);
          const animations = soma.clips.map((clip) => somaAnimationClip(clip, soma.skeleton));
          // The body's mesh, when the package carries it: never drawn, it casts the shadows.
          const mesh = bundle.files.get('body.glb');
          if (mesh) {
            try {
              await attachSomaBody(mesh, body.root, body.bones, soma.skeleton);
            } catch (cause) {
              warn(
                `gameable: character "${character.bundleId}" casts no shadow: its body mesh ` +
                  `did not load (${String(cause)}).`,
              );
            }
            if (cancelled(character)) return;
          }
          await bootSkinned(character, descriptorUrl, bundle, {
            rig: body.root,
            animations,
            profile: SOMA_PROFILE,
          });
          return;
        }
        const bytes = bundle.files.get('rig.glb');
        if (!bytes) throw new Error('aosrig-splat: missing rig.glb');
        const url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }),
        );
        try {
          await bootSkinned(character, url, bundle);
        } finally {
          parsed.delete(url);
          URL.revokeObjectURL(url);
        }
      } catch (cause) {
        loadFailed(
          character,
          `gameable: exported character "${character.bundleId}" failed: ${String(cause)}`,
        );
      }
      return;
    }
    if (rig?.backend === 'skinned') {
      await bootSkinned(character, entry.src);
      return;
    }
    // Either declaration is enough: `backend: 'gnm'` says which rig drives the
    // head, and `pack` says which file in the bundle directory holds it. The
    // manifest requires the second whenever it says the first, so in practice
    // they arrive together.
    if (rig !== undefined && (rig.backend === 'gnm' || (rig.pack ?? '') !== '')) {
      // The constructor already said why, once, for the whole bridge.
      if (!available) return;
      await bootGnm(character, rig.pack ?? '', entry.src);
      return;
    }
    if (useDecoders) {
      if (!available) return;
      await bootBundle(character, entry.src);
      return;
    }
    warn(
      `gameable: character "${character.bundleId}" names no GNM rig pack, so it keeps its ` +
        'placeholder. Add `rig: { backend: "gnm", pack: "..." }` to the manifest entry, or ' +
        'pass `decoders: true` once the bundle has its ONNX branches.',
    );
  }

  /**
   * Has this character been despawned while an asynchronous boot was in flight?
   *
   * Written as a call rather than `character.dead` so the type checker does not
   * narrow the flag away after the first check: every `await` below is a point
   * at which the entity can be destroyed.
   *
   * @param character The record.
   *
   * @returns True when the boot should throw its work away.
   */
  function cancelled(character: LiveCharacter): boolean {
    return character.dead;
  }

  /**
   * The joint-override records an animator will fill in, built once.
   *
   * The animator names the joints it aims — `neck_01`, `neck_02`, `head` by
   * default — and a GNM pack addresses its skeleton by the same names, so the
   * two line up with no translation table.
   *
   * @param character The record, whose animator already exists.
   *
   * @returns One record per aimed joint, or null when there is no animator.
   */
  function jointOverridesFor(character: LiveCharacter): MutableJointOverride[] | null {
    const animator = character.animator;
    if (animator === null) return null;
    const out: MutableJointOverride[] = [];
    for (const joint of animator.jointOverrides.keys()) {
      out.push({ joint, rotation: [1, 0, 0, 0] });
    }
    character.jointsPushed = null;
    return out;
  }

  /**
   * Refresh a character's joint-override records from the animator's own map.
   *
   * The rig takes `(w, x, y, z)` and the animator writes three's `(x, y, z, w)`, so
   * the swizzle here is load-bearing.
   *
   * @param character The record, whose `joints` were built by
   *   {@link jointOverridesFor}.
   * @param animator The animator whose `jointOverrides` hold this frame's rotations.
   *
   * @returns True when at least one rotation differs from what was last pushed, and
   *   on the very first call. A converged head aim resends the same quaternions every
   *   frame, and pushing them costs a full joint walk in the backend.
   */
  function syncJointOverrides(character: LiveCharacter, animator: Animator): boolean {
    const joints = character.joints;
    if (joints === null) return false;
    let pushed = character.jointsPushed;
    let moved = pushed === null;
    if (pushed === null) {
      pushed = new Float32Array(joints.length * 4);
      character.jointsPushed = pushed;
    }
    for (let j = 0; j < joints.length; j += 1) {
      const override = joints[j];
      const q = animator.jointOverrides.get(override.joint);
      if (q === undefined) continue;
      override.rotation[0] = q[3];
      override.rotation[1] = q[0];
      override.rotation[2] = q[1];
      override.rotation[3] = q[2];
      for (let k = 0; k < 4; k += 1) {
        const previous = pushed[j * 4 + k];
        pushed[j * 4 + k] = override.rotation[k];
        if (pushed[j * 4 + k] !== previous) moved = true;
      }
    }
    return moved;
  }

  /**
   * The record for an entity, or null with no fuss.
   *
   * @param entity The entity.
   *
   * @returns The record, or null.
   */
  function find(entity: Entity): LiveCharacter | null {
    return live.get(entity) ?? null;
  }

  /**
   * The one update context the skinned path passes, rewritten per character.
   *
   * `update` runs 60 times a second over every character in the level, so the
   * context is a field and not an object literal.
   */
  const aimContext: AnimatorUpdateContext = { bodyYaw: 0 };

  /**
   * Put the animator's head aim onto the live bones.
   *
   * The animator folds its overrides into `bodyPose` and leaves three's bones
   * alone, because a rig backend that consumes `jointOverrides` separately
   * would otherwise apply them twice. On this path there IS no separate
   * backend — the skeleton is what the GPU skins against — so without this
   * step `look-at` computes a perfect aim and nothing on screen moves.
   *
   * @param character The record.
   * @param animator Its animator, already updated this frame.
   *
   * @returns Nothing.
   */
  function applyAim(character: LiveCharacter, animator: Animator): void {
    const aimBones = character.aimBones;
    if (aimBones === null) return;
    for (let i = 0; i < aimBones.length; i += 1) {
      const aim = aimBones[i];
      const q = animator.jointOverrides.get(aim.joint);
      if (q === undefined) continue;
      const bone = aim.bone;
      // Untouched since last frame means the mixer wrote nothing — every action
      // is stopped — so what is on the bone is last frame's aim, not a pose.
      if (bone.quaternion.equals(aim.applied)) bone.quaternion.copy(aim.base);
      aim.base.copy(bone.quaternion);
      // The override is a PARENT-LOCAL delta that pre-multiplies the animated
      // local rotation. Three's order, three's bone: no `(w, x, y, z)` swizzle
      // here — that one belongs to the GNM rig and nowhere else.
      scratchDelta.set(q[0], q[1], q[2], q[3]);
      bone.quaternion.premultiply(scratchDelta);
      aim.applied.copy(bone.quaternion);
    }
  }

  const bridge: CharacterBridge = {
    available,
    shadows,

    spawn(request) {
      bridge.despawn(request.entity);

      const parent = request.parent ?? fallbackParent;
      const holder = new Group();
      holder.name = `character:${String(request.entity)}`;
      // `spawn-character` states a WORLD position and the entity's own object is
      // already there, so the difference is the character's local offset — zero
      // for everything the prefab helper emits. The head offset is added on top,
      // because an entity's origin is its physics centre and not its neck.
      // `bootSkinned` rewrites this from `local` with the ground offset instead.
      const local: readonly [number, number, number] = [
        request.position.x - parent.position.x,
        request.position.y - parent.position.y,
        request.position.z - parent.position.z,
      ];
      holder.position.set(
        local[0] + headOffset[0],
        local[1] + headOffset[1],
        local[2] + headOffset[2],
      );
      parent.add(holder);

      // The animator's root. It has no bones — a GNM head has no body skeleton —
      // but head aim resolves the look direction from its WORLD position, so it
      // has to hang where the character does.
      const root = new Object3D();
      root.name = `character-root:${String(request.entity)}`;
      holder.add(root);

      const character: LiveCharacter = {
        entity: request.entity,
        bundleId: engine.assets.idOf(request.bundle) ?? '',
        kind: 'placeholder',
        stateName: 'idle',
        holder,
        local,
        groundOffset: request.groundOffset ?? 0,
        root,
        parent,
        state: { clips: [], lookAt: null, velocity: [0, 0, 0], grounded: true },
        clipPool: [],
        lookScratch: [0, 0, 0],
        animator: null,
        preview: null,
        character: null,
        sink: null,
        controls: null,
        gazeOffset: -1,
        joints: null,
        jointsPushed: null,
        controlsPushed: null,
        rig: null,
        aimBones: null,
        clips: [],
        ownMaterials: null,
        arkit: new Float32Array(ARKIT_COUNT),
        native: null,
        ready: false,
        dead: false,
        onAttached: request.onAttached,
      };
      live.set(request.entity, character);
      order.push(character);

      if (character.bundleId === '') {
        warn(`gameable: character bundle handle ${String(request.bundle)} is not in the manifest`);
        return;
      }

      void boot(character).catch((cause: unknown) => {
        warn(`gameable: character "${character.bundleId}" failed to spawn: ${String(cause)}`);
      });
    },

    setState(entity, state, velocity, grounded) {
      const character = find(entity);
      if (character === null) return;
      character.stateName = state;
      character.state.velocity[0] = velocity.x;
      character.state.velocity[1] = velocity.y;
      character.state.velocity[2] = velocity.z;
      character.state.grounded = grounded;
      // The animator blends locomotion from the velocity, not from the name:
      // the name is the guest's own vocabulary and only a clip library could
      // give it meaning. `planarSpeed` is what picks walk over run.
      character.animator?.setState(character.state);
    },

    setClipWeights(entity, clips, weights, timeScale) {
      const character = find(entity);
      if (character === null) return;
      const requests = character.state.clips;
      const pool = character.clipPool;
      requests.length = 0;
      for (let i = 0; i < clips.length; i += 1) {
        let slot = pool[i] as { name: string; weight: number } | undefined;
        if (slot === undefined) {
          slot = { name: '', weight: 0 };
          pool[i] = slot;
        }
        slot.name = clips[i];
        slot.weight = weights[i];
        requests.push(slot);
      }
      character.animator?.setState(character.state);
      if (timeScale !== 1) {
        warn(
          'gameable: set-clip-weights timeScale needs a clip library on the character; the ' +
            'weights are applied and the rate is not.',
        );
      }
    },

    setExpression(entity, space, weights) {
      const character = find(entity);
      if (character === null) return;
      if (character.kind === 'skinned') {
        warn(
          'gameable: set-expression needs a face, and a skinned glTF body has none — its head ' +
            'is geometry, not blendshapes. The weights are recorded and nothing moves.',
        );
      }
      let target: Float32Array;
      if (space === 'arkit52') {
        target = character.arkit;
      } else {
        const native = character.native;
        if (native === null || native.length !== weights.length) {
          warn(
            `gameable: set-expression space "${space}" does not match the expression space of ` +
              `character "${character.bundleId}"; send ARKit-52 instead.`,
          );
          return;
        }
        target = native;
      }
      for (let i = 0; i < target.length; i += 1) target[i] = weights[i];
      character.state.expression = target;
      character.animator?.setState(character.state);
    },

    lookAt(entity, target, weight) {
      const character = find(entity);
      if (character === null) return;
      if (target === undefined || weight <= 0) {
        character.state.lookAt = null;
      } else {
        const look = character.lookScratch;
        look[0] = target.x;
        look[1] = target.y;
        look[2] = target.z;
        character.state.lookAt = look;
      }
      character.animator?.setState(character.state);
    },

    attachFace(bodyEntity, faceEntity, boneName, hiddenMaterial, offset) {
      const body = find(bodyEntity);
      const face = find(faceEntity);
      if (
        body === null ||
        face === null ||
        !body.ready ||
        !face.ready ||
        body.rig === null ||
        face.kind !== 'gnm-rig'
      )
        return false;
      const bone = body.rig.getObjectByName(boneName);
      if (bone === undefined) return false;
      if (face.holder.parent === bone) return true;
      const hidden: Object3D[] = [];
      body.rig.traverse((node) => {
        const mesh = node as Partial<Mesh>;
        const material = mesh.material;
        if (
          material !== undefined &&
          !Array.isArray(material) &&
          material.name === hiddenMaterial &&
          node.visible
        ) {
          hidden.push(node);
          node.visible = false;
        }
      });
      bone.add(face.holder);
      face.holder.position.set(offset[0], offset[1], offset[2]);
      face.holder.quaternion
        .copy(restOrientations.get(bodyEntity)?.get(boneName) ?? new Quaternion())
        .invert();
      attachments.set(faceEntity, { body: bodyEntity, hidden });
      return true;
    },

    say(entity, text, audio, visemes) {
      if (options.speech !== undefined) {
        options.speech.say(entity, text, audio, visemes);
        return;
      }
      if (audio !== undefined || visemes !== undefined)
        warn('gameable: say() audio requires a host speech player');
      const voice = audio === undefined || audio === 0 ? '' : ` (voice ${String(audio)})`;
      logSink(`[character ${String(entity)}] ${text}${voice}`);
    },

    setMaterialParam(entity, name, value) {
      const character = find(entity);
      const rig = character?.rig;
      if (character === null || rig === undefined || rig === null) return false;
      if (name !== 'color' || value.tag !== 'color') {
        warn(
          `gameable: set-material-param("${name}") on a skinned character only understands ` +
            '`color` today; the request is ignored.',
        );
        return false;
      }

      if (character.ownMaterials === null) {
        // `SkeletonUtils.clone` shares materials by reference, which is the
        // point — but it means tinting one enemy red would repaint every other
        // body cloned from the same GLB. One clone per entity, once.
        const owned: Material[] = [];
        rig.traverse((node) => {
          const mesh = node as Partial<Mesh>;
          const material = mesh.material;
          if (material === undefined) return;
          if (Array.isArray(material)) {
            const clones = material.map((m) => m.clone());
            mesh.material = clones;
            owned.push(...clones);
          } else {
            const clone = material.clone();
            mesh.material = clone;
            owned.push(clone);
          }
        });
        character.ownMaterials = owned;
      }

      let painted = false;
      for (const material of character.ownMaterials) {
        const tinted = material as Partial<{
          color: { setRGB(r: number, g: number, b: number): void };
        }>;
        if (tinted.color === undefined) continue;
        tinted.color.setRGB(value.val.r, value.val.g, value.val.b);
        painted = true;
      }
      return painted;
    },

    update(dt) {
      for (let i = 0; i < order.length; i += 1) {
        const character = order[i];
        const animator = character.animator;
        if (animator === null) continue;

        if (character.kind === 'skinned' || character.kind === 'aosrig-splat') {
          // The rig DRAWS, so it must not be rotated: it already inherits the
          // entity's facing from the holder's parent. Tell the aim what that
          // facing is instead of making it read a rotation off the root.
          character.parent.getWorldQuaternion(scratchQuaternion);
          aimContext.bodyYaw = yawOf(scratchQuaternion);
          animator.update(dt, aimContext);
          applyAim(character, animator);
          character.boundSplats?.render(animator.expression, animator.gaze, engine.camera);
          if (character.boundSplats && character.sink) character.sink.object3D.visible = true;
          if (character.fading) stepFade(character, animator, engine.camera);
          continue;
        }

        // Head aim clamps the turn against the character's facing, which it
        // reads as `root.rotation.y`. The facing lives on the entity's object,
        // so copy it across; the root draws nothing, so the double rotation it
        // ends up with in world space is invisible and cancels in the transport.
        character.parent.getWorldQuaternion(scratchQuaternion);
        character.root.rotation.y = yawOf(scratchQuaternion);
        // No `camera` in the update context on purpose: falling back to "stare
        // at the player" would make every idle NPC track the camera, which
        // reads as a bug. A character looks where `look-at` said, or ahead.
        animator.update(dt);

        const built = character.character;
        if (built !== null) {
          built.setExpression(animator.expression);
          built.setLookAt(character.state.lookAt);
          // The decoder path gets the head aim too. It used to be dropped on the
          // floor here, so a bundle character's neck never turned — the GNM backend
          // behind it takes exactly the same overrides the preview path sends. Only
          // pushed when it moved: `setBodyPose` raises the character's rig dirty
          // flag, and a full pass is a trunk, a geom, an appr and a lift.
          const joints = character.joints;
          if (joints !== null && syncJointOverrides(character, animator)) {
            built.setBodyPose(bodyPoseScratch(joints));
          }
          built.update(dt, engine.camera);
          continue;
        }

        const preview = character.preview;
        const controls = character.controls;
        if (preview === null || controls === null) continue;
        const expression = animator.expression;
        const shared = Math.min(controls.length, expression.length);
        for (let c = 0; c < shared; c += 1) controls[c] = expression[c];
        // Head aim turns the neck as far as it will go and leaves the rest to
        // the eyes. GNM spells gaze pitch positive-down and the animator spells
        // it positive-up, hence the sign; yaw agrees on character-left.
        const gaze = character.gazeOffset;
        if (gaze >= 0 && gaze + 4 <= controls.length) {
          controls[gaze] += -animator.gaze[0];
          controls[gaze + 1] += animator.gaze[1];
          controls[gaze + 2] += -animator.gaze[2];
          controls[gaze + 3] += animator.gaze[3];
        }
        // The FIRST push always lands, even at an all-zero neutral — "never pushed"
        // and "pushed zeros" are different states, and a rig that has never been
        // told anything renders its bind pose. Every push after that is compared,
        // because an idle face resends one vector sixty times a second.
        let pushed = character.controlsPushed;
        let moved = pushed === null;
        if (pushed === null || pushed.length !== controls.length) {
          pushed = new Float32Array(controls.length);
          character.controlsPushed = pushed;
          moved = true;
        }
        for (let c = 0; c < controls.length; c += 1) {
          if (pushed[c] !== controls[c]) moved = true;
          pushed[c] = controls[c];
        }
        if (moved) preview.setControls(controls);
        // Where the neck actually went.
        const joints = character.joints;
        if (
          joints !== null &&
          preview.backend.setJointOverrides !== undefined &&
          syncJointOverrides(character, animator)
        ) {
          preview.backend.setJointOverrides(joints);
        }
        preview.render();
      }
      if (shadowSystem) {
        findServicePlaces();
        shadowSystem.update(dt);
      }
    },

    despawn(entity) {
      const character = live.get(entity);
      if (character === undefined) return;
      character.dead = true;
      options.speech?.stop(entity);
      for (const [face, attachment] of attachments) {
        if (attachment.body === entity) bridge.despawn(face);
      }
      const attachment = attachments.get(entity);
      if (attachment !== undefined) {
        for (const node of attachment.hidden) node.visible = true;
        attachments.delete(entity);
      }
      restOrientations.delete(entity);
      live.delete(entity);
      const index = order.indexOf(character);
      if (index >= 0) order.splice(index, 1);
      shadowSystem?.removeCharacter(character);

      character.character?.dispose();
      character.animator?.dispose();
      // The preview owns the backend and disposes it; the sink is ours.
      character.boundSplats?.dispose();
      // An upgrade still dissolving in: its old points go too, and its promise settles.
      const fade = character.fading;
      if (fade) {
        character.fading = undefined;
        fade.runtime.dispose();
        fade.sink.object3D.removeFromParent();
        fade.sink.dispose();
        fade.teethSink?.dispose();
        fade.done();
      }
      character.preview?.dispose();
      character.teethSink?.dispose();
      character.sink?.dispose();
      // The rig's geometry and materials came from the shared parse and other
      // characters are still drawing them, so the clone is unparented and
      // nothing is disposed. The per-entity tint clones ARE this entity's.
      disposeOwnedRig(character);
      character.rig?.removeFromParent();
      for (const material of character.ownMaterials ?? []) material.dispose();
      character.rig = null;
      character.aimBones = null;
      character.ownMaterials = null;
      character.clips.length = 0;
      character.root.removeFromParent();
      character.holder.removeFromParent();
    },

    upgrade(entity, src, upgradeOptions = {}) {
      return upgradeCharacter(
        {
          engine,
          renderer,
          webgl,
          options,
          cancelled,
          shadows: () => shadowSystem,
        },
        live.get(entity),
        src,
        upgradeOptions,
      );
    },

    entryOf(entity) {
      const character = live.get(entity);
      if (character === undefined) return null;
      return {
        entity,
        bundleId: character.bundleId,
        kind: character.kind,
        ready: character.ready,
        state: character.stateName,
        animator: character.animator,
        controls: character.controls,
        clips: character.clips,
        mouth: character.boundSplats?.mouth ?? null,
        corrective: character.boundSplats?.corrective ?? null,
        hiddenPoints: character.boundSplats?.hiddenPoints ?? null,
      };
    },

    dispose() {
      for (const character of [...order]) bridge.despawn(character.entity);
      order.length = 0;
      live.clear();
      shadowSystem?.dispose();
      shadowSystem = null;
      // Last owner out drops the parses. A `despawn` must NOT: the whole point
      // of the cache is that a level can respawn a character without refetching
      // three megabytes.
      parsed.clear();
      // And the page's shared clip pack, which every exported character read once.
      if (exportedLoaded)
        void import('@gameable/character').then((m) => {
          m.releaseSharedClips();
        });
    },
  };

  return bridge;
}
