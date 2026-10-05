// Load one character bundle: its manifest, its per-branch mesh topology, and every
// byte the decoder chain and the rig backend will need.
//
// ONE LOADER FOR BOTH LAYOUTS, which is the shape the POC arrived at and the reason
// its two bundle generations still share a pipeline:
//
//   multi_region   `scene.json` names the branches, their meshes and their decoders.
//   schema_version 1  flat `geom`/`appr`/`mesh` plus an `export_manifest.json`, no
//                  `scene.json` at all. `sceneManifest.singleRegionScene()` adapts it
//                  to a ONE-BRANCH FUSED scene, so everything downstream is identical.
//                  `rig_names.json` is REQUIRED there: it is the only statement of the
//                  control-space width, and guessing one decodes garbage.
//
// NOTHING HERE KNOWS ABOUT URLs. A game addresses assets by id, so the only thing this
// takes is an `AssetResolver` — a directory URL is just the default one
// (`directoryResolver`). That is also what makes the tests able to drive a whole bundle
// out of an in-memory map.
//
// Replaces aos-threejs-poc/src/ogs/assets/* and lib/ogsContentPacks.js @ cdd63b10; the
// Asset Manager plumbing, the disk cache and the streaming path are dropped.

import {
  parseExpressionSpace,
  parseRigManifest,
  type CharacterManifest,
} from '../assets/characterManifest.js';
import type { MeshSource } from '../assets/loader.js';
import { loadMultiRegionScene, type MultiRegionScene } from '../assets/loadMultiRegionScene.js';
import {
  fp16NameFor,
  multiRegionFileList,
  multiRegionOptionalFileList,
  multiRegionRigParamsList,
  parseSceneManifest,
  sceneNeedsRigDeform,
  singleRegionScene,
} from '../assets/sceneManifest.js';
import {
  directoryResolver,
  loadBundleBytes,
  type AssetResolver,
  type BundleBytes,
  type BundleFetchOptions,
} from '../assets/urlBundleBytes.js';
import { orlAssetName, ORL_PACK_FILE } from '../rig/orl/bundleFiles.js';

/** A loaded, ready-to-instantiate character. */
export interface CharacterBundle {
  /** Manifest + the engine's two added blocks. */
  manifest: CharacterManifest;
  /** Per-branch mesh topology, in manifest order. */
  scene: MultiRegionScene;
  /** Every resident file, by bundle-relative name. */
  bytes: BundleBytes;
  /** How a lazily-needed file is fetched. */
  resolver: AssetResolver;
  /** True when at least one decoder ships an fp16 sibling. */
  preferFp16: boolean;
  /** Sum of every resident file's bytes. */
  byteLength: number;
}

/** Options for `loadCharacterBundle`. */
export interface LoadCharacterBundleOptions extends BundleFetchOptions {
  /** Skip the fp16 decoders even where the bundle ships them. */
  preferFp16?: boolean;
}

const RIG_NAMES_FILE = 'rig_names.json';
const EXPORT_MANIFEST_FILE = 'export_manifest.json';
const MESH_JSON_FILE = 'mesh.json';

/**
 * One bundle file's bytes as JSON, with the filename in the failure.
 *
 * @param bytes The file as fetched; decoded as UTF-8.
 * @param name The bundle-relative filename, so a parse failure names the file
 * rather than surfacing a bare `Unexpected token` — the usual cause is an HTML
 * error page served in place of a missing asset.
 * @returns The parsed document, untyped; the manifest parsers validate it.
 */
function decodeJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`character bundle: ${name} is not valid JSON`, { cause });
  }
}

/**
 * Fetch and parse a character bundle.
 *
 * @param url The bundle directory, or any string the supplied `resolver` understands.
 * @param options `fetch` / `signal` / `resolver` and the fp16 preference.
 * @returns Everything `createCharacter` needs: the parsed manifest with the engine's
 * rig and expression blocks, per-branch mesh topology in manifest order, every
 * eagerly fetched file kept resident, a resolver for the lazy ones, whether the fp16
 * decoders are to be used, and the resident byte total.
 *
 * @example
 * ```ts
 * import { loadCharacterBundle } from 'gameable/character';
 *
 * const bundle = await loadCharacterBundle('/assets/characters/myra/');
 * console.log(bundle.manifest.rig.backend, bundle.manifest.expressionSpace.dim);
 * ```
 */
export async function loadCharacterBundle(
  url: string,
  options: LoadCharacterBundleOptions = {},
): Promise<CharacterBundle> {
  const resolver = options.resolver ?? directoryResolver(url, options);
  const signal = options.signal;
  const fetchJson = async (name: string): Promise<unknown> =>
    decodeJson(await resolver(name, { signal }), name);
  const tryJson = async (name: string): Promise<unknown> => {
    try {
      return await fetchJson(name);
    } catch {
      return undefined;
    }
  };

  // Which layout is this? `scene.json` names a multi_region bundle; its absence means
  // the flat schema_version 1 layout, which `singleRegionScene()` adapts.
  let sceneJson = await tryJson('scene.json');
  let rigNames = readRigNames(await tryJson(RIG_NAMES_FILE));
  if (!sceneJson) {
    const meshJson = (await fetchJson(MESH_JSON_FILE)) as { uv_res?: number };
    const exported = (await tryJson(EXPORT_MANIFEST_FILE)) as
      { subject?: string; has_rig2mesh?: boolean } | undefined;
    if (!rigNames?.length) {
      throw new Error(
        `character bundle: ${url} has no scene.json and no ${RIG_NAMES_FILE} — ` +
          'a single-region bundle has no other statement of its control-space width, ' +
          'and guessing one decodes garbage',
      );
    }
    sceneJson = singleRegionScene({
      uvRes: Number(meshJson.uv_res),
      rigDim: rigNames.length,
      subject: exported?.subject,
      hasRig2Mesh: false,
    });
  }

  const parsed = parseSceneManifest(sceneJson);

  // The eager set: meshes, decoders and eye statics. Plus the per-branch rig params,
  // which must be RESIDENT before `loadMultiRegionScene` reads them — a miss there is
  // a silent fall back to an all-zero rig, which is an extreme corner of a control
  // space declaring `rig_range [0,1]` rather than its rest pose.
  const required = multiRegionFileList(sceneJson).filter(
    (name) => name !== 'scene.json' && name !== EXPORT_MANIFEST_FILE,
  );
  const rigParams = multiRegionRigParamsList(sceneJson);

  // The fp16 siblings are OPTIONAL: a bundle without them loads fp32 with no warning.
  // Probed rather than assumed, because whether they exist also decides `preferFp16`.
  const optional = multiRegionOptionalFileList(sceneJson);
  const fp16Present = new Set<string>();
  await Promise.all(
    optional.map(async (name) => {
      try {
        await resolver(name, { signal });
        fp16Present.add(name);
      } catch {
        /* a bundle without fp16 siblings is normal */
      }
    }),
  );

  const rigPackName = orlAssetName(ORL_PACK_FILE);
  let hasOrlPack = false;
  try {
    await resolver(rigPackName, { signal });
    hasOrlPack = true;
  } catch {
    /* a bundle with no DNA is normal; the rig manifest reports it */
  }

  const bytes = await loadBundleBytes(
    resolver,
    [...required, ...rigParams, ...fp16Present, ...(hasOrlPack ? [rigPackName] : [])],
    { signal },
  );

  const source: MeshSource = {
    json: async (name) => decodeJson(await resolver(name, { signal }), name),
    bytes: async (name) => {
      const resident = bytes.getBytes(name);
      const raw = resident ?? (await resolver(name, { signal }));
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    },
  };
  const scene = await loadMultiRegionScene(source, sceneJson);

  // A single-region bundle's `rig_names.json` is its control-space statement; a
  // multi-region one may or may not ship one, and the rig manifest falls back to the
  // declared `control_names` when it does not.
  rigNames ??= null;
  const rig = parseRigManifest(sceneJson, rigNames, {
    hasOrlPack,
    needsRig: sceneNeedsRigDeform(sceneJson),
  });
  const expressionSpace = parseExpressionSpace(sceneJson, rig);

  return {
    manifest: { scene: parsed, rig, expressionSpace, rigNames },
    scene,
    bytes,
    resolver: (name, init) => resolver(name, { signal: init?.signal ?? signal }),
    preferFp16: (options.preferFp16 ?? true) && fp16Present.size > 0,
    byteLength: bytes.totalBytes,
  };
}

/** The fp16 sibling of a decoder filename, re-exported so a caller can probe it. */
export { fp16NameFor };

/**
 * `rig_names.json` as a control-name list, when it really is one.
 *
 * @param json The parsed `rig_names.json`, or undefined when the bundle ships none.
 * @returns The names in the order `setRig` takes values, or null for a missing or
 * malformed file — a single-region bundle then fails loudly, since its control-space
 * width has no other statement.
 */
function readRigNames(json: unknown): string[] | null {
  if (!Array.isArray(json)) return null;
  return json.every((v) => typeof v === 'string') ? json : null;
}
