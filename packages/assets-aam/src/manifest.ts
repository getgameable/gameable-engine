/**
 * Turning an AAM character into `assets.json` entries.
 *
 * A game's manifest is static; an AAM character is not. This module reads the
 * two listings a character needs — its `/ogs` inference bundle and its
 * animation clips — and emits ordinary {@link AssetEntry} values, so an
 * AAM-hosted character merges into `assets.json` at runtime and every downstream
 * rule still holds: **game logic addresses assets by string id only**, the
 * registry is still the only thing that knows a URL, and the loaders are the
 * stock ones.
 *
 * Ids are built from a prefix and the server's clip name, sanitised to the
 * manifest's `^[a-z0-9][a-z0-9._-]*$` pattern. A collision is an error, never a
 * silent overwrite: two clips quietly collapsing into one id is exactly the kind
 * of failure that only shows up as a missing animation three scenes later.
 */
import type { AssetEntry, AssetManifest, AssetRig } from '@gameable/assets';

import type { AamClient, AnimationAssetRow, AdditiveType, BasePoseType } from './client.js';
import { AamError } from './client.js';

/** Longest id the manifest schema accepts. */
const MAX_ID_LENGTH = 64;

/** Rig used when the caller does not supply one and the bundle is not an exported package. */
const DEFAULT_RIG: AssetRig = Object.freeze({ backend: 'orl' });

/** Rig used when the bundle is an exported package (it holds a `character.json`). */
const PACKAGE_RIG: AssetRig = Object.freeze({ backend: 'aosrig-splat' });

/** The descriptor an exported package's loader starts from. */
const PACKAGE_DESCRIPTOR = 'character.json';

/**
 * One face clip, as a JSON-serialisable record.
 *
 * Face clips are ARKit weight tracks in JSON, not glTF, so they are not
 * manifest entries — `assets.json` has no `json` type and inventing one would
 * be a schema change. They come back as their own list instead, ready to be
 * written into a game's own data file or handed to the animator directly.
 *
 * @example
 * ```ts
 * import type { AamFaceClip } from 'gameable/aam';
 *
 * const clip: AamFaceClip = {
 *   id: 'char.myra.smile',
 *   name: 'smile',
 *   url: 'https://aam.example/api/character-assets/7/smile.json',
 *   additive: false,
 *   additiveType: 'none',
 *   basePoseType: 'none',
 *   basePoseAssetId: null,
 *   refFrameIndex: 0,
 *   updatedAt: null,
 * };
 * console.log(clip.id); // 'char.myra.smile'
 * ```
 */
export interface AamFaceClip {
  /** Manifest-style id, built from the same prefix as the body clips. */
  readonly id: string;
  /** The server's clip name. */
  readonly name: string;
  /** Absolute URL the ARKit track is served from. */
  readonly url: string;
  /** Whether the clip plays as an additive layer. */
  readonly additive: boolean;
  /** Additive space. */
  readonly additiveType: AdditiveType;
  /** Which pose the additive bake subtracts. */
  readonly basePoseType: BasePoseType;
  /** Row id of the clip supplying the base pose. */
  readonly basePoseAssetId: string | null;
  /** Frame index of the reference pose. */
  readonly refFrameIndex: number;
  /** Last-modified stamp, for cache versioning. */
  readonly updatedAt: string | null;
}

/** What {@link buildCharacterManifestEntries} produces. */
export interface AamCharacterEntries {
  /** Id of the `character` entry, for convenience. */
  readonly characterId: string;
  /** The `character` entry plus one `gltf` entry per body clip. */
  readonly entries: readonly AssetEntry[];
  /** Face clips, which have no manifest type of their own. */
  readonly faceClips: readonly AamFaceClip[];
}

/** Options accepted by {@link buildCharacterManifestEntries}. */
export interface BuildCharacterManifestOptions {
  /** Id prefix for every entry. Defaults to `char.<slug>`. */
  readonly idPrefix?: string;
  /**
   * Rig for the `character` entry. Defaults to `{ backend: 'aosrig-splat' }` when the
   * bundle holds a `character.json` (an exported package), else `{ backend: 'orl' }`.
   */
  readonly rig?: AssetRig;
  /** Tags added to every generated entry. Defaults to `['aam', <slug>]`. */
  readonly tags?: readonly string[];
}

/**
 * Sanitise a name into a manifest id segment.
 *
 * The manifest pattern is `^[a-z0-9][a-z0-9._-]*$`, so a clip called
 * `Wave (Right Hand)` becomes `wave-right-hand`.
 *
 * @param name Free-form name from the server.
 * @returns A lower-case segment, or `''` when nothing survives.
 */
function toIdSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '');
}

/**
 * Join an id prefix and a segment, within the manifest's length limit.
 *
 * @param prefix Id prefix, already sanitised.
 * @param segment Sanitised segment, or `''` for the prefix alone.
 * @returns The id.
 */
function joinId(prefix: string, segment: string): string {
  const id = segment === '' ? prefix : `${prefix}.${segment}`;
  return id.slice(0, MAX_ID_LENGTH).replace(/[-._]+$/, '');
}

/**
 * Read a character's listings and turn them into manifest entries.
 *
 * The `character` entry's `src` is a **virtual directory URL** —
 * `<baseUrl>/api/characters/<slug>/ogs/` — not a single file. The character
 * loader appends a filename to it (`scene.json`, `mesh.json`, the decoders) and
 * fetches each one, exactly as it would from a static directory; the only
 * difference is that the directory is served by AAM and needs the key, which is
 * what `createAamResolver` supplies.
 *
 * An exported package (the bundle holds a `character.json`, as the studio stores
 * one) is the exception: its `src` is `<baseUrl>/api/characters/<slug>/ogs/character.json`
 * and its rig defaults to `aosrig-splat`, because that loader starts from the
 * descriptor and reads every other file name from it. Its key comes from the
 * character bridge's `fetch` option, fed the same resolver.
 *
 * The bundle listing is fetched as well as the directory being named, so an
 * empty or missing bundle fails here, with the character's slug in the message,
 * rather than deep inside the loader on a 404 for `scene.json`.
 *
 * @param client Client for the deployment the character lives in.
 * @param slug Character slug.
 * @param options Id prefix, rig and tags.
 * @returns The character entry, the body-clip entries and the face clips.
 *
 * @example
 * ```ts
 * import { buildCharacterManifestEntries, createAamClient } from 'gameable/aam';
 *
 * const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: key });
 * const built = await buildCharacterManifestEntries(client, 'myra');
 * console.log(built.characterId); // 'char.myra'
 * ```
 */
export async function buildCharacterManifestEntries(
  client: AamClient,
  slug: string,
  options: BuildCharacterManifestOptions = {},
): Promise<AamCharacterEntries> {
  const prefix = toIdSegment(options.idPrefix ?? `char.${slug}`);
  if (prefix === '') {
    throw new AamError(slug, 'idPrefix must contain at least one letter or digit');
  }

  const [bundle, rows] = await Promise.all([
    client.listCharacterBundle(slug),
    client.listAnimationAssets(slug),
  ]);

  if (bundle.files.length === 0) {
    throw new AamError(
      `/api/characters/${slug}/ogs`,
      `character "${slug}" has an empty bundle; upload its /ogs files before referencing it`,
    );
  }

  const tags = options.tags ?? ['aam', toIdSegment(slug)];
  const characterId = joinId(prefix, '');
  const exported = bundle.files.some((f) => f.name === PACKAGE_DESCRIPTOR);
  const rig = options.rig ?? (exported ? PACKAGE_RIG : DEFAULT_RIG);
  // An exported package's loader fetches one descriptor and reads its file names from it;
  // every other rig's loader appends file names to the directory itself.
  const file = rig.backend === 'aosrig-splat' ? PACKAGE_DESCRIPTOR : '';
  const entries: AssetEntry[] = [
    Object.freeze({
      id: characterId,
      type: 'character' as const,
      src: client.resolveFileUrl(`/api/characters/${encodeURIComponent(slug)}/ogs/${file}`),
      tags: Object.freeze([...tags]),
      rig,
    }),
  ];

  const faceClips: AamFaceClip[] = [];
  const seen = new Set<string>([characterId]);

  for (const row of rows) {
    const id = joinId(prefix, toIdSegment(row.name === '' ? row.id : row.name));
    if (seen.has(id)) {
      throw new AamError(
        `/api/characters/${slug}/animation-assets`,
        `clip "${row.name}" (row ${row.id}) collides with an existing id "${id}"; rename it in the Asset Manager`,
      );
    }
    seen.add(id);

    const url = client.resolveFileUrl(row.file_url);
    if (row.kind === 'face') {
      faceClips.push(faceClipOf(id, url, row));
    } else {
      entries.push(
        Object.freeze({
          id,
          type: 'gltf' as const,
          src: url,
          tags: Object.freeze([...tags, 'clip', row.additive ? 'additive' : 'base']),
        }),
      );
    }
  }

  return Object.freeze({
    characterId,
    entries: Object.freeze(entries),
    faceClips: Object.freeze(faceClips),
  });
}

/**
 * Build the face-clip record for one row.
 *
 * @param id Manifest-style id.
 * @param url Absolute URL of the ARKit track.
 * @param row The server row.
 * @returns The face clip.
 */
function faceClipOf(id: string, url: string, row: AnimationAssetRow): AamFaceClip {
  return Object.freeze({
    id,
    name: row.name,
    url,
    additive: row.additive,
    additiveType: row.additiveType,
    basePoseType: row.basePoseType,
    basePoseAssetId: row.basePoseAssetId,
    refFrameIndex: row.refFrameIndex,
    updatedAt: row.updatedAt,
  });
}

/**
 * Merge generated entries into a game's manifest.
 *
 * Entries built by {@link buildCharacterManifestEntries} carry absolute URLs, so
 * the base manifest's `baseUrl` does not apply to them and is preserved
 * untouched for everything that was already there. A duplicate id throws: an id
 * is the guest/host contract, and silently letting one definition win would
 * change what a running game loads without changing a line of its code.
 *
 * @param base The game's manifest.
 * @param extra Entries to add, or another manifest to take entries from.
 * @returns A new frozen manifest.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 * import { mergeManifests } from 'gameable/aam';
 *
 * const base = parseManifest({ version: 1, baseUrl: '/assets/', assets: [] });
 * const merged = mergeManifests(base, [
 *   { id: 'char.myra.wave', type: 'gltf', src: 'https://aam.example/f/wave.glb' },
 * ]);
 * console.log(merged.assets.length); // 1
 * ```
 */
export function mergeManifests(
  base: AssetManifest,
  extra: AssetManifest | readonly AssetEntry[],
): AssetManifest {
  const added: readonly AssetEntry[] = 'assets' in extra ? extra.assets : extra;
  const seen = new Set(base.assets.map((e) => e.id));
  const assets: AssetEntry[] = [...base.assets];

  for (const entry of added) {
    if (seen.has(entry.id)) {
      throw new AamError(
        entry.id,
        `duplicate asset id "${entry.id}"; the base manifest already declares it`,
      );
    }
    seen.add(entry.id);
    assets.push(entry);
  }

  return Object.freeze({
    version: 1 as const,
    baseUrl: base.baseUrl,
    assets: Object.freeze(assets),
  });
}
