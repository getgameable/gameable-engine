/**
 * Shadows that show up by themselves: a character's shadow on the place it stands in, the
 * place's shadow on the character, and a soft contact shadow under the feet, from a key light
 * nobody places.
 *
 * - **The light** is read once at load, in this order: a light the game sets; the place's own
 *   panorama; the place's own gaussians seen from where the character stands; the light baked into the character's
 *   colours; a default from above and in front. A later, better answer (a place that loads
 *   after the character) turns the light smoothly over a second; it never flickers.
 * - **The casters** are each character's rig mesh, drawn from their own small scene into the key
 *   light's depth map (no second walk of the whole scene). At the soft level the place's collider
 *   and the characters (without their heads) are drawn into a second map that only characters
 *   read, so the place never shadows itself twice.
 * - **The receivers** are the place's gaussians (fork edit 16), the characters' gaussians (their
 *   own shadow without the head, whose rig mesh does not sit on the face, and the place's), and,
 *   when there is no place, a see-through ground under the characters.
 * - **Framing.** Characters standing together share one light camera over the whole map, as
 *   one character always does. Characters standing apart (see {@link clusterShadowCasters}) get
 *   a light camera each, up to four, as tiles of a 2 x 2 atlas in the same depth map: each tile has
 *   half the texels per side but covers only its own group, so two people across a room keep
 *   sharp shadows. The receivers pick the tile that holds each point.
 * - **Redraws.** The depth maps are drawn again only when something in them changed: a bone of any
 *   character (a playing clip moves them every frame, an idle one too), a character or place
 *   added, removed or moved, a collider moved, the light turning, the level changing. Otherwise
 *   the maps from the last draw stay valid and the receivers keep reading them.
 */
import {
  DepthTexture,
  DetachedBindMode,
  DoubleSide,
  FloatType,
  Float32BufferAttribute,
  FrontSide,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RenderTarget,
  Scene,
  SkinnedMesh,
  type Skeleton,
  UnsignedByteType,
  UnsignedShortType,
  Vector3,
  Vector4,
  type Object3D,
  type WebGPURenderer,
} from 'three/webgpu';
import { Fn, attribute, dot, float, positionWorld, step, uniform, vec3 } from 'three/tsl';

import { SPLAT_RENDER_ORDER } from './AnimatedSplat.js';
import {
  DEFAULT_KEY_LIGHT,
  anglesFromDirection,
  clampElevation,
  estimateKeyLightFromPanorama,
  panoramaFromGaussians,
  type KeyLightEstimate,
  type Panorama,
} from './keyLight.js';
import {
  AnimatedGaussianSplat,
  createShadowReceiver,
  shadowFactorAt,
  type SplatShadowParams,
} from './three-fork/AnimatedGaussianSplat.js';

/** How much shadow to draw. */
export type ShadowQuality = 'off' | 'contact' | 'simple' | 'soft';

/** Every level, lowest first. */
export const SHADOW_QUALITIES: readonly ShadowQuality[] = ['off', 'contact', 'simple', 'soft'];

/** What a level draws. */
export interface ShadowQualityPreset {
  /** The key light's depth map, texels per side; 0 draws no cast shadow. */
  readonly mapSize: number;
  /** The edge filter: flat `[dx, dy, weight, ...]` in texels. */
  readonly taps: readonly number[];
  /** A soft dark patch under each foot. */
  readonly contact: boolean;
  /**
   * A second map for the characters themselves: their own shadow (an arm on the body) and the
   * place's collider on them. A second depth pass, so only the top level has it.
   */
  readonly characterMap: boolean;
}

/**
 * A square grid of taps with binomial weights (1-2-1, 1-4-6-4-1), `step` texels apart.
 *
 * @param side Taps per side, odd.
 * @param step Texels between taps.
 * @returns Flat `[dx, dy, weight]` triples.
 */
function binomialTaps(side: number, step: number): number[] {
  const row: number[] = [1];
  for (let k = 1; k < side; k += 1) row.push((row[k - 1] * (side - k)) / k);
  const sum = row.reduce((a, b) => a + b, 0);
  const half = (side - 1) / 2;
  const taps: number[] = [];
  for (let y = 0; y < side; y += 1)
    for (let x = 0; x < side; x += 1)
      taps.push((x - half) * step, (y - half) * step, (row[x] * row[y]) / (sum * sum));
  return taps;
}

const PRESETS: Readonly<Record<ShadowQuality, ShadowQualityPreset>> = {
  off: { mapSize: 0, taps: [], contact: false, characterMap: false },
  contact: { mapSize: 0, taps: [], contact: true, characterMap: false },
  simple: { mapSize: 1024, taps: binomialTaps(3, 2), contact: true, characterMap: false },
  soft: { mapSize: 2048, taps: binomialTaps(5, 3), contact: true, characterMap: true },
};

/**
 * What a quality level draws.
 *
 * @param quality The level.
 * @returns Its map size, filter and contact switch.
 */
export function shadowQualityPreset(quality: ShadowQuality): ShadowQualityPreset {
  return PRESETS[quality];
}

/** What {@link defaultShadowQuality} looks at; each field defaults to the browser's own answer. */
export interface ShadowDeviceHints {
  /** A touch screen is the main pointer. */
  readonly coarsePointer?: boolean;
  /** The screen's shorter side in CSS pixels. */
  readonly shortSide?: number;
  /** `navigator.deviceMemory` in GB (Chrome's rounded answer; Safari has none). */
  readonly deviceMemory?: number;
}

/**
 * The level a device starts at: soft on a computer, simple on a phone, the contact shadow alone
 * on a phone with 2 GB of memory or less.
 *
 * @param hints What is known about the device; the browser is asked for anything missing.
 * @returns The level.
 */
export function defaultShadowQuality(hints: ShadowDeviceHints = {}): ShadowQuality {
  const g = globalThis as {
    matchMedia?: (query: string) => { matches: boolean };
    innerWidth?: number;
    innerHeight?: number;
    navigator?: { deviceMemory?: number };
  };
  const coarse = hints.coarsePointer ?? g.matchMedia?.('(pointer: coarse)').matches ?? false;
  const shortSide =
    hints.shortSide ?? Math.min(g.innerWidth ?? Infinity, g.innerHeight ?? Infinity);
  const memory = hints.deviceMemory ?? g.navigator?.deviceMemory ?? 8;
  if (memory <= 2) return 'contact';
  if (coarse && shortSide < 900) return 'simple';
  return 'soft';
}

/**
 * Read a quality from untrusted text (a URL switch, a saved setting).
 *
 * @param value The text.
 * @returns The level, `'auto'`, or null when the text is neither.
 */
export function parseShadowQuality(
  value: string | null | undefined,
): ShadowQuality | 'auto' | null {
  if (value === 'auto') return 'auto';
  return SHADOW_QUALITIES.find((q) => q === value) ?? null;
}

/** Which source decided the key light's direction. */
export type KeyLightRoute = 'game' | 'panorama' | 'place gaussians' | 'character' | 'default';

/** What the shadows are doing, for a debug readout. */
export interface ShadowInfo {
  /** The level in use. */
  readonly quality: ShadowQuality;
  /** Which source decided the light. */
  readonly route: KeyLightRoute;
  /** Degrees around y from +z toward +x, where the light comes from. */
  readonly azimuth: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
  /** Light facing the key over light facing away, as read. */
  readonly keyToFill: number;
  /** How dark the place's shadow is, 0 to 1. */
  readonly strength: number;
  /** How sure the chosen source was, 0 to 1. */
  readonly confidence: number;
  /** Characters casting. */
  readonly characters: number;
  /** Places receiving. */
  readonly places: number;
  /** Whether the see-through ground is drawing (no place). */
  readonly ground: boolean;
  /** Milliseconds of CPU the last `update` took, depth passes included. */
  readonly updateMs: number;
  /** Light cameras (atlas tiles) in use: 1 when every character stands together, up to 4. */
  readonly tiles: number;
  /** Whether the last `update` drew the depth maps again (false: nothing in them had moved). */
  readonly rendered: boolean;
  /** How many times the depth maps have been drawn since the start. */
  readonly renders: number;
  /** Every source that answered, in the order they are preferred, with its answer. */
  readonly sources: readonly {
    readonly route: KeyLightRoute;
    readonly azimuth: number;
    readonly elevation: number;
    readonly confidence: number;
  }[];
}

/** A character, as the shadows need it. */
export interface ShadowCharacter {
  /** Its rig: every skinned mesh under it casts. */
  readonly rig: Object3D;
  /** Its origin stands on the floor between the feet. */
  readonly holder: Object3D;
  /** Its gaussians, which receive; null for a mesh-only character. */
  readonly splat?: AnimatedGaussianSplat | null;
  /** Metres from the holder's origin to cover around the character. Defaults to 1. */
  readonly radius?: number;
  /** The head joint: it and its children are left out of the character's own shadow. Defaults to `c_head`, then `head`. */
  readonly headBone?: string;
  /** The foot joints, for the contact shadow. Defaults to `l_foot`/`r_foot`, then `foot_l`/`foot_r`. */
  readonly footBones?: readonly string[];
  /** The light its colours were captured under, in the character's own space (see `estimateKeyLightFromSurfels`). */
  readonly captured?: KeyLightEstimate | null;
}

/** A place, as the shadows need it; every field is optional. */
export interface ShadowPlace {
  /** Its collider mesh: casts onto characters only, never onto the place itself. */
  readonly collider?: Object3D | null;
  /** Its own 360° picture, directions in world space (pass `yaw` to align it). */
  readonly panorama?: Panorama | null;
  /**
   * How far toward the light, in metres from the characters, the collider still casts. Only its
   * faces that face the light cast, so a room's own shell never shades the room. Defaults to 8.
   */
  readonly colliderReach?: number;
}

/** Options for {@link createSplatShadows}. */
export interface SplatShadowsOptions {
  /** A level, or `'auto'` (the default) for {@link defaultShadowQuality}. */
  readonly quality?: ShadowQuality | 'auto';
  /** A see-through ground under the characters when no place receives. Defaults to true. */
  readonly ground?: boolean;
  /** Seconds a later, better light takes to turn in. Defaults to 1. */
  readonly turnSeconds?: number;
  /**
   * Metres along the light a character's gaussian may sit behind its own rig mesh and still count
   * as lit. Its gaussians sit on and a little inside the smooth rig mesh that casts (loose cloth,
   * folds): at 0.02 a character lit from the front comes out blotched grey. An arm this far or
   * more in front of the body still shades it. Defaults to 0.12.
   */
  readonly characterBias?: number;
  /** The same for the place's gaussians and the see-through ground. Defaults to 0.03. */
  readonly placeBias?: number;
}

/** Where a character stands, as {@link clusterShadowCasters} needs it. */
export interface ShadowCasterSpot {
  /** World x of its origin. */
  readonly x: number;
  /** World z of its origin. */
  readonly z: number;
  /** Metres around the origin its shadow covers. */
  readonly radius: number;
}

/** Light cameras (atlas tiles) the depth map is split into at most. */
const MAX_TILES = 4;
/**
 * Groups that shared a light camera last frame stay together while that costs at most this much
 * sharpness, so characters walking near a limit do not flip between framings.
 */
const STAY_TOGETHER = 1.125;

/**
 * The circle around some spots, centred on their mean.
 *
 * @param spots Every spot.
 * @param members The indices in the group.
 * @returns Its centre's x and z and its radius.
 */
function groupCircle(
  spots: readonly ShadowCasterSpot[],
  members: readonly number[],
): { x: number; z: number; radius: number } {
  let x = 0;
  let z = 0;
  for (const i of members) {
    x += spots[i].x;
    z += spots[i].z;
  }
  x /= members.length;
  z /= members.length;
  let radius = 0;
  for (const i of members)
    radius = Math.max(radius, Math.hypot(spots[i].x - x, spots[i].z - z) + spots[i].radius);
  return { x, z, radius };
}

/**
 * The size of the coarsest texel over some groups, in units of the map's own: one group has the
 * whole map, more share a 2 x 2 atlas with half the texels per side.
 *
 * @param radii Each group's radius.
 * @returns The worst texel, up to a constant.
 */
function worstTexel(radii: readonly number[]): number {
  return (radii.length > 1 ? 2 : 1) * Math.max(...radii);
}

/**
 * Group characters for the shadow's light cameras: those standing together share one, those
 * standing apart get one each, at most four groups. Two groups join when their circles overlap,
 * or when joining leaves no texel coarser (one group has the whole map; two to four share it as
 * a 2 x 2 atlas, half the texels per side each). Groups that were together last frame
 * (`previous`) stay together a little longer, so a walk past a limit does not flicker. With more
 * than four groups the two with the smallest circle around both join. Groups are numbered by
 * their first member, so a lone character is always group 0.
 *
 * @param spots Where each character stands.
 * @param previous Each spot's group last frame, -1 for a new one; empty for none.
 * @param out An array to fill and return, to spare an allocation per frame.
 * @returns Each spot's group, 0 to 3.
 * @example
 * ```ts
 * import { clusterShadowCasters } from 'gameable/splat';
 * // Two people side by side, a third across the room.
 * clusterShadowCasters([
 *   { x: 0, z: 0, radius: 1 },
 *   { x: 1, z: 0, radius: 1 },
 *   { x: 8, z: 0, radius: 1 },
 * ]); // [0, 0, 1]
 * ```
 */
export function clusterShadowCasters(
  spots: readonly ShadowCasterSpot[],
  previous: readonly number[] = [],
  out: number[] = [],
): number[] {
  out.length = spots.length;
  if (spots.length <= 1) {
    if (spots.length === 1) out[0] = 0;
    return out;
  }
  const groups: number[][] = spots.map((_, i) => [i]);
  const circles = spots.map((s) => ({ x: s.x, z: s.z, radius: s.radius }));
  const together = (a: readonly number[], b: readonly number[]): boolean =>
    a.some((i) => (previous[i] ?? -1) >= 0 && b.some((j) => previous[j] === previous[i]));
  while (groups.length > 1) {
    const forced = groups.length > MAX_TILES;
    const before = worstTexel(circles.map((c) => c.radius));
    let bestA = -1;
    let bestB = -1;
    let best: { x: number; z: number; radius: number } | null = null;
    for (let a = 0; a < groups.length; a += 1)
      for (let b = a + 1; b < groups.length; b += 1) {
        const merged = groupCircle(spots, [...groups[a], ...groups[b]]);
        if (best && merged.radius >= best.radius) continue;
        if (!forced) {
          const ca = circles[a];
          const cb = circles[b];
          const overlap = Math.hypot(ca.x - cb.x, ca.z - cb.z) < ca.radius + cb.radius;
          const after = worstTexel([
            merged.radius,
            ...circles.filter((_, k) => k !== a && k !== b).map((c) => c.radius),
          ]);
          const slack = together(groups[a], groups[b]) ? STAY_TOGETHER : 1;
          if (!overlap && after > before * slack) continue;
        }
        best = merged;
        bestA = a;
        bestB = b;
      }
    if (!best) break;
    groups[bestA].push(...groups[bestB]);
    circles[bestA] = best;
    groups.splice(bestB, 1);
    circles.splice(bestB, 1);
  }
  if (groups.length > 1) {
    // One camera over everyone can still be as sharp as the tiles.
    const all = spots.map((_, i) => i);
    const wasOne = all.every((i) => (previous[i] ?? -1) >= 0 && previous[i] === previous[0]);
    const whole = groupCircle(spots, all).radius;
    if (whole <= worstTexel(circles.map((c) => c.radius)) * (wasOne ? STAY_TOGETHER : 1)) {
      out.fill(0);
      return out;
    }
  }
  groups.sort((a, b) => Math.min(...a) - Math.min(...b));
  groups.forEach((members, group) => {
    for (const i of members) out[i] = group;
  });
  return out;
}

/** The running shadows of one scene. */
export interface SplatShadows {
  /** The level in use. */
  readonly quality: ShadowQuality;
  /** What the shadows are doing. */
  readonly info: ShadowInfo;
  /**
   * Change the level; `'auto'` picks by device. Rebuilds the receivers' shaders once.
   *
   * @param quality The level.
   * @returns Nothing.
   */
  setQuality(quality: ShadowQuality | 'auto'): void;
  /**
   * Add a character: its rig casts, its gaussians receive, its colours suggest the light.
   *
   * @param key Any object that names it (the caller's own record).
   * @param character The character.
   * @returns Nothing.
   */
  addCharacter(key: object, character: ShadowCharacter): void;
  /**
   * Remove a character.
   *
   * @param key The key it was added with.
   * @returns Nothing.
   */
  removeCharacter(key: object): void;
  /**
   * Add a place: its gaussians receive, its data suggests the light.
   *
   * @param splat The place's gaussians (the fork class).
   * @param place Its collider or panorama.
   * @returns Nothing.
   */
  addPlace(splat: AnimatedGaussianSplat, place?: ShadowPlace): void;
  /**
   * Remove a place.
   *
   * @param splat The place's gaussians.
   * @returns Nothing.
   */
  removePlace(splat: AnimatedGaussianSplat): void;
  /**
   * Set the light yourself, or null to go back to reading it from the scene.
   *
   * @param light The light, world space.
   * @returns Nothing.
   */
  setKeyLight(light: KeyLightEstimate | null): void;
  /**
   * Draw the depth maps. Call once a frame after the characters are posed, before the frame renders.
   * When nothing in them moved since the last draw, the maps are kept as they are (`info.rendered`
   * says which).
   *
   * @param dt Seconds since the last call.
   * @returns Nothing.
   */
  update(dt: number): void;
  /** Release every map, material and receiver. */
  dispose(): void;
}

const LAYER_FULL = 1;
/** The characters' own map (their self-shadow and the place's shadow on them) stops at this size. */
const CHARACTER_MAP_MAX = 1024;
const LAYER_NO_HEAD = 2;
const LIGHT_DISTANCE = 40;
const MAX_CONTACTS = 16;
const HEAD_ATTRIBUTE = 'aosShadowCast';

interface CharacterState {
  readonly input: ShadowCharacter;
  readonly proxies: SkinnedMesh[];
  readonly feet: { bone: Object3D; rest: number }[];
  /** Every skeleton its proxies follow, once each: their bones decide whether the maps redraw. */
  readonly skeletons: Skeleton[];
  /** Where it stood this frame, for the grouping. */
  readonly spot: { x: number; z: number; radius: number; floor: number };
  /** Its group (atlas tile) last frame, -1 before the first. */
  tile: number;
}

/**
 * A metres value from the options: finite and not negative, or the default when left out.
 *
 * @param value The option.
 * @param fallback Its default.
 * @param name Its name, for the error.
 * @returns The metres.
 */
function metresOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} is metres, finite and not negative (got ${String(value)})`);
  return value;
}

interface PlaceState {
  readonly splat: AnimatedGaussianSplat;
  readonly place: ShadowPlace;
  readonly collider: Object3D | null;
  /** The lights read from this place, best source first; null until a character stands in it. */
  estimates: { light: KeyLightEstimate; route: KeyLightRoute }[] | null;
}

/**
 * Start shadows for one scene. Nothing is drawn until a character is added; on the WebGL fallback
 * everything is a no-op.
 *
 * @param renderer The engine's renderer.
 * @param scene The scene the ground (when there is no place) is added to.
 * @param options The level, the ground switch, how fast a new light turns in and the biases.
 * @returns The shadows.
 * @example
 * ```ts
 * import { createSplatShadows } from 'gameable/splat';
 * const shadows = createSplatShadows(engine.renderer, engine.scene, { characterBias: 0.08 });
 * shadows.addCharacter(record, { rig, holder, splat });
 * // Every frame, after the characters are posed and before the frame renders:
 * shadows.update(dt);
 * console.log(shadows.info.tiles, shadows.info.rendered);
 * ```
 */
export function createSplatShadows(
  renderer: WebGPURenderer,
  scene: Object3D,
  options: SplatShadowsOptions = {},
): SplatShadows {
  const webgpu =
    (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
      ?.isWebGPUBackend === true;
  const groundWanted = options.ground ?? true;
  const turnSeconds = Math.max(0, options.turnSeconds ?? 1);
  const characterBias = metresOption(options.characterBias, 0.12, 'characterBias');
  const placeBias = metresOption(options.placeBias, 0.03, 'placeBias');
  let quality: ShadowQuality = resolveQuality(options.quality ?? 'auto');
  let preset = PRESETS[quality];

  const characters = new Map<object, CharacterState>();
  const places = new Map<AnimatedGaussianSplat, PlaceState>();
  const casterScene = new Scene();
  casterScene.matrixWorldAutoUpdate = true;
  const lightCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, LIGHT_DISTANCE * 2);
  const coordinateSystem = (renderer as unknown as { coordinateSystem?: number }).coordinateSystem;
  if (coordinateSystem !== undefined)
    (lightCamera as unknown as { coordinateSystem: number }).coordinateSystem = coordinateSystem;
  lightCamera.updateProjectionMatrix();
  // World to each tile's light clip space; tile 0 covers the whole map when there is one group.
  const tileMatrices = Array.from({ length: MAX_TILES }, () => new Matrix4());
  const tileCentres = Array.from({ length: MAX_TILES }, () => new Vector3());
  const tileRadii = new Float64Array(MAX_TILES);
  const tileFloors = new Float64Array(MAX_TILES);
  const tileMembers = new Float64Array(MAX_TILES);
  let tileCount = 1;
  const spots: ShadowCasterSpot[] = [];
  const previousTiles: number[] = [];
  const assignment: number[] = [];
  // What the maps were last drawn from, and what they would be drawn from now (see changed()).
  let version = 0;
  let drawnFrom = new Float64Array(256).fill(Number.NaN);
  let drawnLength = -1;
  let seen = new Float64Array(256);
  let seenLength = 0;
  let rendered = false;
  let renders = 0;

  // One depth-only material per role, shared by every caster.
  const fullMaterial = new MeshBasicNodeMaterial({ side: DoubleSide });
  fullMaterial.colorWrite = false;
  // The character's own shadow leaves the head out: its rig mesh does not sit on the face's
  // gaussians, so the face would shadow itself.
  const noHeadMaterial = new MeshBasicNodeMaterial({ side: FrontSide });
  noHeadMaterial.colorWrite = false;
  noHeadMaterial.opacityNode = attribute(HEAD_ATTRIBUTE, 'float');
  noHeadMaterial.alphaTest = 0.5;
  // The collider casts from the faces that face the light only: a room's own shell faces inward,
  // away from any light outside it, so it never shades the room, while a pillar or a table (a
  // closed solid) casts from its lit side. Beyond `reach` along the light nothing casts (see
  // ShadowPlace.colliderReach).
  const colliderCentre = uniform(new Vector3());
  const colliderDirection = uniform(new Vector3(0, 1, 0));
  const colliderReach = uniform(8);
  const colliderMaterial = new MeshBasicNodeMaterial({ side: FrontSide });
  colliderMaterial.colorWrite = false;
  colliderMaterial.opacityNode = Fn(() =>
    step(dot(positionWorld.sub(colliderCentre), colliderDirection), colliderReach),
  )();
  colliderMaterial.alphaTest = 0.5;

  const placeParams: SplatShadowParams = {
    strength: 0.5,
    bias: 0,
    contactStrength: 0.4,
    contactCount: 0,
    contactRadius: 0.2,
    tileCount: 1,
  };
  const characterParams: SplatShadowParams = { strength: 0.3, bias: 0, tileCount: 1 };

  const contacts = Array.from({ length: MAX_CONTACTS }, () => new Vector4());

  let targets: { full: RenderTarget; noHead: RenderTarget | null } | null = null;
  let ground: Mesh<PlaneGeometry, MeshBasicNodeMaterial> | null = null;
  let manual: KeyLightEstimate | null = null;
  let chosen: { light: KeyLightEstimate; route: KeyLightRoute } = {
    light: DEFAULT_KEY_LIGHT,
    route: 'default',
  };
  let shown = false; // a shadow has been drawn: later changes turn in smoothly
  let sources: ShadowInfo['sources'] = [];
  let updateMs = 0;
  const current = new Vector3(...DEFAULT_KEY_LIGHT.direction);
  const target = new Vector3(...DEFAULT_KEY_LIGHT.direction);
  let disposed = false;

  const scratch = new Vector3();
  const centre = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const worldUp = new Vector3(0, 1, 0);

  /**
   * The level for `'auto'`.
   *
   * @param q A level or `'auto'`.
   * @returns The level.
   */
  function resolveQuality(q: ShadowQuality | 'auto'): ShadowQuality {
    if (!webgpu) return 'off';
    return q === 'auto' ? defaultShadowQuality() : q;
  }

  /**
   * (Re)build the two depth maps for the level.
   *
   * @returns Nothing.
   */
  function buildTargets(): void {
    version += 1;
    targets?.full.dispose();
    targets?.noHead?.dispose();
    targets = null;
    if (preset.mapSize === 0) return;
    // A phone-sized map keeps 16-bit depth (2 MB at 1024); the desk keeps 32-bit floats.
    const depthType = quality === 'simple' ? UnsignedShortType : FloatType;
    const make = (size: number): RenderTarget => {
      // The colour attachment is one byte a texel and never read: three's targets always have one.
      const t = new RenderTarget(size, size, {
        depthBuffer: true,
        format: RedFormat,
        type: UnsignedByteType,
      });
      t.depthTexture = new DepthTexture(size, size, depthType);
      return t;
    };
    targets = {
      full: make(preset.mapSize),
      noHead: preset.characterMap ? make(Math.min(preset.mapSize, CHARACTER_MAP_MAX)) : null,
    };
  }

  /**
   * Point every receiver at the current maps (or none), rebuilding their shaders once.
   *
   * @returns Nothing.
   */
  function applyReceivers(): void {
    version += 1;
    const size = preset.mapSize;
    const full = targets?.full.depthTexture ?? null;
    const noHead = targets?.noHead?.depthTexture ?? null;
    for (const state of places.values()) {
      if (quality === 'off') state.splat.setShadowReceiver(null);
      else
        state.splat.setShadowReceiver({
          map: full,
          tiles: tileMatrices,
          size,
          taps: preset.taps,
          params: placeParams,
          contacts: preset.contact ? contacts : null,
        });
    }
    for (const state of characters.values()) {
      const splat = state.input.splat;
      if (!splat) continue;
      if (noHead === null) splat.setShadowReceiver(null);
      else
        splat.setShadowReceiver({
          map: noHead,
          tiles: tileMatrices,
          size: Math.min(size, CHARACTER_MAP_MAX),
          taps: preset.taps,
          params: characterParams,
        });
    }
    rebuildGround();
  }

  /**
   * The see-through ground: shows only the shadow, where no place receives it.
   *
   * @returns Nothing.
   */
  function rebuildGround(): void {
    if (ground) {
      ground.removeFromParent();
      ground.geometry.dispose();
      ground.material.dispose();
      ground = null;
    }
    if (!groundWanted || quality === 'off' || places.size > 0) return;
    const receiver = createShadowReceiver({
      map: targets?.full.depthTexture ?? null,
      tiles: tileMatrices,
      size: preset.mapSize,
      taps: preset.taps,
      params: placeParams,
      contacts,
    });
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.colorNode = vec3(0, 0, 0);
    material.opacityNode = Fn(() => float(1).sub(shadowFactorAt(positionWorld, receiver)))();
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    ground = new Mesh(geometry, material);
    ground.name = 'gameable:shadow-ground';
    ground.frustumCulled = false;
    // Before every splat, after opaque meshes: the characters draw over it.
    ground.renderOrder = SPLAT_RENDER_ORDER - 2;
    scene.add(ground);
  }

  /**
   * Mark each vertex of a rig's geometry with how much it belongs outside the head (1) or to it (0).
   *
   * @param mesh A skinned mesh of the rig.
   * @param head The head joint's name.
   * @returns Nothing.
   */
  function markHead(mesh: SkinnedMesh, head: string): void {
    const geometry = mesh.geometry;
    if (geometry.hasAttribute(HEAD_ATTRIBUTE)) return;
    const bones = mesh.skeleton.bones;
    const inHead = new Uint8Array(bones.length);
    bones.forEach((bone, index) => {
      for (let node: Object3D | null = bone; node; node = node.parent) {
        if (node.name === head) {
          inHead[index] = 1;
          break;
        }
      }
    });
    const count = geometry.getAttribute('position').count;
    const cast = new Float32Array(count).fill(1);
    if (geometry.hasAttribute('skinIndex') && geometry.hasAttribute('skinWeight')) {
      const skinIndex = geometry.getAttribute('skinIndex');
      const skinWeight = geometry.getAttribute('skinWeight');
      for (let v = 0; v < count; v += 1) {
        let headWeight = 0;
        for (let k = 0; k < 4; k += 1) {
          const bone = skinIndex.getComponent(v, k);
          if (inHead[bone] === 1) headWeight += skinWeight.getComponent(v, k);
        }
        cast[v] = 1 - headWeight;
      }
    }
    geometry.setAttribute(HEAD_ATTRIBUTE, new Float32BufferAttribute(cast, 1));
  }

  /**
   * Choose the light from everything known, and start turning to it.
   *
   * @returns Nothing.
   */
  function choose(): void {
    const answers: { light: KeyLightEstimate; route: KeyLightRoute }[] = [];
    if (manual) answers.push({ light: manual, route: 'game' });
    // A place decides by its first source (its panorama, else its gaussians).
    const order: KeyLightRoute[] = ['panorama', 'place gaussians'];
    const deciding = new Set<{ light: KeyLightEstimate; route: KeyLightRoute }>();
    for (const state of places.values()) if (state.estimates?.[0]) deciding.add(state.estimates[0]);
    for (const route of order)
      for (const state of places.values())
        for (const estimate of state.estimates ?? [])
          if (estimate.route === route) answers.push(estimate);
    for (const state of characters.values()) {
      const captured = state.input.captured;
      if (!captured) continue;
      // The capture's direction is in the character's own space: turn it by its facing.
      state.input.holder.updateWorldMatrix(true, false);
      const turned = scratch
        .set(...captured.direction)
        .transformDirection(state.input.holder.matrixWorld);
      const direction = clampElevation([turned.x, turned.y, turned.z], 35, 65);
      const [azimuth, elevation] = anglesFromDirection(direction);
      answers.push({ light: { ...captured, direction, azimuth, elevation }, route: 'character' });
      break;
    }
    sources = answers.map(({ light, route }) => ({
      route,
      azimuth: light.azimuth,
      elevation: light.elevation,
      confidence: light.confidence,
    }));
    // A game's light wins; then a place that is sure of its light; then a character whose
    // colours carry a clear key; then a place that is not sure; then the default.
    const next = answers.find((a) => a.route === 'game') ??
      answers.find((a) => deciding.has(a) && a.light.confidence >= 0.3) ??
      answers.find((a) => a.route === 'character' && a.light.confidence >= 0.15) ??
      answers.find((a) => deciding.has(a)) ?? {
        light: DEFAULT_KEY_LIGHT,
        route: 'default' as const,
      };
    chosen = next;
    target.set(...next.light.direction).normalize();
    if (!shown) current.copy(target);
    // The strength follows the key-to-fill balance, held where a shadow still reads and never
    // blacks a place out; the character's own shadow is gentler (its capture has shading already).
    const strength = Math.min(0.8, Math.max(0.25, next.light.shadowStrength));
    placeParams.strength = strength;
    characterParams.strength = strength * 0.6;
    placeParams.contactStrength = preset.mapSize === 0 ? 0.5 : 0.35;
  }

  /**
   * Read a place's light now that a character stands in it.
   *
   * @param state The place.
   * @param at Where the character stands (chest height), world space.
   * @returns Nothing.
   */
  function readPlace(state: PlaceState, at: Vector3): void {
    const { place, splat } = state;
    const estimates: { light: KeyLightEstimate; route: KeyLightRoute }[] = [];
    const attempt = (route: KeyLightRoute, read: () => KeyLightEstimate | null): void => {
      if (estimates.length > 0) return;
      try {
        const light = read();
        if (light) estimates.push({ light, route });
      } catch (cause) {
        console.warn(
          `gameable: the place's ${route} could not be read (${String(cause)}); using the next source.`,
        );
      }
    };
    if (place.panorama) {
      const panorama = place.panorama;
      attempt('panorama', () =>
        estimateKeyLightFromPanorama(panorama, { minElevation: 0, holdAbove: 20 }),
      );
    }
    attempt('place gaussians', () => {
      const geometry = splat.splatGeometry;
      const position = geometry?.getAttribute('position');
      const color = geometry?.getAttribute('color');
      if (!position || !color) return null;
      splat.updateWorldMatrix(true, false);
      const panorama = panoramaFromGaussians(
        {
          positions: position.array,
          colors: color.array,
          colorScale: color.array instanceof Float32Array ? 1 : 1 / 255,
          matrixWorld: splat.matrixWorld.elements,
        },
        [at.x, at.y, at.z],
      );
      return estimateKeyLightFromPanorama(panorama, { minElevation: 0, holdAbove: 20 });
    });
    state.estimates = estimates;
  }

  /**
   * Keep the ground, the light cameras and the contact points on the characters.
   *
   * @returns Whether anything casts this frame.
   */
  function frame(): boolean {
    if (characters.size === 0) return false;
    // The characters' world matrices, bones included, as they will render this frame.
    centre.set(0, 0, 0);
    let floorY = Infinity;
    let count = 0;
    for (const state of characters.values()) {
      state.input.holder.updateWorldMatrix(true, true);
      state.input.holder.getWorldPosition(scratch);
      centre.add(scratch);
      floorY = Math.min(floorY, scratch.y);
      state.spot.x = scratch.x;
      state.spot.z = scratch.z;
      state.spot.floor = scratch.y;
      state.spot.radius = state.input.radius ?? 1;
      spots[count] = state.spot;
      previousTiles[count] = state.tile;
      count += 1;
    }
    spots.length = count;
    previousTiles.length = count;
    centre.divideScalar(characters.size);
    let radius = 0;
    for (const state of characters.values()) {
      radius = Math.max(
        radius,
        Math.hypot(state.spot.x - centre.x, state.spot.z - centre.z) + state.spot.radius,
      );
    }

    // Contact points: each foot on the floor, fading as it lifts.
    let n = 0;
    for (const state of characters.values()) {
      const floor = state.spot.floor;
      for (const foot of state.feet) {
        if (n >= MAX_CONTACTS) break;
        foot.bone.getWorldPosition(scratch);
        const lift = Math.max(0, scratch.y - floor - foot.rest);
        const weight = 1 - Math.min(1, Math.max(0, (lift - 0.03) / 0.3));
        contacts[n].set(scratch.x, floor, scratch.z, weight);
        n += 1;
      }
    }
    placeParams.contactCount = preset.contact ? n : 0;

    if (ground) {
      ground.position.set(centre.x, floorY + 0.002, centre.z);
      ground.scale.setScalar(Math.max(6, radius * 2 + 4));
      ground.visible = quality !== 'off';
    }

    // The groups: one light camera each. One group is every character, framed as a whole.
    clusterShadowCasters(spots, previousTiles, assignment);
    tileCount = 1;
    for (let t = 0; t < MAX_TILES; t += 1) {
      tileCentres[t].set(0, 0, 0);
      tileRadii[t] = 0;
      tileFloors[t] = Infinity;
      tileMembers[t] = 0;
    }
    let index = 0;
    for (const state of characters.values()) {
      const t = assignment[index];
      index += 1;
      state.tile = t;
      tileCount = Math.max(tileCount, t + 1);
      tileCentres[t].x += state.spot.x;
      tileCentres[t].z += state.spot.z;
      tileFloors[t] = Math.min(tileFloors[t], state.spot.floor);
      tileMembers[t] += 1;
    }
    for (let t = 0; t < tileCount; t += 1) {
      tileCentres[t].x /= tileMembers[t];
      tileCentres[t].z /= tileMembers[t];
      tileCentres[t].y = tileFloors[t] + 0.9;
    }
    for (const state of characters.values()) {
      const c = tileCentres[state.tile];
      tileRadii[state.tile] = Math.max(
        tileRadii[state.tile],
        Math.hypot(state.spot.x - c.x, state.spot.z - c.z) + state.spot.radius,
      );
    }
    placeParams.tileCount = tileCount;
    characterParams.tileCount = tileCount;

    // The light cameras: looking along the key, each framing its group, snapped to whole texels
    // so a walking character's shadow edge does not shimmer. They share one depth range, so one
    // bias fits every tile.
    const d = current;
    up.copy(Math.abs(d.y) > 0.99 ? scratch.set(0, 0, 1) : worldUp);
    right.crossVectors(up, d).normalize();
    up.crossVectors(d, right).normalize();
    let far = 0;
    for (let t = 0; t < tileCount; t += 1) far = Math.max(far, LIGHT_DISTANCE + tileRadii[t] + 2);
    const side = tileSide(preset.mapSize);
    for (let t = 0; t < tileCount; t += 1) {
      const c = tileCentres[t];
      if (side > 0) {
        const texel = (2 * tileRadii[t]) / side;
        const r = Math.round(c.dot(right) / texel) * texel - c.dot(right);
        const u = Math.round(c.dot(up) / texel) * texel - c.dot(up);
        c.addScaledVector(right, r).addScaledVector(up, u);
      }
      aim(t, far);
      tileMatrices[t].multiplyMatrices(
        lightCamera.projectionMatrix,
        lightCamera.matrixWorldInverse,
      );
    }
    let reach = Infinity;
    for (const state of places.values())
      if (state.collider) reach = Math.min(reach, state.place.colliderReach ?? 8);
    colliderReach.value = Number.isFinite(reach) ? reach : 8;
    // Depth bias, in the map's 0..1 units (see SplatShadowsOptions.characterBias).
    const span = far - lightCamera.near;
    placeParams.bias = placeBias / span;
    characterParams.bias = characterBias / span;
    return true;
  }

  /**
   * Texels per side of one tile: the whole map for one group, a quarter of it less a one-texel
   * gutter on each side for more.
   *
   * @param size The map's texels per side.
   * @returns The tile's.
   */
  function tileSide(size: number): number {
    return tileCount > 1 ? Math.floor(size / 2) - 2 : size;
  }

  /**
   * Point the light camera at one group (and the collider's reach, measured from the group's
   * middle along the light).
   *
   * @param t The group.
   * @param far The shared far plane.
   * @returns Nothing.
   */
  function aim(t: number, far: number): void {
    const c = tileCentres[t];
    const radius = tileRadii[t];
    const d = current;
    lightCamera.left = -radius;
    lightCamera.right = radius;
    lightCamera.top = radius;
    lightCamera.bottom = -radius;
    lightCamera.near = 0.1;
    lightCamera.far = far;
    lightCamera.updateProjectionMatrix();
    lightCamera.up.copy(up);
    lightCamera.position.copy(c).addScaledVector(d, LIGHT_DISTANCE);
    lightCamera.lookAt(c);
    lightCamera.updateMatrixWorld(true);
    colliderCentre.value.copy(c);
    colliderDirection.value.copy(d);
  }

  /**
   * Append one number to what the maps would be drawn from now, growing the buffer when needed.
   *
   * @param value The number.
   * @returns Nothing.
   */
  function note(value: number): void {
    if (seenLength === seen.length) {
      const grown = new Float64Array(seen.length * 2);
      grown.set(seen);
      seen = grown;
    }
    seen[seenLength] = value;
    seenLength += 1;
  }

  /**
   * Append a matrix's sixteen numbers.
   *
   * @param matrix The matrix.
   * @returns Nothing.
   */
  function noteMatrix(matrix: Matrix4): void {
    for (let k = 0; k < 16; k += 1) note(matrix.elements[k]);
  }

  /**
   * Append every mesh of a collider (called from traverse).
   *
   * @param node A node of the collider.
   * @returns Nothing.
   */
  function noteCollider(node: Object3D): void {
    note(node.visible ? 1 : 0);
    noteMatrix(node.matrixWorld);
  }

  /**
   * Whether anything the depth maps show changed since they were last drawn: the tiles' light
   * cameras (the light turning, a character moving, a group forming), every bone of every
   * character, every collider, and anything added, removed or rebuilt. Compares plain numbers
   * into buffers kept between frames; nothing is allocated once they have grown.
   *
   * @returns True when the maps must be drawn again.
   */
  function changed(): boolean {
    seenLength = 0;
    note(version);
    note(tileCount);
    note(colliderReach.value);
    for (let t = 0; t < tileCount; t += 1) noteMatrix(tileMatrices[t]);
    for (const state of characters.values())
      for (const skeleton of state.skeletons)
        for (const bone of skeleton.bones) noteMatrix(bone.matrixWorld);
    for (const state of places.values()) {
      if (!state.collider) continue;
      state.collider.updateMatrixWorld();
      state.collider.traverse(noteCollider);
    }
    if (seenLength === drawnLength) {
      let same = true;
      for (let k = 0; k < seenLength && same; k += 1) same = seen[k] === drawnFrom[k];
      if (same) return false;
    }
    const swap = drawnFrom;
    drawnFrom = seen;
    seen = swap;
    drawnLength = seenLength;
    return true;
  }

  /**
   * One frame: read a new place's light, turn toward the light, draw the two depth maps when
   * anything in them changed.
   *
   * @param dt Seconds since the last frame.
   * @returns Nothing.
   */
  function draw(dt: number): void {
    rendered = false;
    // A place's light is read once, the first frame a character stands in it.
    let read = false;
    for (const state of places.values()) {
      if (state.estimates !== null || characters.size === 0) continue;
      const first = characters.values().next().value;
      if (!first) break;
      first.input.holder.updateWorldMatrix(true, false);
      first.input.holder.getWorldPosition(scratch);
      readPlace(state, scratch.clone().setY(scratch.y + 1.2));
      read = true;
    }
    if (read) choose();
    // Turn smoothly toward a later, better answer; snap on the first.
    if (!current.equals(target)) {
      const t = turnSeconds > 0 ? 1 - Math.exp(-Math.max(0, dt) / (turnSeconds / 3)) : 1;
      current.lerp(target, t).normalize();
      if (current.angleTo(target) < 1e-4) current.copy(target);
    }
    if (!frame()) return;
    shown = true;
    if (targets === null || !changed()) return;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const far = lightCamera.far;
    for (const [map, layer] of [
      [targets.full, LAYER_FULL],
      [targets.noHead, LAYER_NO_HEAD],
    ] as const) {
      if (!map) continue;
      renderer.setRenderTarget(map);
      lightCamera.layers.set(layer);
      const size = map.width;
      const side = tileSide(size);
      const half = Math.floor(size / 2);
      for (let t = 0; t < tileCount; t += 1) {
        aim(t, far);
        if (tileCount > 1) {
          // The first tile clears the whole map; the rest draw beside it. The gutter keeps every
          // tile off the map's corner, where three would take a full-size viewport for none.
          map.viewport.set((t % 2) * half + 1, Math.floor(t / 2) * half + 1, side, side);
          renderer.autoClear = t === 0;
        }
        renderer.render(casterScene, lightCamera);
      }
      map.viewport.set(0, 0, size, size);
    }
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(previous);
    rendered = true;
    renders += 1;
  }

  const shadows: SplatShadows = {
    get quality() {
      return quality;
    },

    get info(): ShadowInfo {
      const [azimuth, elevation] = anglesFromDirection([current.x, current.y, current.z]);
      return {
        quality,
        route: chosen.route,
        azimuth,
        elevation,
        keyToFill: chosen.light.keyToFill,
        strength: placeParams.strength,
        confidence: chosen.light.confidence,
        characters: characters.size,
        places: places.size,
        ground: ground !== null,
        updateMs,
        tiles: tileCount,
        rendered,
        renders,
        sources,
      };
    },

    setQuality(next) {
      if (disposed) return;
      const resolved = resolveQuality(next);
      if (resolved === quality) return;
      quality = resolved;
      preset = PRESETS[quality];
      buildTargets();
      applyReceivers();
      choose();
    },

    addCharacter(key, character) {
      if (disposed || characters.has(key)) return;
      const headName = character.headBone;
      const footNames = character.footBones;
      const proxies: SkinnedMesh[] = [];
      let head = headName ?? '';
      const feet: { bone: Object3D; rest: number }[] = [];
      character.rig.updateWorldMatrix(true, true);
      character.holder.updateWorldMatrix(true, false);
      const floor = character.holder.getWorldPosition(new Vector3()).y;
      if (!headName) head = character.rig.getObjectByName('c_head') ? 'c_head' : 'head';
      const footList =
        footNames ??
        (character.rig.getObjectByName('l_foot') ? ['l_foot', 'r_foot'] : ['foot_l', 'foot_r']);
      for (const name of footList) {
        const bone = character.rig.getObjectByName(name);
        if (bone) feet.push({ bone, rest: bone.getWorldPosition(new Vector3()).y - floor });
      }
      character.rig.traverse((node) => {
        const mesh = node as Partial<SkinnedMesh>;
        if (mesh.isSkinnedMesh !== true) return;
        const skinned = node as SkinnedMesh;
        markHead(skinned, head);
        for (const [layer, material] of [
          [LAYER_FULL, fullMaterial],
          [LAYER_NO_HEAD, noHeadMaterial],
        ] as const) {
          // Same geometry, same skeleton: the proxy moves with the rig at no upload cost. In
          // detached mode, with the bind matrix as its own, it lands where the rig does.
          const proxy = new SkinnedMesh(skinned.geometry, material);
          proxy.bind(skinned.skeleton, skinned.bindMatrix);
          proxy.bindMode = DetachedBindMode;
          proxy.matrixAutoUpdate = false;
          proxy.matrix.copy(skinned.bindMatrix);
          proxy.matrixWorldNeedsUpdate = true;
          proxy.frustumCulled = false;
          proxy.layers.set(layer);
          casterScene.add(proxy);
          proxies.push(proxy);
        }
      });
      const skeletons = [...new Set(proxies.map((proxy) => proxy.skeleton))];
      characters.set(key, {
        input: character,
        proxies,
        feet,
        skeletons,
        spot: { x: 0, z: 0, radius: 1, floor: 0 },
        tile: -1,
      });
      applyReceivers();
      choose();
    },

    removeCharacter(key) {
      const state = characters.get(key);
      if (!state) return;
      characters.delete(key);
      for (const proxy of state.proxies) proxy.removeFromParent();
      state.input.splat?.setShadowReceiver(null);
      applyReceivers();
      choose();
    },

    addPlace(splat, place = {}) {
      if (disposed) return;
      // Announcing a place again replaces what was said before (a collider found later).
      if (places.has(splat)) shadows.removePlace(splat);
      if (!(splat instanceof AnimatedGaussianSplat))
        throw new TypeError('A place receives shadows only as an AnimatedGaussianSplat');
      let collider: Object3D | null = null;
      if (place.collider) {
        collider = place.collider;
        collider.traverse((node) => {
          const mesh = node as Partial<Mesh>;
          if (mesh.isMesh === true) (node as Mesh).material = colliderMaterial;
          node.layers.set(LAYER_NO_HEAD);
        });
        collider.visible = true;
        casterScene.add(collider);
      }
      places.set(splat, { splat, place, collider, estimates: null });
      applyReceivers();
    },

    removePlace(splat) {
      const state = places.get(splat);
      if (!state) return;
      places.delete(splat);
      state.collider?.removeFromParent();
      splat.setShadowReceiver(null);
      applyReceivers();
      choose();
    },

    setKeyLight(light) {
      manual = light;
      choose();
    },

    update(dt) {
      if (disposed || quality === 'off' || !webgpu) {
        updateMs = 0;
        rendered = false;
        return;
      }
      const started = performance.now();
      draw(dt);
      updateMs = performance.now() - started;
    },

    dispose() {
      if (disposed) return;
      for (const state of places.values()) {
        state.splat.setShadowReceiver(null);
        state.collider?.removeFromParent();
      }
      for (const state of characters.values()) {
        state.input.splat?.setShadowReceiver(null);
        for (const proxy of state.proxies) proxy.removeFromParent();
      }
      places.clear();
      characters.clear();
      disposed = true;
      targets?.full.dispose();
      targets?.noHead?.dispose();
      targets = null;
      if (ground) {
        ground.removeFromParent();
        ground.geometry.dispose();
        ground.material.dispose();
        ground = null;
      }
      fullMaterial.dispose();
      noHeadMaterial.dispose();
      colliderMaterial.dispose();
    },
  };

  buildTargets();
  return shadows;
}
