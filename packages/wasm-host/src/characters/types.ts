/**
 * The character bridge's public types: its options, what it answers, and the commands' shapes.
 * `createCharacterBridge` (../characters.ts) implements them.
 */
import type { Animator } from '@gameable/animation';
import { Object3D } from 'three/webgpu';
import type { AnimationClip, WebGPURenderer } from 'three/webgpu';
import type { Engine } from '@gameable/core';
import type { AssetId, Entity, ExpressionSpace, MaterialValue, Quat, Vec3 } from '@gameable/sdk';
import type {
  AosrigCorrectiveState,
  AosrigMouth,
  AosrigMouthHiddenState,
} from '@gameable/character';
import type {
  AnimatedGaussianSplat,
  KeyLightEstimate,
  ShadowInfo,
  ShadowPlace,
  ShadowQuality,
} from '@gameable/splat';

/**
 * A parsed skinned glTF: the part of three's `GLTF` this bridge reads.
 *
 * Spelled structurally rather than imported so that a game may inject its own
 * loader — a cache, a fixture, a different container entirely — without
 * `three/addons/loaders/GLTFLoader.js` being reachable from this module at all.
 */
export interface SkinnedGltf {
  /** The default scene, containing at least one `SkinnedMesh`. */
  readonly scene: Object3D;
  /** Every animation in the file, named as the guest will address them. */
  readonly animations: readonly AnimationClip[];
}

/** Options accepted by {@link createCharacterBridge}. */
export interface CharacterBridgeOptions {
  /** The booted engine, for the asset manifest, the camera and the caps. */
  engine: Engine;
  /** The renderer that owns the device. Defaults to `engine.renderer`. */
  renderer?: WebGPURenderer;
  /** Parent for a character whose entity has no object. Defaults to `engine.scene`. */
  scene?: Object3D;
  /** Gaussians reserved per character. Defaults to 32768. */
  capacityPerCharacter?: number;
  /**
   * Which of an exported package's optional parts to load and draw: the mouth's inside
   * (teeth.json and its files, mouth_hidden.bin: the teeth splat, the mouth meshes and the
   * mask never exist when off) and the pose corrections (corrective/). Both default to
   * true. Off, nothing of that part is fetched and the character draws as a package
   * without it.
   *
   * `sharedClips` (default true): a version 2 package's shared clip pack (`sharedClips` in its
   * character.json, fetched once per page). False skips it, for a game that brings its own
   * clips (the manifest's `rig.clips`); the package's own clips and house names still play.
   */
  extras?: {
    mouth?: boolean;
    corrective?: boolean;
    /**
     * Keep an exported character's head and skeleton files after it is built, for a later
     * {@link CharacterBridge.upgrade} to the full copy of the same character, which shares them (about 45 MB
     * held until then). Off by default.
     */
    keepSharedFiles?: boolean;
    sharedClips?: boolean;
  };
  /** Head placement relative to the entity's origin, in metres. Defaults to `[0, 0.6, 0]`. */
  headOffset?: readonly [number, number, number];
  /** Object-space height the head is fitted to, in metres. Defaults to 0.35. */
  headHeight?: number;
  /**
   * Try the decoder path — `loadCharacterBundle` plus `createCharacter` — for a
   * bundle that is not a bare GNM pack. Defaults to **false**.
   *
   * It is off by default because deciding costs a `scene.json` fetch against a
   * directory that, for every bundle shipped today, is not there: a 404 on
   * every NPC spawn, which every e2e suite in this repository treats as a
   * failure. Turn it on once a bundle with branches is in your manifest.
   */
  decoders?: boolean;
  /**
   * Load a skinned glTF/GLB. Defaults to one lazily imported `GLTFLoader`.
   *
   * The default has no Draco and no KTX2 decoder attached — the rig this path
   * was built for is 3 MB of plain glTF, and a decoder is a second download on
   * a path whose whole point is not needing one. Pass your own loader when your
   * body is compressed, or to serve the file from somewhere else entirely.
   *
   * The bridge caches the returned promise per URL and clones the scene per
   * spawn, so this is called once however many characters share the file.
   *
   * @param url The resolved URL of the manifest entry's `src`.
   *
   * @returns The scene and its animations.
   */
  loadGltf?: (url: string) => Promise<SkinnedGltf>;
  /**
   * The `fetch` an exported character's (`aosrig-splat`) files go through, for characters kept
   * on a private store: `createAamResolver(client).fetch` from `gameable/aam` adds the
   * asset manager's key to its own URLs only. Defaults to the global `fetch`.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Where warnings go. Defaults to `console.warn`, once per distinct message.
   *
   * @param message What went wrong.
   */
  warn?: (message: string) => void;
  /**
   * Told when a character's own load fails for good (its bundle, its rig, its head pack or its
   * splats did not load or did not fit): the character stays a placeholder. A warning about an
   * optional part is not this. A host that retries a load should key on this, never on `warn`.
   */
  onLoadFailed?: (info: { entity: Entity; bundleId: string; message: string }) => void;
  /**
   * Where `say()` lines go. Defaults to `console.log`.
   *
   * @param message The line, already prefixed with the entity.
   */
  log?: (message: string) => void;
  /** Optional speech player; stream/audio ownership remains entirely host-side. */
  speech?: {
    say(entity: Entity, text: string, audio?: AssetId, visemes?: string): void;
    stop(entity: Entity): void;
  };
  /**
   * Shadows for exported (`aosrig-splat`) characters: each one's shadow on the place it stands
   * in, the place's shadow on it and a contact shadow under its feet, from a key light read
   * from the scene (the place's panorama or own gaussians, else the light in the
   * character's own colours). Nobody places a light. A level (`'off'`, `'contact'`, `'simple'`,
   * `'soft'`), `'auto'` (the default: soft on a computer, simple on a phone, contact on a
   * small-memory phone) or `false` for none at all. Change it later with
   * `bridge.shadows.setQuality()`.
   */
  shadows?: ShadowQuality | 'auto' | false;
}

/**
 * The shadows of the characters a bridge draws, and of the places they stand in.
 *
 * Usable at once: a level or a place given before the first character loads is kept and
 * applied when it does. Places the splat service adds (`engine.get('splat').add`) receive by
 * themselves; one added by hand is announced with `addPlace`.
 */
export interface CharacterShadows {
  /** The level in use (`'off'` when shadows are switched off or there is no WebGPU). */
  readonly quality: ShadowQuality;
  /** What the shadows are doing (which source chose the light, its direction), or null before the first character. */
  readonly info: ShadowInfo | null;
  /**
   * Change the level; `'auto'` picks by device.
   *
   * @param quality The level.
   * @returns Nothing.
   */
  setQuality(quality: ShadowQuality | 'auto'): void;
  /**
   * A place added by hand: its gaussians receive, its collider shadows the characters, its
   * panorama tells where the light comes from.
   *
   * @param splat The place's gaussians (an `AnimatedGaussianSplat`).
   * @param place Its collider or panorama.
   * @returns Nothing.
   */
  addPlace(splat: AnimatedGaussianSplat, place?: ShadowPlace): void;
  /**
   * Stop a place receiving.
   *
   * @param splat The place's gaussians.
   * @returns Nothing.
   */
  removePlace(splat: AnimatedGaussianSplat): void;
  /**
   * Set the key light yourself, or null to read it from the scene again.
   *
   * @param light The light, world space.
   * @returns Nothing.
   */
  setKeyLight(light: KeyLightEstimate | null): void;
}

/** One `spawn-character`, as the adapter hands it over. */
export interface CharacterSpawnRequest {
  /** The entity the character belongs to. */
  entity: Entity;
  /** Bundle handle the guest named. */
  bundle: AssetId;
  /** The entity's own object. Defaults to the bridge's `scene`. */
  parent?: Object3D;
  /** World position the guest spawned the character at. */
  position: Vec3;
  /** World rotation the guest spawned the character at. */
  rotation: Quat;
  /**
   * Metres from the entity's origin down to the floor, as a signed offset.
   *
   * An entity's transform is its physics body's CENTRE; a skinned body's own
   * origin is between its feet. `createEngineAdapter` computes this from the
   * `add-body` shape and it is what stops a character hovering a metre in the
   * air. Defaults to 0, which is right for a head-only character.
   */
  groundOffset?: number;
  /**
   * Called once the character is really on screen, so the caller can drop
   * whatever placeholder it was drawing. Never called when the spawn falls
   * back to the placeholder.
   */
  onAttached?: () => void;
}

/** What the bridge is doing for one entity. The test seam. */
export interface CharacterBridgeEntry {
  /** The entity. */
  readonly entity: Entity;
  /** Manifest id of the bundle, or `''` when the handle did not resolve. */
  readonly bundleId: string;
  /** Which path this character took. */
  readonly kind: CharacterPath;
  /** True once the rig is initialised and drawing. */
  readonly ready: boolean;
  /** The guest's own state name, from the last `set-character-state`. */
  readonly state: string;
  /** The animator, once one exists. */
  readonly animator: Animator | null;
  /** The control vector last handed to the rig backend, when there is one. */
  readonly controls: Float32Array | null;
  /**
   * Clip names the guest may drive with `set-clip-weights`, in file order.
   *
   * Empty on the `gnm` and decoder paths: a GNM head carries no body animation.
   */
  readonly clips: readonly string[];
  /**
   * The inside of the mouth (teeth, gums, tongue), on an exported character whose package
   * carries it; null otherwise. Set `enabled` to false to draw the character without it.
   */
  readonly mouth: AosrigMouth | null;
  /**
   * The pose corrections (the studio's Shoulder fix), on an exported character whose package
   * carries `corrective/`; null otherwise. Its `angles` and `weights` say what the arms are
   * doing this frame; `enabled = false` draws the character without them.
   */
  readonly corrective: AosrigCorrectiveState | null;
  /**
   * The closed mouth's inside points (`mouth_hidden.bin`: faded, and the lip line's plugs
   * moved, as the lips part), on an exported character whose package carries the file; null
   * otherwise. `enabled = false` draws them as any other splat.
   */
  readonly hiddenPoints: AosrigMouthHiddenState | null;
}

/** Which renderer a character ended up on. */
export type CharacterPath = 'gnm-rig' | 'skinned' | 'aosrig-splat' | 'bundle' | 'placeholder';

/**
 * The surface `createEngineAdapter` drives. Every method is safe to call for an
 * entity the bridge has never heard of.
 */
export interface CharacterBridge {
  /**
   * False on the WebGL fallback: GNM heads and the decoder path degrade to placeholders there;
   * skinned glTF characters and the Gameable studio's exports still draw.
   */
  readonly available: boolean;

  /** The characters' shadows (see {@link CharacterBridgeOptions.shadows}). */
  readonly shadows?: CharacterShadows;

  /**
   * Begin a `spawn-character`. Resolving the manifest, fetching the pack and
   * building the GPU resources are asynchronous; the call returns immediately.
   *
   * @param request The spawn.
   *
   * @returns Nothing.
   */
  spawn(request: CharacterSpawnRequest): void;

  /**
   * Apply a `set-character-state`: locomotion from velocity and grounded.
   *
   * @param entity The entity.
   * @param state The guest's own state name.
   * @param velocity World-space velocity.
   * @param grounded Whether the character controller is on the floor.
   *
   * @returns Nothing.
   */
  setState(entity: Entity, state: string, velocity: Vec3, grounded: boolean): void;

  /**
   * Apply a `set-clip-weights`.
   *
   * @param entity The entity.
   * @param clips Clip names.
   * @param weights Weight per clip.
   * @param timeScale Playback rate for the set.
   *
   * @returns Nothing.
   */
  setClipWeights(
    entity: Entity,
    clips: readonly string[],
    weights: ArrayLike<number>,
    timeScale: number,
  ): void;

  /**
   * Apply a `set-expression` onto the animator's face layer.
   *
   * @param entity The entity.
   * @param space Which space `weights` is in.
   * @param weights The weights.
   *
   * @returns Nothing.
   */
  setExpression(entity: Entity, space: ExpressionSpace, weights: ArrayLike<number>): void;

  /**
   * Apply a `look-at`: head aim, with whatever the neck could not reach left to
   * the eyes as gaze.
   *
   * @param entity The entity.
   * @param target World-space point, or undefined to look straight ahead.
   * @param weight Zero also means "look straight ahead".
   *
   * @returns Nothing.
   */
  lookAt(entity: Entity, target: Vec3 | undefined, weight: number): void;

  /**
   * Apply a `say` to the optional host speech player; otherwise log the line.
   *
   * @param entity The entity.
   * @param text What was said.
   * @param audio Optional voice-line asset handle.
   * @param visemes Optional viseme track.
   *
   * @returns Nothing.
   */
  say(entity: Entity, text: string, audio?: AssetId, visemes?: string): void;

  /**
   * Apply a `set-material-param` to a character's own meshes.
   *
   * Only meaningful on the `skinned` path, and only for `color` today. The
   * adapter calls this when the entity has no placeholder left to tint, which
   * is what keeps a template's enemies red once real bodies replace the
   * capsules.
   *
   * @param entity The entity.
   * @param name Parameter name; `color` is the one this understands.
   * @param value The value, in the guest's own tagged union.
   *
   * @returns True when something was actually repainted.
   */
  setMaterialParam?(entity: Entity, name: string, value: MaterialValue): boolean;

  /**
   * Advance every animator and redraw every rig.
   *
   * @param dt Seconds since the previous frame.
   *
   * @returns Nothing.
   */
  update(dt: number): void;

  /**
   * Release everything one entity owns.
   *
   * @param entity The entity.
   *
   * @returns Nothing.
   */
  despawn(entity: Entity): void;

  /**
   * What the bridge is doing for an entity.
   *
   * @param entity The entity.
   *
   * @returns The record, or null when the entity has no character.
   */
  entryOf(entity: Entity): CharacterBridgeEntry | null;

  /**
   * Replace a drawn exported character's points with another package of the same character (its
   * full copy after a lighter one drew first): the new package's points are bound to the same
   * skeleton and animator, so the pose never jumps, and they take over in one frame, or dissolve in
   * over `fadeMs` drawn over the old ones (the old ones stay whole underneath, so nothing shows
   * through). The package must share the rig (same joints); it is fetched and built while the old
   * points keep drawing.
   *
   * @param entity The character's entity.
   * @param src The other package's `character.json`.
   * @param options `fadeMs` (0: the same-frame swap), and `onStage` for timings.
   * @returns Resolves once the new points are drawing.
   */
  upgrade?(entity: Entity, src: string, options?: CharacterUpgradeOptions): Promise<void>;

  /** Attach an independently loaded face to a skinned bone once both are ready.
   *
   * @param bodyEntity Skinned body entity.
   * @param faceEntity GNM face entity.
   * @param boneName Attachment bone.
   * @param hiddenMaterial Material identifying the static head primitive.
   * @param offset Bone-local position in metres.
   * @returns True once attached; false while either character is loading.
   */
  attachFace?(
    bodyEntity: Entity,
    faceEntity: Entity,
    boneName: string,
    hiddenMaterial: string,
    offset: readonly [number, number, number],
  ): boolean;

  /** Release every character. */
  dispose(): void;
}

/** How {@link CharacterBridge.upgrade} swaps a character's points. */
export interface CharacterUpgradeOptions {
  /** 0 swaps in one frame; more dissolves the new points in over that many milliseconds. */
  fadeMs?: number;
  /** Called at each stage (`start`, `downloaded`, `built`, `compiled`, `swapped`, `faded`) with `performance.now()`. */
  onStage?: (stage: string, at: number) => void;
}
