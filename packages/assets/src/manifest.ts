/**
 * `assets.json` types, a hand-written validator and URL resolution.
 *
 * The shapes here mirror `docs/schemas/assets.schema.json` exactly. Validation
 * is hand-written on purpose: the manifest is small, the errors need to be
 * readable by a person and by a language model, and the engine must not carry a
 * JSON Schema validator into the browser bundle.
 */

/** What the host should load an entry as. */
export type AssetType = 'splat' | 'gltf' | 'character' | 'audio';

/** Collision proxy shapes understood by the physics module. */
export type ColliderShape = 'mesh' | 'box' | 'sphere' | 'capsule' | 'convex-hull' | 'heightfield';

/** Physics layer a collider belongs to. */
export type ColliderLayer = 'static' | 'dynamic' | 'trigger';

/**
 * Which `RigBackend` drives a character.
 *
 * `orl` and `gnm` are splat head rigs and need a baked pack; `skinned` is a
 * whole body — a glTF/GLB with `JOINTS_0`/`WEIGHTS_0` and its clips embedded,
 * so it needs no `pack` at all.
 */
export type RigBackend = 'orl' | 'gnm' | 'skinned' | 'aosrig-splat';

/** Coordinate space a character's expression vector is expressed in. */
export type ExpressionSpaceKind = 'arkit52' | 'gnm' | 'gnm68';

/** A three-component vector, as written in the manifest. */
export type Vec3 = readonly [number, number, number];

/** A named contiguous span of an expression vector. */
export interface ExpressionSegment {
  /** Segment name, for example `left_eye`. */
  readonly name: string;
  /** First index of the span. */
  readonly offset: number;
  /** Number of components in the span. */
  readonly length: number;
}

/** Layout of the expression vector a character rig consumes. */
export interface ExpressionSpace {
  /** Which well-known expression space this is. */
  readonly kind: ExpressionSpaceKind;
  /** Number of components in the vector. */
  readonly dim: number;
  /** Optional per-component names. */
  readonly names?: readonly string[];
  /** Optional named spans of the vector. */
  readonly segments?: readonly ExpressionSegment[];
  /** Path to an ARKit-52 to this-space mapping, when `kind` is not `arkit52`. */
  readonly arkitMap?: string;
}

/** Static collision proxy registered with physics when the asset loads. */
export interface AssetCollider {
  /** Collider shape. */
  readonly shape: ColliderShape;
  /** Path to collision geometry, for shapes that need their own mesh. */
  readonly src?: string;
  /** Box half extents. Required when `shape` is `box`. */
  readonly halfExtents?: Vec3;
  /** Sphere or capsule radius. Required for `sphere` and `capsule`. */
  readonly radius?: number;
  /** Capsule height. Required for `capsule`. */
  readonly height?: number;
  /** Offset from the entity origin. */
  readonly offset?: Vec3;
  /** Physics layer. Defaults to `static`. */
  readonly layer?: ColliderLayer;
}

/** Character rig configuration. */
export interface AssetRig {
  /**
   * Which backend drives the character.
   *
   * `'skinned'` means `src` is itself a glTF/GLB carrying `JOINTS_0`/`WEIGHTS_0`
   * and its animations, so no {@link AssetRig.pack} is involved.
   */
  readonly backend: RigBackend;
  /** Path to the baked `.aosrig` pack. Required when `backend` is `gnm`. */
  readonly pack?: string;
  /** Ordered rig control names; the index is the wire format. */
  readonly controlNames?: readonly string[];
  /** Vertices the rig stage produces per frame. */
  readonly vertexCount?: number;
  /** Layout of the expression vector. */
  readonly expressionSpace?: ExpressionSpace;
  /**
   * More clip files the character plays besides its own (`aosrig-splat` version 2: files of
   * its `clips.json` format), each resolved like `pack`: beside `src`, or absolute.
   */
  readonly clips?: readonly string[];
}

/** One manifest entry. */
export interface AssetEntry {
  /** Stable identifier used by game logic. Renaming it is a breaking change. */
  readonly id: string;
  /** What the host should load this as. */
  readonly type: AssetType;
  /** Relative path (resolved against `baseUrl`) or absolute URL. */
  readonly src: string;
  /** Free-form labels for grouping and preload policies. */
  readonly tags?: readonly string[];
  /** Static collision proxy. */
  readonly collider?: AssetCollider;
  /** Character rig configuration. Required when `type` is `character`. */
  readonly rig?: AssetRig;
}

/** A parsed, validated `assets.json`. */
export interface AssetManifest {
  /** Manifest schema version. `1` is the only value today. */
  readonly version: 1;
  /** Prefix joined to every relative `src`. */
  readonly baseUrl: string;
  /** Every asset the game can reference. */
  readonly assets: readonly AssetEntry[];
}

/**
 * A manifest that failed validation.
 *
 * `path` is a JSON-pointer-ish location such as `assets[2].collider.radius`, so
 * the message alone is enough to find and fix the problem.
 *
 * @example
 * ```ts
 * import { ManifestError, parseManifest } from 'gameable/assets';
 *
 * try {
 *   parseManifest({ version: 1 });
 * } catch (err) {
 *   if (err instanceof ManifestError) console.error(err.path, err.message);
 * }
 * ```
 */
export class ManifestError extends Error {
  /** Location of the offending value inside the manifest. */
  readonly path: string;

  /**
   * Build a manifest validation error.
   *
   * @param path Location of the offending value, for example `assets[0].id`.
   * @param message What is wrong with it.
   */
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ManifestError';
    this.path = path;
  }
}

/** Options accepted by {@link parseManifest}. */
export interface ParseManifestOptions {
  /** Fallback `baseUrl` when the manifest does not declare one. */
  readonly baseUrl?: string;
}

/** Options accepted by {@link loadManifest}. */
export interface LoadManifestOptions extends ParseManifestOptions {
  /** `fetch` implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort signal forwarded to `fetch`. */
  readonly signal?: AbortSignal;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;
const ASSET_TYPES: readonly AssetType[] = ['splat', 'gltf', 'character', 'audio'];
const COLLIDER_SHAPES: readonly ColliderShape[] = [
  'mesh',
  'box',
  'sphere',
  'capsule',
  'convex-hull',
  'heightfield',
];
const COLLIDER_LAYERS: readonly ColliderLayer[] = ['static', 'dynamic', 'trigger'];
const RIG_BACKENDS: readonly RigBackend[] = ['orl', 'gnm', 'skinned', 'aosrig-splat'];
const EXPRESSION_KINDS: readonly ExpressionSpaceKind[] = ['arkit52', 'gnm', 'gnm68'];

/**
 * Narrow an unknown value to a plain JSON object.
 *
 * @param value Value to test.
 * @returns True when `value` is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject keys the schema does not declare.
 *
 * @param path Location of `obj`.
 * @param obj Object to check.
 * @param allowed Keys the schema allows.
 */
function rejectUnknown(
  path: string,
  obj: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ManifestError(
        `${path}.${key}`,
        `unknown property; expected one of ${allowed.join(', ')}`,
      );
    }
  }
}

/**
 * Read a required string.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The string.
 */
function asString(path: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(path, 'must be a non-empty string');
  }
  return value;
}

/**
 * Read a required member of a string union.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @param allowed Accepted values.
 * @returns The matched value.
 */
function asEnum<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ManifestError(path, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Read a finite number, optionally requiring it to be positive.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @param positive Whether the number must be greater than zero.
 * @returns The number.
 */
function asNumber(path: string, value: unknown, positive: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ManifestError(path, 'must be a finite number');
  }
  if (positive && value <= 0) throw new ManifestError(path, 'must be greater than 0');
  return value;
}

/**
 * Read a positive integer.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @param min Smallest accepted value.
 * @returns The integer.
 */
function asInteger(path: string, value: unknown, min: number): number {
  const n = asNumber(path, value, false);
  if (!Number.isInteger(n) || n < min) {
    throw new ManifestError(path, `must be an integer >= ${String(min)}`);
  }
  return n;
}

/**
 * Read an array of non-empty strings.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @param unique Whether duplicates are rejected.
 * @returns A frozen copy of the array.
 */
function asStringArray(path: string, value: unknown, unique: boolean): readonly string[] {
  if (!Array.isArray(value)) throw new ManifestError(path, 'must be an array of strings');
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    const s = asString(`${path}[${String(i)}]`, item);
    if (unique && out.includes(s)) {
      throw new ManifestError(`${path}[${String(i)}]`, `duplicate entry "${s}"`);
    }
    out.push(s);
  }
  return Object.freeze(out);
}

/**
 * Read a three-component vector.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The vector.
 */
function asVec3(path: string, value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ManifestError(path, 'must be an array of exactly 3 numbers');
  }
  return Object.freeze([
    asNumber(`${path}[0]`, value[0], false),
    asNumber(`${path}[1]`, value[1], false),
    asNumber(`${path}[2]`, value[2], false),
  ]);
}

/**
 * Validate one `collider` object.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The validated collider.
 */
function parseCollider(path: string, value: unknown): AssetCollider {
  if (!isRecord(value)) throw new ManifestError(path, 'must be an object');
  rejectUnknown(path, value, [
    'shape',
    'src',
    'halfExtents',
    'radius',
    'height',
    'offset',
    'layer',
  ]);

  const shape = asEnum(`${path}.shape`, value.shape, COLLIDER_SHAPES);
  const collider: {
    shape: ColliderShape;
    src?: string;
    halfExtents?: Vec3;
    radius?: number;
    height?: number;
    offset?: Vec3;
    layer?: ColliderLayer;
  } = { shape };

  if (value.src !== undefined) collider.src = asString(`${path}.src`, value.src);
  if (value.halfExtents !== undefined) {
    collider.halfExtents = asVec3(`${path}.halfExtents`, value.halfExtents);
  }
  if (value.radius !== undefined) collider.radius = asNumber(`${path}.radius`, value.radius, true);
  if (value.height !== undefined) collider.height = asNumber(`${path}.height`, value.height, true);
  if (value.offset !== undefined) collider.offset = asVec3(`${path}.offset`, value.offset);
  if (value.layer !== undefined) {
    collider.layer = asEnum(`${path}.layer`, value.layer, COLLIDER_LAYERS);
  }

  if (shape === 'box' && collider.halfExtents === undefined) {
    throw new ManifestError(`${path}.halfExtents`, 'is required when shape is "box"');
  }
  if ((shape === 'sphere' || shape === 'capsule') && collider.radius === undefined) {
    throw new ManifestError(`${path}.radius`, `is required when shape is "${shape}"`);
  }
  if (shape === 'capsule' && collider.height === undefined) {
    throw new ManifestError(`${path}.height`, 'is required when shape is "capsule"');
  }

  return Object.freeze(collider);
}

/**
 * Validate one `expressionSpace` object.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The validated expression space.
 */
function parseExpressionSpace(path: string, value: unknown): ExpressionSpace {
  if (!isRecord(value)) throw new ManifestError(path, 'must be an object');
  rejectUnknown(path, value, ['kind', 'dim', 'names', 'segments', 'arkitMap']);

  const space: {
    kind: ExpressionSpaceKind;
    dim: number;
    names?: readonly string[];
    segments?: readonly ExpressionSegment[];
    arkitMap?: string;
  } = {
    kind: asEnum(`${path}.kind`, value.kind, EXPRESSION_KINDS),
    dim: asInteger(`${path}.dim`, value.dim, 1),
  };

  if (value.names !== undefined) space.names = asStringArray(`${path}.names`, value.names, false);
  if (value.arkitMap !== undefined) space.arkitMap = asString(`${path}.arkitMap`, value.arkitMap);
  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments)) {
      throw new ManifestError(`${path}.segments`, 'must be an array');
    }
    space.segments = Object.freeze(
      value.segments.map((raw, i): ExpressionSegment => {
        const at = `${path}.segments[${String(i)}]`;
        if (!isRecord(raw)) throw new ManifestError(at, 'must be an object');
        rejectUnknown(at, raw, ['name', 'offset', 'length']);
        return Object.freeze({
          name: asString(`${at}.name`, raw.name),
          offset: asInteger(`${at}.offset`, raw.offset, 0),
          length: asInteger(`${at}.length`, raw.length, 1),
        });
      }),
    );
  }

  return Object.freeze(space);
}

/**
 * Validate one `rig` object.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The validated rig.
 */
function parseRig(path: string, value: unknown): AssetRig {
  if (!isRecord(value)) throw new ManifestError(path, 'must be an object');
  rejectUnknown(path, value, [
    'backend',
    'pack',
    'controlNames',
    'vertexCount',
    'expressionSpace',
    'clips',
  ]);

  const backend = asEnum(`${path}.backend`, value.backend, RIG_BACKENDS);
  const rig: {
    backend: RigBackend;
    pack?: string;
    controlNames?: readonly string[];
    vertexCount?: number;
    expressionSpace?: ExpressionSpace;
    clips?: readonly string[];
  } = { backend };

  if (value.pack !== undefined) rig.pack = asString(`${path}.pack`, value.pack);
  if (value.controlNames !== undefined) {
    rig.controlNames = asStringArray(`${path}.controlNames`, value.controlNames, false);
  }
  if (value.vertexCount !== undefined) {
    rig.vertexCount = asInteger(`${path}.vertexCount`, value.vertexCount, 1);
  }
  if (value.expressionSpace !== undefined) {
    rig.expressionSpace = parseExpressionSpace(`${path}.expressionSpace`, value.expressionSpace);
  }
  if (value.clips !== undefined) {
    rig.clips = asStringArray(`${path}.clips`, value.clips, true);
  }

  if (backend === 'gnm' && rig.pack === undefined) {
    throw new ManifestError(`${path}.pack`, 'is required when backend is "gnm"');
  }

  return Object.freeze(rig);
}

/**
 * Validate one asset entry.
 *
 * @param path Location of the value.
 * @param value Raw value.
 * @returns The validated entry.
 */
function parseEntry(path: string, value: unknown): AssetEntry {
  if (!isRecord(value)) throw new ManifestError(path, 'must be an object');
  rejectUnknown(path, value, ['id', 'type', 'src', 'tags', 'collider', 'rig']);

  const id = asString(`${path}.id`, value.id);
  if (id.length > 64) throw new ManifestError(`${path}.id`, 'must be at most 64 characters');
  if (!ID_PATTERN.test(id)) {
    throw new ManifestError(
      `${path}.id`,
      'must match /^[a-z0-9][a-z0-9._-]*$/ (lower-case, no spaces, no slashes)',
    );
  }

  const type = asEnum(`${path}.type`, value.type, ASSET_TYPES);
  const entry: {
    id: string;
    type: AssetType;
    src: string;
    tags?: readonly string[];
    collider?: AssetCollider;
    rig?: AssetRig;
  } = { id, type, src: asString(`${path}.src`, value.src) };

  if (value.tags !== undefined) entry.tags = asStringArray(`${path}.tags`, value.tags, true);
  if (value.collider !== undefined)
    entry.collider = parseCollider(`${path}.collider`, value.collider);
  if (value.rig !== undefined) entry.rig = parseRig(`${path}.rig`, value.rig);

  if (type === 'character' && entry.rig === undefined) {
    throw new ManifestError(`${path}.rig`, 'is required when type is "character"');
  }
  if ((type === 'audio' || type === 'splat') && entry.rig !== undefined) {
    throw new ManifestError(`${path}.rig`, `is not allowed when type is "${type}"`);
  }

  return Object.freeze(entry);
}

/**
 * Parse and validate an `assets.json` document.
 *
 * Every failure throws a {@link ManifestError} naming the exact path, and the
 * first failure wins: a manifest is either completely valid or rejected.
 *
 * @param json The parsed JSON document.
 * @param options Fallback `baseUrl` when the manifest omits one.
 * @returns A frozen, validated manifest.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 *
 * const manifest = parseManifest({
 *   version: 1,
 *   baseUrl: '/assets/',
 *   assets: [{ id: 'arena', type: 'splat', src: 'arena.spz', tags: ['world'] }],
 * });
 * console.log(manifest.assets[0]?.id); // 'arena'
 * ```
 */
export function parseManifest(json: unknown, options: ParseManifestOptions = {}): AssetManifest {
  if (!isRecord(json)) throw new ManifestError('$', 'manifest must be a JSON object');
  rejectUnknown('$', json, ['$schema', 'version', 'baseUrl', 'assets']);

  if (json.version !== 1) throw new ManifestError('$.version', 'must be the integer 1');
  if (!Array.isArray(json.assets)) throw new ManifestError('$.assets', 'must be an array');

  let baseUrl = options.baseUrl ?? '';
  if (json.baseUrl !== undefined) {
    if (typeof json.baseUrl !== 'string') throw new ManifestError('$.baseUrl', 'must be a string');
    baseUrl = json.baseUrl;
  }

  const seen = new Set<string>();
  const assets = json.assets.map((raw, i) => {
    const entry = parseEntry(`assets[${String(i)}]`, raw);
    if (seen.has(entry.id)) {
      throw new ManifestError(`assets[${String(i)}].id`, `duplicate id "${entry.id}"`);
    }
    seen.add(entry.id);
    return entry;
  });

  // Frozen, and frozen deeply enough for `findEntry` to memoise on identity:
  // neither the array nor its entries can be replaced afterwards.
  return Object.freeze({ version: 1 as const, baseUrl, assets: Object.freeze(assets) });
}

/**
 * Look an entry up by id.
 *
 * The lookup table is built once per manifest object and cached against it, so
 * this is a `Map` hit rather than a scan after the first call.
 *
 * @param manifest Manifest to search.
 * @param id Asset id.
 * @returns The entry, or `undefined` when the id is unknown.
 *
 * @example
 * ```ts
 * import { findEntry, parseManifest } from 'gameable/assets';
 *
 * const manifest = parseManifest({ version: 1, assets: [{ id: 'shot', type: 'audio', src: 'a.ogg' }] });
 * console.log(findEntry(manifest, 'shot')?.src); // 'a.ogg'
 * ```
 */
export function findEntry(manifest: AssetManifest, id: string): AssetEntry | undefined {
  let index = INDEXES.get(manifest);
  if (index === undefined) {
    index = new Map<string, AssetEntry>();
    for (const entry of manifest.assets) index.set(entry.id, entry);
    INDEXES.set(manifest, index);
  }
  return index.get(id);
}

/**
 * Id lookup tables, one per manifest object.
 *
 * `findEntry` is on the per-tick path — the guest's `describe` reaches it — and
 * a linear scan of a few hundred entries per call is the kind of cost that
 * only shows up in a profile. Memoising on the manifest's **identity** is exact
 * rather than merely convenient: {@link parseManifest} freezes what it returns,
 * so a manifest object's `assets` array can never change under the index.
 */
const INDEXES = new WeakMap<AssetManifest, Map<string, AssetEntry>>();

/**
 * Resolve an entry's `src` against the manifest's `baseUrl`.
 *
 * Absolute URLs (`https://…`, `data:…`) and protocol-relative URLs (`//host/x`)
 * are returned untouched, as are root-relative paths (`/x.glb`) when `baseUrl`
 * is itself relative. When `baseUrl` carries a scheme, resolution goes through
 * `URL`, so `../` segments collapse correctly.
 *
 * @param manifest Manifest supplying `baseUrl`.
 * @param entry An entry, or the id of one.
 * @returns The absolute or root-relative URL to fetch.
 *
 * @example
 * ```ts
 * import { parseManifest, resolveAssetUrl } from 'gameable/assets';
 *
 * const manifest = parseManifest({
 *   version: 1,
 *   baseUrl: '/assets',
 *   assets: [{ id: 'arena', type: 'splat', src: 'arena.spz' }],
 * });
 * console.log(resolveAssetUrl(manifest, 'arena')); // '/assets/arena.spz'
 * ```
 */
export function resolveAssetUrl(manifest: AssetManifest, entry: AssetEntry | string): string {
  const resolved = typeof entry === 'string' ? findEntry(manifest, entry) : entry;
  if (resolved === undefined) {
    throw new ManifestError('assets', `unknown asset id "${entry as string}"`);
  }
  return joinUrl(manifest.baseUrl, resolved.src);
}

/**
 * Join a base prefix and a relative source path.
 *
 * @param baseUrl Prefix; may be empty, a path, or an absolute URL.
 * @param src Entry `src`.
 * @returns The joined URL.
 *
 * @example
 * ```ts
 * import { joinUrl } from 'gameable/assets';
 *
 * console.log(joinUrl('https://cdn.example/a/b/', '../c.glb')); // 'https://cdn.example/a/c.glb'
 * ```
 */
export function joinUrl(baseUrl: string, src: string): string {
  if (src.startsWith('//') || ABSOLUTE_URL.test(src)) return src;
  if (baseUrl === '') return src;
  if (src.startsWith('/')) return src;
  if (ABSOLUTE_URL.test(baseUrl) || baseUrl.startsWith('//')) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(src, base.startsWith('//') ? `https:${base}` : base).href;
  }
  return baseUrl.endsWith('/') ? `${baseUrl}${src}` : `${baseUrl}/${src}`;
}

/**
 * The directory part of a URL, keeping its trailing slash.
 *
 * @param url A manifest URL.
 * @returns Everything up to and including the last `/`.
 */
function directoryOf(url: string): string {
  const clean = url.split('#')[0]?.split('?')[0] ?? url;
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? '' : clean.slice(0, slash + 1);
}

/**
 * Fetch and validate an `assets.json`.
 *
 * When the document omits `baseUrl`, it defaults to the manifest's own
 * directory, exactly as the JSON Schema says.
 *
 * @param url Where the manifest lives.
 * @param options `fetch` override, abort signal and `baseUrl` fallback.
 * @returns The validated manifest.
 *
 * @example
 * ```ts
 * import { loadManifest } from 'gameable/assets';
 *
 * const manifest = await loadManifest('/assets/assets.json');
 * console.log(manifest.assets.length);
 * ```
 */
export async function loadManifest(
  url: string,
  options: LoadManifestOptions = {},
): Promise<AssetManifest> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(url, options.signal ? { signal: options.signal } : undefined);
  if (!response.ok) {
    throw new ManifestError('$', `failed to fetch ${url}: ${String(response.status)}`);
  }
  const json: unknown = await response.json();
  return parseManifest(json, { baseUrl: options.baseUrl ?? directoryOf(url) });
}
