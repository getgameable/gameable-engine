import { parseAosRig } from '../rig/gnm/gnmPack.js';
import { parseTeethInfo, restVertices, type AosrigTeethFiles, type TeethInfo } from './mouth.js';
import { parseMouthHidden } from './mouthHidden.js';
import {
  isPackedBindings,
  isPackedSplats,
  unpackBindings,
  unpackBindingsAsync,
  unpackSplats,
  unpackSplatsAsync,
} from './packed.js';
import {
  CORRECTIVE_FILES,
  parseCorrectiveIndex,
  parseFade,
  parseSide,
  type CorrectiveInfo,
} from './corrective.js';
import { parseSomaClips, parseSomaSkeleton, type SomaClip, type SomaSkeleton } from './soma.js';

/**
 * The creator's decoder-free, rig-bound Gaussian character format.
 *
 * Version 2 (rig `aosrig-v2`) is the body every new package has: SOMA's skeleton in
 * `skeleton.json` and the character's clips in `clips.json` (see soma.ts). Version 1 (rig
 * `aosrig_v0`, a `rig.glb` holding the MHR skeleton and its clips) is still read.
 */
export interface AosrigSplatDescriptor {
  format: 'aosrig-splat';
  version: 1 | 2;
  rig: 'aosrig_v0' | 'aosrig-v2';
  renderer: 'webgpu';
  units: 'm';
  splatCount: number;
  headVertexCount: number;
  jointNames: string[];
  /** Version 2: `clips.json`'s clip names, in its order. */
  clips?: string[];
  /**
   * Version 2: the shared clip pack the package plays besides its own clips (a `soma-clips`
   * file every character of the batch names, beside the packages: `src` is relative to
   * `character.json`). Hash-checked, fetched once per page; a name in `clips.json` wins.
   */
  sharedClips?: {
    src: string;
    sha256: string;
    bytes?: number;
    format: 'soma-clips';
    clips?: string[];
  };
  files: Record<string, { src: string; sha256: string; bytes?: number }>;
  /**
   * The studio's listing of every file a player may fetch beside `character.json` (the shared
   * clip pack's `../` path included), with its size: what load progress counts against.
   */
  package?: { files?: { path: string; bytes: number; sha256?: string }[]; bytes?: number };
  /** Row-major affine; the PLY's axes are kept and only the origin is translated. */
  plyToCharacter: number[];
  bounds: { center: [number, number, number]; radius: number };
  /**
   * What the PLY's colours (f_dc and the harmonics) mean. Absent or `'srgb'`: display-ready
   * sRGB, as a character trained against photographs stores them, which the renderer draws in
   * its sRGB pass so the screen shows the file's colours. `'linear'`: already linear light.
   */
  colorSpace?: 'srgb' | 'linear';
  /**
   * The pose corrections' index, when the package carries `corrective/` and says so (the
   * studio's exporter writes it; an older package's folder is still found beside
   * `character.json`). `sha256` is the index file's.
   */
  corrective?: { index: string; sha256?: string; names?: string[] };
  /**
   * The face's ARKit table (`arkit_to_gnm.bin`), when the package carries it: what the studio's
   * own face does with 52 ARKit weights. See {@link ArkitFaceTableInfo}.
   */
  face?: { arkit?: ArkitFaceTableInfo };
}

/**
 * `character.json`'s `face.arkit`: the face's ARKit table, fitted by gnm-arkit against the rig
 * the head was made from.
 *
 * The file is float32 little-endian: `A` (`channels.length` x `coeffs`), then the correctives
 * `C` (`pairs.length` x `coeffs`). For ARKit weights `c` (in `channels`' order) the head's
 * expression coefficients are `c A + sum_k clamp(c[i_k], 0, 1) clamp(c[j_k], 0, 1) C[k]`, the
 * linear part not clamped. `gaze` turns the eyeballs: per `eyeLook*` channel, radians per unit
 * weight (the weight clamped to [0, 1]); pitch + turns the eye up, yaw + toward the character's
 * left.
 */
export interface ArkitFaceTableInfo {
  src: string;
  sha256: string;
  bytes: number;
  version: 1;
  /** Expression coefficients per row: the head's (383). */
  coeffs: number;
  /** The ARKit channel of each row of `A`, as Apple spells them (`eyeBlinkLeft`). */
  channels: string[];
  /** Each corrective's two channels, as indices into `channels`. */
  pairs: [number, number][];
  gaze: Record<string, { eye: 'left' | 'right'; axis: 'pitch' | 'yaw'; radians: number }>;
  /** The blink channels (`eyeBlinkLeft`, `eyeBlinkRight`). */
  blinks?: string[];
}

/** The files each version hash-checks before anything is parsed. */
const FILES: Readonly<Record<1 | 2, readonly string[]>> = {
  1: ['character.ply', 'rig.glb', 'head.aosrig', 'bindings.bin'],
  2: ['character.ply', 'skeleton.json', 'clips.json', 'head.aosrig', 'bindings.bin'],
};

/**
 * Files a version may name too, hash-checked like the others when it does: version 2's
 * `body.glb`, the body's mesh at the bind skinned on `skeleton.json`'s joints, which is never
 * drawn (the shadows draw it into their depth maps, and read the light off its surface).
 */
const OPTIONAL_FILES: Readonly<Record<1 | 2, readonly string[]>> = { 1: [], 2: ['body.glb'] };

/**
 * The files a lighter and a fuller copy of one character have in common: the head and the
 * skeleton (version 1's `rig.glb`; version 2's `skeleton.json`, `clips.json` and `body.glb`).
 */
const SHARED_FILES: Readonly<Record<1 | 2, readonly string[]>> = {
  1: ['head.aosrig', 'rig.glb'],
  2: ['head.aosrig', 'skeleton.json', 'clips.json', 'body.glb'],
};

/**
 * The files a descriptor names that the loader fetches and hash-checks.
 *
 * @param d A validated descriptor.
 * @returns Its version's files, and the optional ones it names.
 */
function checkedFiles(d: AosrigSplatDescriptor): string[] {
  return [...FILES[d.version], ...OPTIONAL_FILES[d.version].filter((n) => n in d.files)];
}

/**
 * The joint the head hangs from: the one the mouth follows.
 *
 * @param d A validated descriptor.
 * @returns `Head` for version 2, `c_head` for version 1.
 */
export function headJointOf(d: Pick<AosrigSplatDescriptor, 'version'>): string {
  return d.version === 2 ? 'Head' : 'c_head';
}
/**
 * The shared clip pack's path: relative to `character.json` (it may climb out of the package's
 * folder, where a batch keeps it beside its packages) or from the site's root; never another site.
 */
const SHARED_PATH = /^(?:\/|(?:\.\.\/)*)(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_-]+\.json$/;
/** A path beside `character.json`: folders and a file name, never absolute, never climbing. */
const RELATIVE_PATH = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-z0-9]+$/;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x > 0;

/** Narrow JSON objects without assuming the schema being validated. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('aosrig-splat: expected object');
  return value as Record<string, unknown>;
}

/**
 * Validate an untrusted descriptor before fetching any of its files.
 *
 * @param value Parsed JSON.
 * @returns Validated descriptor.
 */
export function parseDescriptor(value: unknown): AosrigSplatDescriptor {
  const d = record(value);
  const version = d.version === 1 || d.version === 2 ? d.version : 0;
  if (
    d.format !== 'aosrig-splat' ||
    version === 0 ||
    d.rig !== (version === 2 ? 'aosrig-v2' : 'aosrig_v0') ||
    d.renderer !== 'webgpu' ||
    d.units !== 'm' ||
    !positive(d.splatCount) ||
    !positive(d.headVertexCount) ||
    !Array.isArray(d.jointNames) ||
    d.jointNames.length < 1 ||
    d.jointNames.length > 128 ||
    d.jointNames.some((n: unknown) => typeof n !== 'string' || !n) ||
    new Set(d.jointNames).size !== d.jointNames.length ||
    !d.jointNames.includes(headJointOf({ version })) ||
    (version === 2 && !d.jointNames.includes('Hips')) ||
    (d.colorSpace !== undefined && d.colorSpace !== 'srgb' && d.colorSpace !== 'linear')
  ) {
    throw new Error('aosrig-splat: invalid or unsupported character descriptor');
  }
  if (
    version === 2 &&
    (!Array.isArray(d.clips) ||
      d.clips.some((n: unknown) => typeof n !== 'string' || !n) ||
      new Set(d.clips).size !== d.clips.length)
  )
    throw new Error("aosrig-splat: character.json's clip names are missing or repeated");
  const m = d.plyToCharacter;
  if (
    !Array.isArray(m) ||
    m.length !== 12 ||
    !m.every(finite) ||
    [0, 1, 2, 4, 5, 6, 8, 9, 10].some((i, k) => m[i] !== [1, 0, 0, 0, 1, 0, 0, 0, 1][k])
  ) {
    throw new Error('aosrig-splat: the PLY transform must be a translation');
  }
  const bounds = record(d.bounds);
  if (
    !Array.isArray(bounds.center) ||
    bounds.center.length !== 3 ||
    !bounds.center.every(finite) ||
    !finite(bounds.radius) ||
    bounds.radius <= 0
  )
    throw new Error('aosrig-splat: invalid bounds');
  if (d.corrective !== undefined) {
    const c = record(d.corrective);
    if (
      typeof c.index !== 'string' ||
      !RELATIVE_PATH.test(c.index) ||
      (c.sha256 !== undefined &&
        (typeof c.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.sha256))) ||
      (c.names !== undefined &&
        (!Array.isArray(c.names) || c.names.some((n: unknown) => typeof n !== 'string')))
    )
      throw new Error('aosrig-splat: invalid corrective entry in the descriptor');
  }
  if (version === 2 && d.corrective !== undefined)
    throw new Error('aosrig-splat: version 2 carries no pose corrections');
  // The listing says which optional files are there and carries their SHA-256s, so a malformed
  // one is refused rather than dropped (dropping it would skip every optional file's hash check).
  // A size only drives load progress: an entry without one counts 0, with a warning.
  if (d.package !== undefined) {
    const pkg: unknown = d.package;
    const files =
      pkg !== null && typeof pkg === 'object' ? (pkg as Record<string, unknown>).files : undefined;
    if (files !== undefined) {
      if (
        !Array.isArray(files) ||
        files.some((f: unknown) => {
          const e = f as { path?: unknown; sha256?: unknown } | null;
          return (
            typeof e?.path !== 'string' ||
            (e.sha256 !== undefined &&
              (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)))
          );
        })
      )
        throw new Error('aosrig-splat: invalid package listing in the descriptor');
      for (const f of files as { path: string; bytes?: unknown }[])
        if (!finite(f.bytes) || f.bytes < 0) {
          console.warn(
            `aosrig-splat: the package listing gives ${f.path} no size; progress counts it 0`,
          );
          f.bytes = 0;
        }
    }
  }
  if (d.face !== undefined) {
    const face = record(d.face);
    if (face.arkit !== undefined) parseFaceTableInfo(face.arkit);
  }
  if (d.sharedClips !== undefined) {
    const c = record(d.sharedClips);
    if (
      version !== 2 ||
      typeof c.src !== 'string' ||
      !SHARED_PATH.test(c.src) ||
      typeof c.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      c.format !== 'soma-clips' ||
      (c.bytes !== undefined && !positive(c.bytes)) ||
      (c.clips !== undefined &&
        (!Array.isArray(c.clips) || c.clips.some((n: unknown) => typeof n !== 'string')))
    )
      throw new Error('aosrig-splat: invalid shared clip pack in the descriptor');
  }
  const files = record(d.files);
  for (const name of [...FILES[version], ...OPTIONAL_FILES[version].filter((n) => n in files)]) {
    if (files[name] === undefined) throw new Error(`aosrig-splat: character.json names no ${name}`);
    const f = record(files[name]);
    if (
      typeof f.src !== 'string' ||
      !/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(f.src) ||
      typeof f.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw new Error(`aosrig-splat: invalid file ${name}`);
  }
  return value as AosrigSplatDescriptor;
}

/**
 * Validate `face.arkit`.
 *
 * @param value The descriptor's `face.arkit`.
 * @returns It, typed.
 * @throws {Error} When it is not a table this reader can play.
 */
function parseFaceTableInfo(value: unknown): ArkitFaceTableInfo {
  const t = record(value);
  const channels = t.channels;
  const pairs = t.pairs;
  const ok =
    typeof t.src === 'string' &&
    RELATIVE_PATH.test(t.src) &&
    typeof t.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(t.sha256) &&
    t.version === 1 &&
    positive(t.coeffs) &&
    Array.isArray(channels) &&
    channels.length > 0 &&
    channels.every((n: unknown) => typeof n === 'string' && n.length > 0) &&
    Array.isArray(pairs) &&
    pairs.every(
      (p: unknown) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every(
          (i: unknown) =>
            Number.isSafeInteger(i) && (i as number) >= 0 && (i as number) < channels.length,
        ),
    ) &&
    positive(t.bytes) &&
    t.bytes === 4 * t.coeffs * (channels.length + pairs.length);
  if (!ok)
    throw new Error("aosrig-splat: character.json's face.arkit is not a table this reader plays");
  const gaze = record(t.gaze ?? {});
  for (const [name, g] of Object.entries(gaze)) {
    const e = record(g);
    if (
      !channels.includes(name) ||
      (e.eye !== 'left' && e.eye !== 'right') ||
      (e.axis !== 'pitch' && e.axis !== 'yaw') ||
      !finite(e.radians)
    )
      throw new Error(
        `aosrig-splat: face.arkit's gaze entry ${name} is not an eye, an axis and radians`,
      );
  }
  return value as ArkitFaceTableInfo;
}

/**
 * The bytes a load will fetch, from the sizes `character.json` lists: `package.files` (the
 * studio's listing, the shared clip pack included), else each file's own `bytes`.
 *
 * @param d The descriptor.
 * @param want What the load fetches.
 * @param want.mouth The mouth's files.
 * @param want.teeth The teeth's points, with the mouth's files.
 * @param want.corrective Version 1's pose corrections.
 * @param want.sharedClips Version 2's shared clip pack.
 * @param want.reuse Files already at hand, by SHA-256.
 * @returns The sum, 0 when nothing is sized.
 */
function expectedBytes(
  d: AosrigSplatDescriptor,
  want: {
    mouth: boolean;
    teeth: boolean;
    corrective: boolean;
    sharedClips: boolean;
    reuse?: ReadonlyMap<string, Uint8Array>;
  },
): number {
  const listed = new Map<string, number>();
  for (const f of d.package?.files ?? [])
    if (Number.isFinite(f.bytes) && f.bytes >= 0) listed.set(f.path, f.bytes);
  const size = (path: string, own?: number): number => listed.get(path) ?? own ?? 0;
  let sum = 0;
  for (const name of checkedFiles(d)) {
    const entry = d.files[name];
    if (!want.reuse?.has(entry.sha256)) sum += size(entry.src, entry.bytes);
  }
  if (d.face?.arkit) sum += size(d.face.arkit.src, d.face.arkit.bytes);
  if (d.version === 2 && want.sharedClips && d.sharedClips)
    sum += size(d.sharedClips.src, d.sharedClips.bytes);
  if (want.mouth) {
    sum += size('mouth_hidden.bin');
    if (want.teeth) for (const n of ['teeth.json', 'teeth.ply', 'teeth.bin']) sum += size(n);
  }
  if (d.version === 1 && want.corrective)
    for (const [path, bytes] of listed) if (path.startsWith('corrective/')) sum += bytes;
  return sum;
}

/** Parsed, integrity-checked assets. Version 1's `rig.glb` is consumed by GLTFLoader. */
export interface AosrigSplatBundle {
  descriptor: AosrigSplatDescriptor;
  files: Map<string, Uint8Array>;
  /**
   * Version 2's body: the skeleton, and its clips (the package's own, then those of any
   * shared clip files the host asked for, a name the package already has left out).
   */
  soma?: { skeleton: SomaSkeleton; clips: SomaClip[] };
  /**
   * The teeth's own points, when the package carries them beside its five files
   * (`teeth.json` naming `teeth.ply` and `teeth.bin`; not in `character.json`, so not
   * hash-checked, and validated when the mouth is built). Absent for a package without them.
   */
  teeth?: AosrigTeethFiles;
  /**
   * The pose corrections (`corrective/index.json` and each correction's five files), when the
   * package carries them; validated here as far as their sizes and hashes go, and dropped
   * with a warning rather than failing the character. Absent for a package without them.
   */
  corrective?: AosrigCorrectiveFiles[];
  /**
   * `mouth_hidden.bin`, the closed mouth's inside points the lips' opening takes away, when
   * the package carries it beside its files (see mouthHidden.ts). Absent otherwise.
   */
  mouthHidden?: Uint8Array;
  /** With `keepShared`: the head and skeleton files, by SHA-256, for a fuller copy's `reuse`. */
  shared?: Map<string, Uint8Array>;
  /**
   * The face's ARKit table (`face.arkit` and its file, hash-checked), when the package carries
   * it. A table that does not come or does not match its hash is said, and the face falls back
   * to the hand-made stopgap (`arkitToGnmDefault.ts`).
   */
  faceArkit?: { info: ArkitFaceTableInfo; bytes: Uint8Array };
}

/** One correction's files, as the package carries them. */
export interface AosrigCorrectiveFiles {
  info: CorrectiveInfo;
  fade: Uint8Array;
  side: Uint8Array;
  points: Uint8Array;
  bindings: Uint8Array;
  pointsSide: Uint8Array;
}

/**
 * A file's SHA-256 as hex.
 *
 * @param bytes The file.
 * @returns 64 hex characters.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch the optional pose corrections: `corrective/index.json` where the descriptor names it
 * (then it must be there and match its hash), or beside `character.json` for a package
 * that carries the folder without saying so; then each correction's five files, hash-checked
 * when the index carries hashes, and their sizes checked against the counts.
 *
 * @param base The URL of `character.json`, absolute.
 * @param descriptor The package's descriptor.
 * @param fetchBytes Fetches one URL's bytes, or throws.
 * @returns The corrections, or undefined (a package without them, or one whose folder is
 *   refused, which is said in the console).
 */
async function loadCorrective(
  base: string,
  descriptor: AosrigSplatDescriptor,
  fetchBytes: (src: string) => Promise<Uint8Array>,
): Promise<AosrigCorrectiveFiles[] | undefined> {
  const named = descriptor.corrective;
  const indexUrl = new URL(named?.index ?? 'corrective/index.json', base).href;
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(indexUrl);
  } catch (error) {
    if (named)
      console.info(
        'aosrig-splat: character.json names pose corrections that are not there:',
        error,
      );
    return undefined;
  }
  const text = new TextDecoder().decode(bytes);
  // a dev server answers a page for a file it does not have: no folder, nothing to say
  if (!named && !/^\s*\{/.test(text)) return undefined;
  try {
    if (named?.sha256 !== undefined && (await sha256Hex(bytes)) !== named.sha256)
      throw new Error('the index does not match its hash in character.json');
    const infos = parseCorrectiveIndex(JSON.parse(text) as unknown, descriptor);
    const folder = new URL('.', indexUrl).href;
    return await Promise.all(
      infos.map(async (info) => {
        const [fade, side, points, bindings, pointsSide] = await Promise.all(
          CORRECTIVE_FILES.map(async (name) => {
            const file = await fetchBytes(new URL(info.files[name], folder).href);
            const want = info.sha256[name];
            if (want !== undefined && (await sha256Hex(file)) !== want)
              throw new Error(`${info.name}/${name} does not match its hash`);
            return file;
          }),
        );
        parseFade(fade, info.splatCount);
        parseSide(side, info.splatCount);
        parseSide(pointsSide, info.points);
        if (info.points > 0) {
          parseGaussianPly(points, info.points);
          parseBindings(bindings, { ...descriptor, splatCount: info.points });
        }
        return { info, fade, side, points, bindings, pointsSide };
      }),
    );
  } catch (error) {
    console.info('aosrig-splat: the pose corrections are not used:', error);
    return undefined;
  }
}

/**
 * Fetch the optional `mouth_hidden.bin` beside `character.json`: a file that is not there
 * (or a page in its place) means none; a file that is there but is not the list is said.
 *
 * @param base The URL of `character.json`, absolute.
 * @param descriptor The package's descriptor.
 * @param fetchBytes Fetches one URL's bytes, or throws.
 * @returns The file, or undefined.
 */
async function loadMouthHidden(
  base: string,
  descriptor: AosrigSplatDescriptor,
  fetchBytes: (src: string) => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(new URL('mouth_hidden.bin', base).href);
  } catch {
    return undefined;
  }
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'AOSMHD01')
    return undefined;
  try {
    parseMouthHidden(bytes, descriptor.splatCount, descriptor.headVertexCount);
    return bytes;
  } catch (error) {
    console.info("aosrig-splat: the closed mouth's inside points are not used:", error);
    return undefined;
  }
}

/**
 * Fetch the optional teeth files beside `character.json`.
 *
 * A package without them answers 404 (or, on a dev server with a page fallback, something
 * that is not JSON); either way the character loads exactly as before.
 *
 * @param base The URL of `character.json`, absolute.
 * @param fetchBytes Fetches one URL's bytes, or throws.
 * @returns The three files, or undefined.
 */
async function loadTeeth(
  base: string,
  fetchBytes: (src: string) => Promise<Uint8Array>,
): Promise<AosrigTeethFiles | undefined> {
  let info: TeethInfo;
  try {
    const json = new TextDecoder().decode(await fetchBytes(new URL('teeth.json', base).href));
    info = parseTeethInfo(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
  try {
    const [ply, binding] = await Promise.all([
      fetchBytes(new URL(info.ply, base).href),
      fetchBytes(new URL(info.binding, base).href),
    ]);
    return { info, ply, binding };
  } catch (error) {
    console.info('aosrig-splat: teeth.json is here but its files are not:', error);
    return undefined;
  }
}

/** Which of a package's optional files to fetch, and how. */
export interface AosrigSplatLoadOptions {
  /**
   * Told as the files arrive: the bytes so far, and the bytes the loader expects in all (the
   * sizes `character.json` lists for the files it fetches, the shared clip pack included). Both
   * count the files as they are, not as they travel: a server that compresses them sends fewer
   * bytes. The last call has `loaded === total`. A package that lists no sizes reports a total of
   * 0 until that last call.
   */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  /** The mouth's inside: `teeth.json` and the files it names, and `mouth_hidden.bin`. Default true. */
  mouth?: boolean;
  /**
   * With `mouth`, the teeth's points (`teeth.json` and the files it names). Default true; false
   * keeps `mouth_hidden.bin` (the closed mouth's inside points) for a host that draws no teeth.
   */
  teeth?: boolean;
  /** Version 1's pose corrections (`corrective/`); version 2 carries none. Default true. */
  corrective?: boolean;
  /**
   * Version 2 only: more clip files of the package's `clips.json` format (`soma-clips`) to
   * play on this character, absolute URLs or relative to `character.json`. A clip plays on
   * every character of the same skeleton, so a game's shared clips live in one file.
   */
  clipFiles?: readonly string[];
  /**
   * Version 2 only: fetch the shared clip pack the package names (`sharedClips`). Default
   * true; a game that brings its own clip file (`clipFiles`) may skip the whole pack.
   */
  sharedClips?: boolean;
  /**
   * Awaited between blocks of turning packed files back into plain ones, so frames keep drawing while a
   * character loads behind one already on screen. Omit to do it in one go.
   */
  pause?: () => Promise<void>;
  /**
   * Files already downloaded and checked, by their SHA-256 (another copy of the same character sharing its
   * head and skeleton): used instead of fetching them again.
   */
  reuse?: ReadonlyMap<string, Uint8Array>;
  /**
   * Keep the files a fuller copy of the same character shares with this one (its head and
   * skeleton) in the bundle's `shared`, by SHA-256, for that copy's `reuse`.
   */
  keepShared?: boolean;
  /**
   * The `fetch` every file goes through (the descriptor, the package's files, the shared
   * clips), for a package on a private store: `createAamResolver(client).fetch` adds the
   * asset manager's key. Defaults to the global `fetch`.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** One shared clip pack for the page: its bytes until read, then its clips per skeleton. */
interface SharedPack {
  bytes: Promise<Uint8Array> | null;
  read: Map<string, Promise<{ clips: SomaClip[]; refused: { name: string; reason: string }[] }>>;
}

/**
 * The page's shared clip packs, by URL and hash: every character of a scene that names the
 * same pack fetches, checks and reads it once (the clips' numbers are then shared). Held until
 * {@link releaseSharedClips}.
 */
const sharedPacks = new Map<string, SharedPack>();

/**
 * Forget the page's shared clip packs (their bytes and the clips read from them), so their memory
 * goes once the characters that play them are gone. A host calls it when its last character is
 * disposed; a character loaded afterwards fetches the pack again.
 *
 * @returns Nothing.
 * @example
 * ```ts
 * character.dispose();
 * releaseSharedClips(); // the last one: the shared pack can go
 * ```
 */
export function releaseSharedClips(): void {
  sharedPacks.clear();
}

/**
 * The shared pack's entry, its download started unless it has been read for these joints.
 *
 * @param url The pack's URL, absolute.
 * @param sha256 Its hash from `character.json`.
 * @param joints The skeleton's joint names, which the reading depends on.
 * @param fetchBytes Fetches one URL's bytes, or throws.
 * @returns The page's entry for the pack.
 */
function sharedPack(
  url: string,
  sha256: string,
  joints: readonly string[],
  fetchBytes: (src: string) => Promise<Uint8Array>,
): SharedPack {
  const key = `${url}#${sha256}`;
  let pack = sharedPacks.get(key);
  if (!pack) {
    pack = { bytes: null, read: new Map() };
    sharedPacks.set(key, pack);
  }
  if (!pack.read.has(joints.join(','))) {
    pack.bytes ??= (async () => {
      const bytes = await fetchBytes(url);
      if ((await sha256Hex(bytes)) !== sha256)
        throw new Error('aosrig-splat: hash mismatch for the shared clip pack');
      return bytes;
    })();
    pack.bytes.catch(() => sharedPacks.delete(key));
  }
  return pack;
}

/**
 * The shared pack's clips read against a skeleton, once per page for the joints it has.
 *
 * @param pack The page's entry (`sharedPack`).
 * @param skeleton The character's skeleton.
 * @returns The clips, and the ones left out with why.
 */
function readSharedPack(
  pack: SharedPack,
  skeleton: SomaSkeleton,
): Promise<{ clips: SomaClip[]; refused: { name: string; reason: string }[] }> {
  const joints = skeleton.names.join(',');
  let read = pack.read.get(joints);
  if (!read) {
    const bytes = pack.bytes;
    if (!bytes) throw new Error('aosrig-splat: the shared clip pack was not fetched');
    read = bytes.then((b) =>
      parseSomaClips(JSON.parse(new TextDecoder().decode(b)) as unknown, skeleton),
    );
    pack.read.set(joints, read);
    // Read: the bytes go (a character with other joints would fetch them again).
    void read.then(
      () => {
        pack.bytes = null;
      },
      () => pack.read.delete(joints),
    );
  }
  return read;
}

/**
 * Version 2's clips out of the checked files (`skeleton.json` and `clips.json` are then
 * dropped from `files`: the rig is built from what is parsed here): the package's own, then
 * its shared pack's, then the host's clip files. A clip that breaks a rule, or one whose
 * name the character already has, is left out and said in the console.
 *
 * @param descriptor The validated descriptor.
 * @param files The checked files.
 * @param skeleton The skeleton, read from `skeleton.json`.
 * @param pack The package's shared pack, read, when there is one.
 * @param shared The host's clip files' bytes, by the URL the host gave.
 * @returns The skeleton and every clip it plays.
 */
function readSoma(
  descriptor: AosrigSplatDescriptor,
  files: Map<string, Uint8Array>,
  skeleton: SomaSkeleton,
  pack: { clips: SomaClip[]; refused: { name: string; reason: string }[] } | null,
  shared: readonly { src: string; bytes: Uint8Array }[],
): { skeleton: SomaSkeleton; clips: SomaClip[] } {
  const text = (bytes: Uint8Array | undefined): unknown =>
    JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const own = parseSomaClips(text(files.get('clips.json')), skeleton);
  const listed = descriptor.clips ?? [];
  if (own.clips.some((c) => !listed.includes(c.name)))
    throw new Error("aosrig-splat: clips.json's clips are not character.json's");
  files.delete('skeleton.json');
  files.delete('clips.json');
  const clips = own.clips.slice();
  const said = own.refused.map((r) => `${r.name} ${r.reason}`);
  const have = new Set(clips.map((c) => c.name));
  if (pack) {
    said.push(...pack.refused.map((r) => `${r.name} (the shared pack) ${r.reason}`));
    for (const clip of pack.clips) {
      if (have.has(clip.name)) continue;
      have.add(clip.name);
      clips.push(clip);
    }
  }
  for (const { src, bytes } of shared) {
    let file;
    try {
      file = parseSomaClips(text(bytes), skeleton);
    } catch (error) {
      said.push(`${src}: ${String(error)}`);
      continue;
    }
    said.push(...file.refused.map((r) => `${r.name} (${src}) ${r.reason}`));
    for (const clip of file.clips) {
      if (have.has(clip.name)) continue;
      have.add(clip.name);
      clips.push(clip);
    }
  }
  if (said.length > 0) console.info(`aosrig-splat: clips left out: ${said.join('; ')}`);
  return { skeleton, clips };
}

/**
 * Load an extracted character archive, validating all content hashes.
 *
 * @param url URL of character.json.
 * @param signal Optional cancellation signal.
 * @param options Which optional files to fetch, progress, a custom `fetch` (see {@link AosrigSplatLoadOptions}).
 * @returns Verified descriptor and files.
 * @example
 * ```ts
 * const bundle = await loadAosrigSplatBundle('/characters/hero/character.json');
 * console.log(bundle.descriptor.splatCount);
 * ```
 */
export async function loadAosrigSplatBundle(
  url: string,
  signal?: AbortSignal,
  options: AosrigSplatLoadOptions = {},
): Promise<AosrigSplatBundle> {
  const fetchResponse = async (src: string, abort = signal): Promise<Response> => {
    // Called, not taken as a value: a browser's fetch refuses to run detached from window.
    const init = abort ? { signal: abort } : {};
    const response = await (options.fetch ? options.fetch(src, init) : fetch(src, init));
    if (!response.ok) throw new Error(`aosrig-splat: ${src}: HTTP ${String(response.status)}`);
    return response;
  };
  const onProgress = options.onProgress;
  let loaded = 0;
  let total = 0;
  // A file's bytes, counted as they stream in when the host wants progress.
  const readBody = async (response: Response): Promise<Uint8Array> => {
    if (!onProgress || !response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (onProgress) {
        loaded += bytes.length;
        onProgress(loaded, total);
      }
      return bytes;
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      loaded += value.length;
      onProgress(loaded, total);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  };
  const fetchBytes = async (src: string): Promise<Uint8Array> => readBody(await fetchResponse(src));
  // The page's shared clip pack serves every character that names it: this load's abort is not its.
  const fetchShared = async (src: string): Promise<Uint8Array> =>
    readBody(await fetchResponse(src, undefined));
  const first = await fetchResponse(url);
  const descriptor = parseDescriptor(
    JSON.parse(new TextDecoder().decode(await first.arrayBuffer())) as unknown,
  );
  const files = new Map<string, Uint8Array>();
  // Every other file is beside character.json where it ended up: a stable address that redirects
  // to the current version's character.json resolves them in that version's folder. A response a
  // host's fetch made itself may carry no URL; the address asked for stands in.
  const requested = new URL(url, typeof location === 'undefined' ? undefined : location.href).href;
  const base = first.url ? new URL(first.url, requested).href : requested;
  if (onProgress) {
    total = expectedBytes(descriptor, {
      mouth: options.mouth ?? true,
      teeth: options.teeth ?? true,
      corrective: options.corrective ?? true,
      sharedClips: options.sharedClips ?? true,
      reuse: options.reuse,
    });
    onProgress(0, total);
  }
  const wantMouth = options.mouth ?? true;
  // Version 2 carries no pose corrections (they were made on the version 1 body).
  const wantCorrective = (options.corrective ?? true) && descriptor.version === 1;
  // The optional files are found by asking for them, and a file that is not there is a 404 the
  // browser logs in red in every app. A package that lists its files (`package.files`, every
  // studio export since 2026-09-27) says which are there: only those are asked for.
  const listing = descriptor.package?.files;
  const carries = (path: string): boolean =>
    listing === undefined || listing.some((f) => f.path === path);
  // The optional files are checked against the SHA-256 the listing gives them (character.json's
  // own `files` covers only the required ones): a file that does not match is refused, and the
  // character loads without that part. A package whose listing gives no hash is taken as it is.
  const listedHashes = new Map<string, string>();
  for (const f of listing ?? [])
    if (f.sha256 !== undefined) listedHashes.set(new URL(f.path, base).href, f.sha256);
  const fetchOptional = async (src: string): Promise<Uint8Array> => {
    const bytes = await fetchBytes(src);
    const want = listedHashes.get(new URL(src, base).href);
    if (want !== undefined && (await sha256Hex(bytes)) !== want) {
      console.warn(`aosrig-splat: ${src} does not match its hash in character.json; not used`);
      throw new Error(`aosrig-splat: hash mismatch for ${src}`);
    }
    return bytes;
  };
  const teeth =
    wantMouth && (options.teeth ?? true) && carries('teeth.json')
      ? loadTeeth(base, fetchOptional)
      : Promise.resolve(undefined);
  const corrective =
    wantCorrective && (descriptor.corrective !== undefined || carries('corrective/index.json'))
      ? loadCorrective(base, descriptor, fetchOptional)
      : Promise.resolve(undefined);
  const mouthHidden =
    wantMouth && carries('mouth_hidden.bin')
      ? loadMouthHidden(base, descriptor, fetchOptional)
      : Promise.resolve(undefined);
  // The face's files: optional, hash-checked, and never the reason a character does not load.
  const optional = <T extends { src: string; sha256: string }>(
    info: T | undefined,
    what: string,
  ): Promise<{ info: T; bytes: Uint8Array } | undefined> =>
    info
      ? fetchBytes(new URL(info.src, base).href)
          .then(async (bytes) => {
            if ((await sha256Hex(bytes)) !== info.sha256)
              throw new Error(`hash mismatch for ${info.src}`);
            return { info, bytes };
          })
          .catch((error: unknown) => {
            console.warn(`aosrig-splat: ${what}:`, error);
            return undefined;
          })
      : Promise.resolve(undefined);
  const faceArkit = optional(
    descriptor.face?.arkit,
    'the face table is not used; the face plays the stopgap table',
  );
  const version = descriptor.version;
  // The package's shared clip pack, started beside its files (once per page for every
  // character that names it).
  const named = version === 2 && (options.sharedClips ?? true) ? descriptor.sharedClips : undefined;
  const pack = named
    ? sharedPack(new URL(named.src, base).href, named.sha256, descriptor.jointNames, fetchShared)
    : null;
  // The shared clip files, fetched beside the package's own (their bytes are not hashed).
  const clipFiles = version === 2 ? (options.clipFiles ?? []) : [];
  // A shared file that does not come is said, never the reason the character does not load.
  const sharedClips = Promise.all(
    clipFiles.map(async (src) => {
      try {
        return { src, bytes: await fetchBytes(new URL(src, base).href) };
      } catch (error) {
        console.info(`aosrig-splat: the clip file ${src} did not load:`, error);
        return null;
      }
    }),
  );
  await Promise.all(
    checkedFiles(descriptor).map(async (name) => {
      const entry = descriptor.files[name];
      const known = options.reuse?.get(entry.sha256);
      if (known) {
        files.set(name, known);
        return;
      }
      const bytes = await fetchBytes(new URL(entry.src, base).href);
      if ((await sha256Hex(bytes)) !== entry.sha256)
        throw new Error(`aosrig-splat: hash mismatch for ${name}`);
      files.set(name, bytes);
    }),
  );
  await unpackFiles(files, descriptor, options.pause);
  const extra = await teeth;
  const corrections = await corrective;
  const hidden = await mouthHidden;
  const bundle: AosrigSplatBundle = { descriptor, files };
  // Kept before version 2's skeleton and clips are read and dropped from `files`.
  if (options.keepShared) {
    bundle.shared = new Map();
    for (const name of SHARED_FILES[version]) {
      const bytes = files.get(name);
      if (bytes) bundle.shared.set(descriptor.files[name].sha256, bytes);
    }
  }
  if (version === 2) {
    const skeleton = parseSomaSkeleton(
      JSON.parse(new TextDecoder().decode(files.get('skeleton.json'))) as unknown,
      descriptor.jointNames,
    );
    // A pack that does not come (or does not match its hash) is said: the character plays its
    // own clips, which carry the house names.
    let packClips: { clips: SomaClip[]; refused: { name: string; reason: string }[] } | null = null;
    if (pack && named) {
      try {
        packClips = await readSharedPack(pack, skeleton);
      } catch (error) {
        console.info(`aosrig-splat: the shared clip pack ${named.src} is not used:`, error);
      }
    }
    bundle.soma = readSoma(
      descriptor,
      files,
      skeleton,
      packClips,
      (await sharedClips).filter((f) => f !== null),
    );
  }
  if (extra) bundle.teeth = extra;
  if (corrections) bundle.corrective = corrections;
  if (hidden) bundle.mouthHidden = hidden;
  const face = await faceArkit;
  if (face) bundle.faceArkit = face;
  if (onProgress) {
    // A file the listing did not size, or a pack another character already fetched, leaves the
    // two apart: the last call says done.
    total = Math.max(total, loaded);
    onProgress(total, total);
  }
  return bundle;
}

/**
 * A package's packed splats and bindings (packed.ts), once their hashes are checked, turned back into the
 * plain files everything else reads; a package without them is left exactly as it is.
 *
 * @param files The package's four files, by name; replaced in place.
 * @param descriptor The package's descriptor.
 * @param pause Awaited between blocks of the work, so frames keep drawing; omit to do it in one go.
 * @returns Resolves once the files are replaced.
 */
export async function unpackFiles(
  files: Map<string, Uint8Array>,
  descriptor: AosrigSplatDescriptor,
  pause?: () => Promise<void>,
): Promise<void> {
  const splats = files.get('character.ply');
  if (splats && isPackedSplats(splats))
    files.set(
      'character.ply',
      pause
        ? await unpackSplatsAsync(splats, descriptor.splatCount, pause)
        : unpackSplats(splats, descriptor.splatCount),
    );
  const bindings = files.get('bindings.bin');
  const head = files.get('head.aosrig');
  if (bindings && head && isPackedBindings(bindings)) {
    const rest = restVertices(parseAosRig(head));
    files.set(
      'bindings.bin',
      pause
        ? await unpackBindingsAsync(bindings, descriptor, rest, pause)
        : unpackBindings(bindings, descriptor, rest),
    );
  }
}

/** Fixed 112-byte little-endian binding records. See docs/aosrig-splat.md. */
export function parseBindings(bytes: Uint8Array, d: AosrigSplatDescriptor): Float32Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 32 ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== 'AOSBND01' ||
    v.getUint32(8, true) !== 1 ||
    v.getUint32(12, true) !== d.splatCount ||
    v.getUint32(16, true) !== 112 ||
    v.getUint32(20, true) !== d.headVertexCount ||
    v.getUint32(24, true) !== d.jointNames.length ||
    v.getUint32(28, true) !== 0 ||
    bytes.length !== 32 + d.splatCount * 112
  )
    throw new Error('aosrig-splat: invalid bindings header or size');
  // Copy makes alignment and ownership independent of a ZIP/fetch view's offset.
  const data = bytes.slice(32);
  const f = new Float32Array(data.buffer),
    u = new Uint32Array(data.buffer);
  for (let i = 0; i < d.splatCount; i++) {
    const b = i * 28;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      if (u[b + k] >= d.jointNames.length || !finite(f[b + 4 + k]) || f[b + 4 + k] < 0)
        throw new Error('aosrig-splat: invalid skin weight or joint');
      sum += f[b + 4 + k];
    }
    if (Math.abs(sum - 1) > 1e-4 || !finite(f[b + 11]) || f[b + 11] < 0 || f[b + 11] > 1)
      throw new Error('aosrig-splat: invalid binding weights');
    for (let k = 12; k < 28; k++)
      if (!finite(f[b + k])) throw new Error('aosrig-splat: nonfinite triangle frame');
    if (f[b + 11] > 0) {
      for (let k = 8; k < 11; k++)
        if (u[b + k] >= d.headVertexCount) throw new Error('aosrig-splat: invalid face vertex');
      const det =
        f[b + 12] * (f[b + 17] * f[b + 22] - f[b + 18] * f[b + 21]) -
        f[b + 13] * (f[b + 16] * f[b + 22] - f[b + 18] * f[b + 20]) +
        f[b + 14] * (f[b + 16] * f[b + 21] - f[b + 17] * f[b + 20]);
      if (Math.abs(det) < 1e-12) throw new Error('aosrig-splat: singular rest frame');
    }
  }
  return f;
}

/** INRIA float PLY view. Retains source order and SH coefficients. */
export interface GaussianPly {
  count: number;
  stride: number;
  properties: Map<string, number>;
  data: DataView;
  shCount: number;
}

/** Parse the binary float PLY emitted by the creator, rejecting unsupported layouts. */
export function parseGaussianPly(bytes: Uint8Array, expected: number): GaussianPly {
  let end = -1;
  // Headers are small; never decode hundreds of MB of binary payload as text.
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const match = /end_header\r?\n/.exec(header);
  if (match) end = match.index + match[0].length;
  if (end < 0) throw new Error('aosrig-splat: missing PLY header');
  const lines = header.slice(0, end).trim().split(/\r?\n/);
  if (lines[0] !== 'ply' || !lines.includes('format binary_little_endian 1.0'))
    throw new Error('aosrig-splat: requires binary little-endian PLY');
  const properties = new Map<string, number>();
  let count = 0;
  let elements = 0;
  for (const line of lines) {
    if (line.startsWith('element ')) {
      elements++;
      const m = /^element vertex (\d+)$/.exec(line);
      if (!m) throw new Error('aosrig-splat: unexpected PLY element');
      count = Number(m[1]);
    }
    if (line.startsWith('property ')) {
      const m = /^property float (\w+)$/.exec(line);
      if (!m || properties.has(m[1])) throw new Error('aosrig-splat: unsupported PLY property');
      properties.set(m[1], properties.size);
    }
  }
  if (elements !== 1 || count !== expected || bytes.length !== end + count * properties.size * 4)
    throw new Error('aosrig-splat: PLY size/count mismatch');
  for (const name of [
    'x',
    'y',
    'z',
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
  ])
    if (!properties.has(name)) throw new Error(`aosrig-splat: missing PLY ${name}`);
  const shCount = [...properties.keys()].filter((n) => n.startsWith('f_rest_')).length;
  if (![0, 9, 24, 45].includes(shCount)) throw new Error('aosrig-splat: unsupported SH degree');
  for (let k = 0; k < shCount; k++)
    if (!properties.has(`f_rest_${String(k)}`))
      throw new Error('aosrig-splat: noncontiguous SH coefficients');
  return {
    count,
    stride: properties.size * 4,
    properties,
    data: new DataView(bytes.buffer, bytes.byteOffset + end, bytes.length - end),
    shCount,
  };
}
