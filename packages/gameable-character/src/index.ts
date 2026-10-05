/**
 * `gameable/three` — a character made in the Gameable studio, in your own
 * three.js scene.
 *
 * One call loads a published character (its `character.json` URL, any origin that sends CORS)
 * onto the app's own `WebGPURenderer`; the result is an `Object3D` to add to the app's own
 * scene, an `update(dt, camera)` to call each frame, clips by name and an ARKit-52 face. No
 * engine, no ECS, no wasm: the app keeps its renderer, scene, camera and loop. The character's
 * splats blend on their sRGB colours, as they were trained, in a pass that `gameable/core`'s
 * `attachSrgbPass` hooks into the scene's `onBeforeRender` / `onAfterRender` on the first
 * `update`, so the app's own `renderer.render(scene, camera)` draws it.
 *
 * WebGPU first: on a browser without it three's renderer falls back to WebGL2, and the character
 * draws there too, slower (`allowWebGL: false` refuses the fallback with a
 * {@link GameableCharacterError} instead).
 */
import {
  ARKIT_NAMES,
  createAnimator,
  type Animator,
  type CharacterClipRequest,
} from '@gameable/animation';
import {
  buildAosrigCharacter,
  createSomaRig,
  loadAosrigSplatBundle,
  releaseSharedClips,
  yieldingPause,
  somaAnimationClip,
  type AosrigSplatBundle,
  type AosrigSplatRuntime,
  type SomaSkeleton,
} from '@gameable/character/aosrig';
import { createAnimatedSplat, releaseStorageAttribute, type AnimatedSplat } from '@gameable/splat';

import { attachSrgbPass, type SrgbPass } from '@gameable/core/render';

/**
 * The characters' pass driven by the app (see {@link attachManualPass}).
 *
 * @example
 * ```ts
 * const pass: ManualPass = attachManualPass(renderer, scene);
 * pass.begin(camera);
 * renderer.render(scene, camera);
 * pass.end();
 * ```
 */
export interface ManualPass {
  /**
   * Call just before `renderer.render(scene, camera)`: draws the characters for this camera.
   *
   * @param camera The camera the app renders with.
   * @returns Nothing.
   */
  begin(camera: Camera): void;
  /**
   * Call just after the render.
   *
   * @returns Nothing.
   */
  end(): void;
  /**
   * Take the pass off the scene.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * The pass the characters are drawn in, driven by the app instead of by the scene's
 * `onBeforeRender` / `onAfterRender` hooks: for an app that assigns those itself, or renders
 * through something that skips them. Load the characters with `{ attachPass: false }`, attach this
 * once per scene, and call `begin(camera)` just before each render and `end()` just after.
 *
 * @param renderer The app's renderer.
 * @param scene The scene the characters are in.
 * @returns The pass.
 * @example
 * ```ts
 * const character = await loadGameableCharacter(renderer, url, { attachPass: false });
 * scene.add(character.object3D);
 * const pass = attachManualPass(renderer, scene);
 * renderer.setAnimationLoop(() => {
 *   character.update(timer.getDelta(), camera);
 *   pass.begin(camera);
 *   renderer.render(scene, camera);
 *   pass.end();
 * });
 * ```
 */
export function attachManualPass(renderer: WebGPURenderer, scene: Scene): ManualPass {
  const pass = attachSrgbPass(renderer, scene, { hook: false });
  return {
    begin: (camera) => {
      pass.begin(camera);
    },
    end: () => {
      pass.end();
    },
    dispose: () => {
      pass.dispose();
    },
  };
}

import { writeArkitWeights } from './arkit.js';
import { createClipDrive } from './clipDrive.js';
import {
  Color,
  Group,
  MeshBasicNodeMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
  type Bone,
  type ColorRepresentation,
  type AnimationClip,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/three';
 * console.log(PACKAGE); // 'gameable/three'
 * ```
 */
export const PACKAGE = 'gameable/three' as const;

/**
 * Why a character could not be loaded.
 *
 * @example
 * ```ts
 * import type { GameableCharacterErrorCode } from 'gameable/three';
 * const code: GameableCharacterErrorCode = 'webgpu-required';
 * ```
 */
export type GameableCharacterErrorCode =
  /** The renderer is on the WebGL2 fallback and `allowWebGL` is false. */
  | 'webgpu-required'
  /** `renderer.init()` has not finished. */
  | 'renderer-not-ready'
  /** The package could not be fetched, failed its sha256 checks, or is not a character. */
  | 'load-failed'
  /**
   * The renderer runs in software (no GPU: SwiftShader, llvmpipe, Windows' basic driver), where a
   * character draws at well under a frame a second; see `allowSoftwareRenderer`.
   */
  | 'software-renderer';

/**
 * A character could not be loaded; `code` says why, `message` says what to do.
 *
 * @example
 * ```ts
 * import { GameableCharacterError, loadGameableCharacter } from 'gameable/three';
 *
 * try {
 *   await loadGameableCharacter(renderer, url);
 * } catch (error) {
 *   if (error instanceof GameableCharacterError && error.code === 'webgpu-required') {
 *     console.warn('this browser cannot show the character yet');
 *   }
 * }
 * ```
 */
export class GameableCharacterError extends Error {
  /** Why. */
  readonly code: GameableCharacterErrorCode;

  /**
   * @param code Why.
   * @param message What happened and what to do.
   * @param options The underlying error, when there is one.
   */
  constructor(code: GameableCharacterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GameableCharacterError';
    this.code = code;
  }
}

/**
 * Options for {@link loadGameableCharacter}.
 *
 * @example
 * ```ts
 * const character = await loadGameableCharacter(renderer, url, {
 *   clip: 'wave',
 *   fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
 * });
 * ```
 */
export interface LoadGameableCharacterOptions {
  /**
   * Fetch every file of the package with this instead of the global `fetch` (for credentials,
   * a proxy, or an asset manager). Same signature as `fetch`.
   */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The clip to start with. Defaults to `idle` when the character has one, else its first. */
  readonly clip?: string;
  /**
   * A colour to multiply the character's by (in linear light), to fit it into your scene's
   * light: `'#ffe6cc'` warms it. White (the default) keeps the captured colours. See `setTint`.
   */
  readonly tint?: ColorRepresentation;
  /** A multiplier on the character's brightness, like `renderer.toneMappingExposure`. Default 1. */
  readonly exposure?: number;
  /**
   * Cast a shadow into your scene's shadow maps (the renderer's `shadowMap.enabled` and a light
   * with `castShadow`), from the character's body mesh, skinned to its skeleton. Default false:
   * it costs a skinned draw per shadow-casting light each frame (six for a point light). The mesh
   * is made the first time it turns on. See `castShadow`.
   */
  readonly castShadow?: boolean;
  /**
   * Draw the inside of the mouth (teeth, gums, tongue) when the lips part, for a package that
   * carries the teeth's files. Default false, as on the studio's own stage, where it is off
   * unless switched on.
   */
  readonly mouth?: boolean;
  /** Aborts the download. */
  readonly signal?: AbortSignal;
  /**
   * Attach the sRGB pass (see `attachSrgbPass`) to the character's scene on its first update, with
   * the scene's `onBeforeRender` / `onAfterRender` hooks. Default true. False for an app that
   * assigns those hooks itself or renders through something that skips them: it attaches the pass
   * with {@link attachManualPass} and calls `begin(camera)` just before its render and `end()` just
   * after.
   */
  readonly attachPass?: boolean;
  /**
   * Draw on the WebGL2 fallback, when the browser has no WebGPU. Default true: the same passes
   * run there as transform feedback, slower, and the gaussians' draw order is sorted on the CPU and
   * lags the camera by a frame or a few. False refuses the fallback: the load throws
   * `webgpu-required`, for an app that would rather show something else.
   */
  readonly allowWebGL?: boolean;
  /**
   * Draw even when the renderer runs in software (no GPU; see {@link isSoftwareRenderer}). Default
   * false: the load throws `software-renderer` there, before anything is downloaded, since a
   * character draws at well under a frame a second on the CPU and freezes the page.
   */
  readonly allowSoftwareRenderer?: boolean;
  /**
   * Told as the character's files arrive: the bytes so far and the bytes expected in all (the
   * sizes the package lists, its shared clip pack included). Both count the files as they are,
   * not as they travel compressed. The last call has `loadedBytes === totalBytes`; the
   * character is then built on the GPU (a moment more) before `loadGameableCharacter` resolves.
   *
   * @example
   * ```ts
   * onProgress: (loaded, total) => (bar.value = total > 0 ? loaded / total : 0),
   * ```
   */
  readonly onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

/**
 * Options for {@link GameableCharacter.play}.
 *
 * @example
 * ```ts
 * character.play('wave', { fade: 0.4 });
 * ```
 */
export interface PlayOptions {
  /** Cross-fade time from the current clip, seconds. Default 0.25. */
  readonly fade?: number;
  /**
   * Loop the clip. Defaults to what the clip says (the studio marks one-shot gestures such as
   * a wave as not looping). A clip that does not loop fades back to the previous looping clip
   * when it ends.
   */
  readonly loop?: boolean;
}

/**
 * Each part's share of a look (see {@link GameableCharacter.lookAt}).
 *
 * @example
 * ```ts
 * const mostlyEyes: LookAtOptions = { head: 0.3, eyes: 1 };
 * character.lookAt(camera, mostlyEyes);
 * ```
 */
export interface LookAtOptions {
  /** How far the face turns toward the target, of the whole look. Default 0.55. */
  readonly head?: number;
  /** How much of what the head leaves the eyes take. Default 1. */
  readonly eyes?: number;
}

/**
 * A loaded character.
 *
 * @example
 * ```ts
 * scene.add(character.object3D);
 * character.play('idle');
 * character.setExpression('arkit52', { jawOpen: 0.3 });
 * // every frame: character.update(dt, camera)
 * ```
 */
export interface GameableCharacter {
  /** Add this to your scene. Move, turn and parent it like any `Object3D`; its feet are at its origin. */
  readonly object3D: Object3D;
  /** The clip names this character can play, e.g. `idle`, `wave`. */
  readonly clips: readonly string[];
  /** The clip playing now (the one fading in, during a fade). */
  readonly clip: string;
  /**
   * Play a body clip by name.
   *
   * Playing the clip that is already playing does nothing: a one-shot runs on to its end (and
   * returns to the looping clip as it would have), a looping clip keeps looping.
   *
   * @param name One of {@link clips}.
   * @param options Fade time and looping.
   * @returns Nothing.
   * @throws {Error} When the character has no clip by that name.
   */
  play(name: string, options?: PlayOptions): void;
  /**
   * Look at something: the eyes, the head and a little of the upper body turn toward it, over
   * whatever clip plays, and follow it while it moves (an `Object3D` such as your camera is
   * read every frame; so is a `Vector3` you keep changing). `null` hands the head back to the
   * clip.
   *
   * The shares are the Gameable studio's defaults ("Looks at you"): the face turns `head` of the
   * way (0.55, a tenth of the look taken by the upper body), and the eyes take `eyes` of what is
   * left (1: all of it). The head turns at most 45 degrees from the body, the eyes 35 more.
   *
   * @param target What to look at, in world space, or null.
   * @param options Each part's share, 0..1.
   * @returns Nothing.
   * @example
   * ```ts
   * character.lookAt(camera); // the visitor
   * character.lookAt(new Vector3(2, 1.5, 0), { head: 0.3 }); // a shelf, mostly with the eyes
   * character.lookAt(null); // back to the clip
   * ```
   */
  lookAt(target: Vector3 | Object3D | null, options?: LookAtOptions): void;
  /**
   * Set the face, in Apple ARKit's 52 blendshapes: an array of 52 weights in ARKit order, or
   * named weights (`{ jawOpen: 0.4, eyeBlinkLeft: 1 }`; names not given are 0; any
   * capitalisation). The weights
   * hold until the next call. Blinking carries on on top.
   *
   * @param space `'arkit52'`.
   * @param weights Weights in `[0, 1]`; one outside is clamped into it (a `NaN` is 0).
   * @returns Nothing.
   */
  setExpression(
    space: 'arkit52',
    weights: ArrayLike<number> | Readonly<Record<string, number>>,
  ): void;
  /**
   * Advance the animation and pose the character. Call once per frame, before
   * `renderer.render(scene, camera)`.
   *
   * @param dt Seconds since the last frame.
   * @param camera The camera you render with (the character's colours depend on the view).
   * @returns Nothing.
   */
  update(dt: number, camera: Camera): void;
  /**
   * Multiply the character's colour (linear light): a tint to fit it into your scene's light.
   *
   * @param color Any three colour: `'#ffe6cc'`, `0xffe6cc`, a `Color`. White is none.
   * @returns Nothing.
   * @example
   * ```ts
   * character.setTint('#ffe6cc'); // a warm room
   * ```
   */
  setTint(color: ColorRepresentation): void;
  /**
   * Multiply the character's brightness, on top of the tint.
   *
   * @param exposure 1 is as captured; 1.2 is 20 % brighter.
   * @returns Nothing.
   * @example
   * ```ts
   * character.setExposure(0.9);
   * ```
   */
  setExposure(exposure: number): void;
  /**
   * Whether the character casts a shadow into your scene's shadow maps, from its body mesh (a
   * character whose package has none casts nothing). The mesh is never drawn to the screen.
   */
  castShadow: boolean;
  /**
   * Remove the character from its parent and free its GPU memory. Idempotent.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * A share, kept in 0..1 (a non-number is 0).
 *
 * @param x The share asked for.
 * @returns It, clamped.
 */
const clampShare = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0);

/**
 * A look's shares, the Gameable studio's defaults (webapp viewer/attention.ts FOLLOW): the face
 * turns `head` of the way, the upper body `body` of it (inside the head's), the eyes all of what is
 * left.
 */
const LOOK = { head: 0.55, body: 0.1, eyes: 1 } as const;

/**
 * The aimed joints with the upper body's joint first, taking {@link LOOK}'s body share of the
 * look (so `body / head` of the aim); the neck and head share the rest as given.
 *
 * @param body The upper body's joint.
 * @param neck The neck and head joints and their fractions (summing to 1).
 * @returns The joints and fractions the animator takes.
 */
function withBody(body: string, neck: [string, number][]): [string, number][] {
  const b = LOOK.body / LOOK.head;
  return [[body, b], ...neck.map(([name, f]): [string, number] => [name, f * (1 - b)])];
}

/** Which joints the animator measures from and turns for head aim, per skeleton. */
const PROFILES = {
  // version 2: the aosrig-v2 (SOMA) skeleton the studio publishes
  v2: {
    bones: { root: 'Hips', head: 'Head' },
    headAim: withBody('Chest', [
      ['Neck1', 0.2],
      ['Neck2', 0.3],
      ['Head', 0.5],
    ]),
  },
  // version 1: aosrig_v0's glTF rig
  v1: {
    bones: { root: 'root', head: 'c_head' },
    headAim: withBody('c_spine3', [
      ['c_neck', 0.4],
      ['c_head', 0.6],
    ]),
  },
} as const;

/** Characters loaded and not yet disposed: the last one out lets the shared clip pack go. */
let liveCharacters = 0;

/**
 * Whether a clip loops, from `userData.aos.loop` (default true), as the studio writes it.
 *
 * @param clip The clip.
 * @returns True when it loops.
 */
function loops(clip: AnimationClip): boolean {
  const aos = (clip.userData as { aos?: { loop?: unknown } } | undefined)?.aos;
  return typeof aos?.loop === 'boolean' ? aos.loop : true;
}

/** Renderer names that mean the GPU is emulated on the CPU. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver/i;

/**
 * Whether the renderer runs in software: no GPU, the browser emulating one on the CPU
 * (SwiftShader, llvmpipe, Windows' basic render driver). A character draws there at well under a
 * frame a second, so {@link loadGameableCharacter} refuses it unless `allowSoftwareRenderer` is
 * set; an app can ask first and show its placeholder straight away.
 *
 * @param renderer The app's renderer, after `await renderer.init()`.
 * @returns True when it runs in software; false on a GPU or when the browser does not say.
 * @example
 * ```ts
 * await renderer.init();
 * if (isSoftwareRenderer(renderer)) showPlaceholder();
 * else scene.add((await loadGameableCharacter(renderer, url)).object3D);
 * ```
 */
export function isSoftwareRenderer(renderer: WebGPURenderer): boolean {
  const backend = (
    renderer as unknown as {
      backend?: {
        device?: { adapterInfo?: Partial<Record<string, unknown>> } | null;
        gl?: WebGL2RenderingContext | null;
      };
    }
  ).backend;
  // WebGPU: the device's adapter says so (Chrome 128+: `adapterInfo`, and `isFallbackAdapter`).
  const info = backend?.device?.adapterInfo;
  if (info) {
    if (info.isFallbackAdapter === true) return true;
    const text = ['vendor', 'architecture', 'device', 'description']
      .map((key) => (typeof info[key] === 'string' ? info[key] : ''))
      .join(' ');
    if (SOFTWARE_RENDERER.test(text)) return true;
  }
  // WebGL2: the context's renderer string (unmasked where the browser allows it).
  const gl = backend?.gl;
  if (gl) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    if (typeof name === 'string' && SOFTWARE_RENDERER.test(name)) return true;
  }
  return false;
}

/**
 * Whether the renderer draws on the WebGL2 fallback, or a clear error when it cannot take a
 * character: not initialised, or on WebGL2 with `allowWebGL: false`.
 *
 * @param renderer The app's renderer.
 * @param allowWebGL Accept the WebGL2 fallback instead of refusing it.
 * @returns True on the WebGL2 fallback.
 */
function checkRenderer(renderer: WebGPURenderer, allowWebGL: boolean): boolean {
  // three's renderer makes its backend in the constructor and sets `_initialized` in `init()`.
  const state = renderer as unknown as {
    _initialized?: boolean;
    backend?: { isWebGLBackend?: boolean };
  };
  if (state._initialized !== true) {
    throw new GameableCharacterError(
      'renderer-not-ready',
      'loadGameableCharacter: call `await renderer.init()` before loading a character.',
    );
  }
  const webgl = state.backend?.isWebGLBackend === true;
  if (webgl && !allowWebGL) {
    throw new GameableCharacterError(
      'webgpu-required',
      'loadGameableCharacter: the renderer is on the WebGL2 fallback (this browser has no ' +
        'WebGPU, or it is turned off) and `allowWebGL: false` refuses it. Use a browser with ' +
        'WebGPU (Chrome, Edge, Safari 26+), or leave `allowWebGL` on to draw on WebGL2 (slower).',
    );
  }
  return webgl;
}

/**
 * Free a material and the textures it holds.
 *
 * @param material A mesh's material, or several.
 * @returns Nothing.
 */
function disposeMaterial(material: Material | Material[] | undefined): void {
  for (const m of Array.isArray(material) ? material : material ? [material] : []) {
    for (const value of Object.values(m)) {
      if ((value as Partial<Texture> | null)?.isTexture === true) (value as Texture).dispose();
    }
    m.dispose();
  }
}

/**
 * Free a shadow caster: its geometry and its material.
 *
 * @param mesh The caster.
 * @returns Nothing.
 */
function disposeCaster(mesh: SkinnedMesh): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  disposeMaterial(mesh.material);
}

/**
 * The character's shadow casters: its body mesh, skinned to its own bones and never drawn to the
 * screen. Version 2: the package's `body.glb` (at the bind, skinned on the skeleton's joints by
 * name), bound to the rig's bones with the skeleton's inverse binds, as the engine host binds it.
 * Version 1: the rig glTF's own skinned meshes.
 *
 * @param body Version 2: the skeleton, `body.glb`'s bytes and the rig's bones in the skeleton's
 *   order. Undefined for version 1.
 * @param rig The rig.
 * @returns The meshes, already under the rig.
 */
async function shadowCasters(
  body: { skeleton: SomaSkeleton; glb: Uint8Array | undefined; bones: Bone[] } | undefined,
  rig: Object3D,
): Promise<SkinnedMesh[]> {
  const out: SkinnedMesh[] = [];
  const casting = (mesh: SkinnedMesh): void => {
    const material = new MeshBasicNodeMaterial();
    material.colorWrite = false;
    material.depthWrite = false;
    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    out.push(mesh);
  };
  if (body) {
    const { skeleton, glb: bytes, bones } = body;
    if (!bytes) return out;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    const index = new Map(skeleton.names.map((name, i) => [name, i]));
    const sources: SkinnedMesh[] = [];
    gltf.scene.traverse((node) => {
      if ((node as Partial<SkinnedMesh>).isSkinnedMesh === true) sources.push(node as SkinnedMesh);
    });
    for (const source of sources) {
      const joints = source.skeleton.bones.map((bone) => {
        const i = index.get(bone.name);
        if (i === undefined)
          throw new Error(`body.glb skins a joint the skeleton lacks: ${bone.name}`);
        return i;
      });
      const mesh = new SkinnedMesh(source.geometry);
      mesh.name = 'GameableCharacterShadow';
      mesh.bind(
        new Skeleton(
          joints.map((i) => bones[i]),
          joints.map((i) => skeleton.joints[i].inverseBind.clone()),
        ),
        source.bindMatrix,
      );
      rig.add(mesh);
      casting(mesh);
    }
    // Only the skinned geometry is kept: everything else the file made is freed.
    gltf.scene.traverse((node) => {
      const mesh = node as Partial<SkinnedMesh>;
      if (mesh.isMesh !== true) return;
      if (!sources.includes(node as SkinnedMesh)) mesh.geometry?.dispose();
      disposeMaterial(mesh.material);
    });
    return out;
  }
  rig.traverse((node) => {
    if ((node as Partial<SkinnedMesh>).isSkinnedMesh === true) {
      disposeMaterial((node as SkinnedMesh).material);
      casting(node as SkinnedMesh);
    }
  });
  return out;
}

/**
 * The body rig and its clips: version 2's skeleton built from the package, or version 1's glTF.
 *
 * @param bundle The loaded package.
 * @returns The rig root, its clips and the joint profile.
 */
async function rigOf(bundle: AosrigSplatBundle): Promise<{
  rig: Object3D;
  animations: AnimationClip[];
  profile: (typeof PROFILES)['v1' | 'v2'];
  /** Version 2: the rig's bones, in the skeleton's order. */
  bones?: Bone[];
}> {
  const soma = bundle.soma;
  if (soma) {
    const body = createSomaRig(soma.skeleton);
    return {
      rig: body.root,
      animations: soma.clips.map((clip) => somaAnimationClip(clip, soma.skeleton)),
      profile: PROFILES.v2,
      bones: body.bones,
    };
  }
  const bytes = bundle.files.get('rig.glb');
  if (!bytes) throw new Error('the package has neither a version 2 skeleton nor rig.glb');
  // Only version 1's rig (and a shadow) needs a glTF parser: loaded on demand.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );
  // The glTF's meshes are the rig's, never drawn: the splats are the character.
  gltf.scene.traverse((node) => {
    if ((node as { isMesh?: boolean }).isMesh) node.visible = false;
  });
  return { rig: gltf.scene, animations: gltf.animations, profile: PROFILES.v1 };
}

/**
 * Load a character published from the Gameable studio into your own three.js app.
 *
 * `url` is the character's `character.json`; every file it names is fetched relative to it and
 * checked against its sha256 before use, so a URL on another origin is safe to load (the host
 * must send CORS headers; the studio does). Versions 1 and 2 of the package format load, plain
 * or packed.
 *
 * The renderer must be a `WebGPURenderer` (from `three/webgpu`) on real WebGPU, initialised.
 * The character uses the renderer's own device and needs no device limits above WebGPU's
 * defaults, so there is nothing to call before `renderer.init()`.
 *
 * @param renderer Your `WebGPURenderer`, after `await renderer.init()`.
 * @param url The character's `character.json`.
 * @param options The first clip, the mouth, tint, exposure and shadow, a custom `fetch`, progress,
 *   an abort signal, and `allowWebGL`.
 * @returns The character. Add `object3D` to your scene and call `update` every frame.
 * @throws {GameableCharacterError} `webgpu-required` on the WebGL2 fallback with `allowWebGL: false`,
 *   `renderer-not-ready` before `renderer.init()`, `load-failed` when the package cannot be read
 *   or has no clip named `options.clip`, `software-renderer` when the renderer runs in software.
 *
 * @example
 * ```ts
 * import { WebGPURenderer, Scene, PerspectiveCamera, Timer } from 'three/webgpu';
 * import { loadGameableCharacter } from 'gameable/three';
 *
 * const renderer = new WebGPURenderer({ antialias: true });
 * await renderer.init();
 * const scene = new Scene();
 * const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
 * camera.position.set(0, 1.5, 3.5);
 *
 * const character = await loadGameableCharacter(renderer, 'https://studio.example/.../character.json');
 * scene.add(character.object3D);
 * character.play('wave');
 *
 * const timer = new Timer();
 * renderer.setAnimationLoop((time) => {
 *   timer.update(time);
 *   character.update(timer.getDelta(), camera);
 *   renderer.render(scene, camera);
 * });
 * ```
 */
export async function loadGameableCharacter(
  renderer: WebGPURenderer,
  url: string,
  options: LoadGameableCharacterOptions = {},
): Promise<GameableCharacter> {
  const webgl = checkRenderer(renderer, options.allowWebGL !== false);
  if (options.allowSoftwareRenderer !== true && isSoftwareRenderer(renderer)) {
    throw new GameableCharacterError(
      'software-renderer',
      'loadGameableCharacter: the renderer runs in software (no GPU: hardware acceleration is off, ' +
        'or the GPU is blocked), where a character draws at well under a frame a second. Show ' +
        'something else, or pass `allowSoftwareRenderer: true` to draw anyway.',
    );
  }

  let bundle: AosrigSplatBundle;
  let rig: Object3D, animations: AnimationClip[], profile: (typeof PROFILES)['v1' | 'v2'];
  let rigBones: Bone[] | undefined;
  // The load and the build give the page back every few milliseconds: the app's scene keeps
  // drawing while the character is unpacked and put on the GPU.
  const pause = yieldingPause();
  try {
    bundle = await loadAosrigSplatBundle(url, options.signal, {
      pause,
      // The mouth's files: mouth_hidden.bin (how the face opens between the lips) always, and the
      // teeth's points (the inside) only when options.mouth draws them.
      mouth: true,
      teeth: options.mouth === true,
      corrective: true,
      sharedClips: true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    ({ rig, animations, profile, bones: rigBones } = await rigOf(bundle));
    if (options.clip !== undefined && !animations.some((clip) => clip.name === options.clip))
      throw new Error(
        `it has no clip "${options.clip}" (it has: ${animations.map((c) => c.name).join(', ')})`,
      );
  } catch (cause) {
    throw new GameableCharacterError(
      'load-failed',
      `loadGameableCharacter: ${url} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  // What the shadow casters are made from, kept (not parsed) until castShadow first turns on.
  const shadowBody =
    bundle.soma && rigBones
      ? { skeleton: bundle.soma.skeleton, glb: bundle.files.get('body.glb'), bones: rigBones }
      : undefined;
  const object3D = new Group();
  object3D.name = 'GameableCharacter';
  object3D.add(rig);

  let sink: AnimatedSplat | null = null;
  let teethSink: AnimatedSplat | null = null;
  let runtime: AosrigSplatRuntime | null = null;
  let animator: Animator | null = null;
  try {
    // The file's colours (sRGB unless it says otherwise) on the studio's kernel: an sRGB
    // character blends on its sRGB values in the pass attachSrgbPass hooks into the scene. The
    // inside of the mouth: the teeth's points in a sink of their own, drawn with the mouth's mesh
    // into a small render of their own, then laid over the lips' opening. On WebGL2 three runs the
    // passes as transform feedback, and gameable/splat sorts on the CPU from a readback.
    ({ runtime, sink, teethSink } = await buildAosrigCharacter({
      bundle,
      rig,
      renderer,
      webgl,
      mouth: options.mouth === true,
      pause,
      makeSink: (request) => createAnimatedSplat(renderer, request),
      releaseBuffer: (attribute) => {
        releaseStorageAttribute(renderer, attribute);
      },
      onMouthError: (error) => {
        console.warn(`loadGameableCharacter: ${url} draws without its mouth interior:`, error);
      },
    }));
    object3D.add(sink.object3D);
    // The GPU has everything: drop the package's bytes.
    bundle.files.clear();

    const mapper = runtime.mapper;
    animator = createAnimator({
      root: rig,
      expressionSpace: { kind: 'gnm', dim: mapper.dim, map: mapper.map },
      bones: profile.bones,
      headAim: { joints: profile.headAim, share: LOOK.head, eyeShare: LOOK.eyes },
    });
  } catch (cause) {
    runtime?.dispose();
    sink?.dispose();
    teethSink?.dispose();
    throw new GameableCharacterError(
      'load-failed',
      `loadGameableCharacter: ${url} loaded but could not be built: ${String(cause)}`,
      { cause },
    );
  }

  // The sRGB pass on the scene the character is in (attached on the first update there).
  let pass: SrgbPass | null = null;
  let passScene: Scene | null = null;

  const clips = new Map<string, { clip: AnimationClip; loop: boolean }>();
  // How each clip is registered with the animator now: its own setting until `play` overrides it.
  const looping = new Map<string, boolean>();
  for (const clip of animations) {
    const loop = loops(clip);
    animator.addClip(clip.name, clip, { loop });
    clips.set(clip.name, { clip, loop });
    looping.set(clip.name, loop);
  }
  const names = [...clips.keys()];

  const state = {
    clips: [] as CharacterClipRequest[],
    velocity: [0, 0, 0] as [number, number, number],
    grounded: true,
    lookAt: null as [number, number, number] | null,
    expression: undefined as Float32Array | undefined,
  };
  // What the character looks at (lookAt), read into state.lookAt every frame.
  let lookTarget: Vector3 | Object3D | null = null;
  const lookPoint = new Vector3();
  const facing = new Vector3();
  const rigTurn = new Quaternion();
  // The aimed bones: the animator folds its head aim into bodyPose and leaves three's bones alone
  // (a rig backend reading jointOverrides would apply it twice), but here the bones ARE what the
  // character is skinned from, so the aim is put onto them after each update and taken off again
  // before the next (a clip without a track for a bone would otherwise keep last frame's aim).
  const aimBones = profile.headAim.flatMap(([joint]) => {
    const bone = rig.getObjectByName(joint);
    return bone ? [{ joint, bone, base: new Quaternion(), aimed: false }] : [];
  });
  const aimDelta = new Quaternion();
  // The colour scale: tint times exposure, in linear light, on the splat itself.
  const tint = new Color(options.tint ?? 0xffffff);
  let exposure = options.exposure ?? 1;
  const applyColor = (): void => {
    const r = tint.r * exposure,
      g = tint.g * exposure,
      b = tint.b * exposure;
    sink.setColorScale(r, g, b);
    // the inside of the mouth is lit as the rest of the character is
    teethSink?.setColorScale(r, g, b);
  };
  applyColor();
  // The shadow casters, made the first time castShadow turns on.
  let shadow = false;
  let casters: SkinnedMesh[] = [];
  let castersMade: Promise<void> | null = null;
  const setShadow = (on: boolean): void => {
    shadow = on;
    for (const mesh of casters) mesh.visible = on;
    if (!on || castersMade) return;
    castersMade = shadowCasters(shadowBody, rig)
      .then((made) => {
        if (disposed) {
          for (const mesh of made) disposeCaster(mesh);
          return;
        }
        casters = made;
        for (const mesh of casters) mesh.visible = shadow;
      })
      .catch((error: unknown) => {
        console.warn(`loadGameableCharacter: ${url} casts no shadow:`, error);
      })
      .finally(() => {
        if (shadowBody) shadowBody.glb = undefined;
      });
  };
  const restoreAim = (): void => {
    for (const aim of aimBones) {
      if (aim.aimed) aim.bone.quaternion.copy(aim.base);
      aim.aimed = false;
    }
  };
  const applyAim = (): void => {
    for (const aim of aimBones) {
      const q = animator.jointOverrides.get(aim.joint);
      if (q === undefined) continue;
      aim.base.copy(aim.bone.quaternion);
      aimDelta.set(q[0], q[1], q[2], q[3]);
      aim.bone.quaternion.premultiply(aimDelta);
      aim.aimed = true;
    }
  };
  // The clip fading in, the one fading out, and where a one-shot returns to (clipDrive.ts).
  const drive = createClipDrive(
    new Map([...clips].map(([name, c]) => [name, { duration: c.clip.duration, loop: c.loop }])),
    (requests) => {
      state.clips.length = 0;
      state.clips.push(...requests);
      animator.setState(state);
    },
  );

  const arkit = new Float32Array(ARKIT_NAMES.length);

  let disposed = false;
  const character: GameableCharacter = {
    object3D,
    clips: names,
    get clip() {
      return drive.current;
    },
    play(name, playOptions = {}) {
      if (disposed) return;
      const entry = clips.get(name);
      const loop = playOptions.loop ?? entry?.loop;
      // The animator loops a clip as it was registered: registered again when the caller asks
      // otherwise (the drive handles the return to the looping clip).
      if (entry && loop !== undefined && loop !== looping.get(name) && name !== drive.current) {
        animator.addClip(name, entry.clip, { loop });
        looping.set(name, loop);
      }
      drive.play(name, playOptions);
    },
    setTint(color) {
      tint.set(color);
      applyColor();
    },
    setExposure(value) {
      exposure = Number.isFinite(value) && value >= 0 ? value : 1;
      applyColor();
    },
    get castShadow() {
      return shadow;
    },
    set castShadow(on) {
      if (!disposed) setShadow(on);
    },
    lookAt(target, lookOptions = {}) {
      if (disposed) return;
      lookTarget = target;
      animator.headAim.share = clampShare(lookOptions.head ?? LOOK.head);
      animator.headAim.eyeShare = clampShare(lookOptions.eyes ?? LOOK.eyes);
      if (target === null) {
        state.lookAt = null;
        animator.setState(state);
      }
    },
    setExpression(space, weights) {
      // Checked at run time too: a JavaScript caller is not held to the type.
      if ((space as string) !== 'arkit52') {
        throw new Error(
          `GameableCharacter.setExpression: unknown space "${space as string}"; use 'arkit52'`,
        );
      }
      if (disposed) return;
      writeArkitWeights(weights, arkit);
      state.expression = arkit;
      animator.setState(state);
    },
    update(dt, camera) {
      if (disposed) return;
      drive.update(dt);
      if (lookTarget) {
        if ((lookTarget as Partial<Vector3>).isVector3 === true)
          lookPoint.copy(lookTarget as Vector3);
        else (lookTarget as Object3D).getWorldPosition(lookPoint);
        state.lookAt = [lookPoint.x, lookPoint.y, lookPoint.z];
        animator.setState(state);
      }
      // The character's facing in the world (an app turns object3D, not the rig's root).
      rig.getWorldQuaternion(rigTurn);
      facing.set(0, 0, 1).applyQuaternion(rigTurn);
      restoreAim();
      animator.update(dt, { bodyYaw: Math.atan2(facing.x, facing.z) });
      applyAim();
      runtime.render(animator.expression, animator.gaze, camera);
      sink.object3D.visible = true;
      // The scene it is in draws its splats in the sRGB pass (one pass per scene, shared), unless
      // the app attaches the pass itself.
      if (options.attachPass === false) return;
      let root: Object3D = object3D;
      while (root.parent) root = root.parent;
      const scene = (root as Partial<Scene>).isScene === true ? (root as Scene) : null;
      if (scene !== passScene) {
        pass?.dispose();
        pass = scene ? attachSrgbPass(renderer, scene) : null;
        passScene = scene;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveCharacters -= 1;
      if (liveCharacters === 0) releaseSharedClips();
      object3D.removeFromParent();
      animator.dispose();
      runtime.dispose();
      sink.dispose();
      teethSink?.dispose();
      pass?.dispose();
      pass = null;
      for (const mesh of casters) disposeCaster(mesh);
      casters = [];
    },
  };

  liveCharacters += 1;
  if (options.castShadow === true) setShadow(true);
  const first = options.clip ?? (clips.has('idle') ? 'idle' : names[0]);
  if (first) character.play(first);
  return character;
}
