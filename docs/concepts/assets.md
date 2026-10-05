# Assets and the manifest

All content is declared in an `assets.json` manifest of
`{ id, type: splat | gltf | character | audio, src, tags?, collider?, rig? }`
entries, validated against a [JSON Schema](../schemas/assets.schema.json).
**String ids are the guest/host contract**: game logic asks for `'arena'`, never
for a URL or a path. The registry is the only thing that knows where bytes live,
so content can move between a static directory, an npm placeholder package and
the AvatarOS Asset Manager without touching game code.

```json
{
  "version": 1,
  "baseUrl": "/assets/",
  "assets": [
    { "id": "arena", "type": "splat", "src": "arena.spz", "tags": ["world"] },
    { "id": "shot", "type": "audio", "src": "sfx/shot.ogg", "tags": ["sfx"] }
  ]
}
```

## The registry

```ts
import { createAssetRegistry, createDefaultLoaders, parseManifest } from 'gameable/assets';

const manifest = parseManifest({
  version: 1,
  baseUrl: '/assets/',
  assets: [{ id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] }],
});

const assets = createAssetRegistry({ manifest, loaders: createDefaultLoaders().loaders });
assets.onProgress((p) => {
  console.log(`${String(p.loaded)}/${String(p.total)} ${p.id}`);
});

await assets.preload('sfx');
const bytes = assets.get('shot') as ArrayBuffer;
console.log(assets.resolve('shot'), bytes.byteLength); // 1 <n>
```

`createEngine({ manifest })` builds one of these for you and puts it on
`engine.assets` and `ctx.assets`.

## Handles

`resolve(id)` returns a stable, 1-based `u32` assigned in manifest order; `0`
means "no asset". That number is what crosses the wasm boundary, because a `u32`
costs nothing to pass and a string costs a copy. `idOf(handle)` goes back the
other way, and `entry`, `url`, `load` and `get` all accept either form.

## Loaders

A loader is `(url, entry, ctx) => Promise<unknown>`, registered per asset type.
Core registers two:

- `gltf` — three's `GLTFLoader` with a `DRACOLoader` pointed at a configurable
  decoder directory (`dracoDecoderPath`, default `/draco/`), and a `KTX2Loader`
  when `ktx2TranscoderPath` is given. Both are constructed lazily, on the first
  glTF that needs them.
- `audio` — `fetch` to an `ArrayBuffer`. Decoding needs an `AudioContext`, so it
  is `gameable/audio`'s job, not the registry's.

`splat` and `character` are registered later by the packages that own them:

```ts
import type { AssetRegistry } from 'gameable/assets';

/**
 * Teach a registry how to load splats.
 *
 * @param assets The engine's registry.
 */
export function registerSplatLoader(assets: AssetRegistry): void {
  assets.registerLoader('splat', async (url) => {
    const response = await fetch(url);
    return response.arrayBuffer();
  });
}
```

Asking for an asset whose type has no loader fails with a message naming
`registerLoader` and the type, rather than a silent `undefined`.

## Validation

`parseManifest(json)` is hand-written — no JSON Schema validator ships to the
browser — and throws a `ManifestError` carrying the exact path
(`assets[2].collider.radius`) and what is wrong with it. It enforces everything
the schema does, including the conditional rules: `character` entries need a
`rig`, a `gnm` rig needs a `pack`, a `box` collider needs `halfExtents`, ids are
unique and match `^[a-z0-9][a-z0-9._-]*$`.

`resolveAssetUrl(manifest, entry)` joins `baseUrl` and `src`. Absolute URLs,
protocol-relative URLs and root-relative paths are passed through untouched;
when `baseUrl` carries a scheme, resolution goes through `URL`, so `../`
collapses properly.

## See also

- [assets.schema.json](../schemas/assets.schema.json)
- [Engine modules](./modules.md)
- `packages/assets/README.md` — gameable/assets
- `packages/assets-placeholder/README.md` — gameable/placeholder

## Asset Manager adapter

`gameable/aam` is the one supported way content reaches a game without
being in its `assets.json`. It is optional: with `VITE_ASSET_MANAGER_URL` unset,
`aamConfigFromEnv()` returns `null` and nothing about the boot path changes.

What it does **not** do is as important as what it does. It is not a second
addressing scheme — it produces ordinary `AssetEntry` values, merged into the
manifest before the registry is built, so game logic still asks for `'char.myra'`
and the registry is still the only thing that knows a URL.

```ts
import { loadManifest } from 'gameable/assets';
import {
  aamConfigFromEnv,
  buildCharacterManifestEntries,
  createAamClient,
  createAamResolver,
  mergeManifests,
} from 'gameable/aam';

let manifest = await loadManifest('/assets/assets.json');
const config = aamConfigFromEnv();

if (config !== null) {
  const client = createAamClient({ ...config, cache: 'cache-storage' });
  const built = await buildCharacterManifestEntries(client, 'myra');
  manifest = mergeManifests(manifest, built.entries);
  console.log(built.characterId); // 'char.myra'
}
```

A character becomes one `character` entry whose `src` is a **virtual directory
URL** — `<baseUrl>/api/characters/<slug>/ogs/` — that the character loader
appends filenames to, exactly as it would to a static directory, plus one `gltf`
entry per body clip. Face clips come back as a separate JSON list rather than as
entries, because ARKit weight tracks have no manifest type and inventing one
would be a schema change. Ids are derived from the server's clip names, sanitised
to `^[a-z0-9][a-z0-9._-]*$`; a collision throws, because two clips quietly
collapsing into one id surfaces as a missing animation three scenes later.

### The key

The API key is read once from `VITE_ASSET_MANAGER_API_KEY`, lives only inside a
client closure, and is never logged or placed in a URL. `createAamResolver`
returns a `fetch` that attaches it **only** to URLs under `baseUrl`:

```ts
const resolver = createAamResolver(client);
const registryFetch = resolver.fetch; // for loadManifest / loadCharacterBundle
```

That restriction is the point. A single wrapper that signed every request would
post the credential to whatever public CDN happened to appear in a manifest. An
empty key is legitimate — a deployment on the same site authenticates with its
session cookie, and no `X-API-Key` header is sent at all.

Transient failures are retried with exponential backoff (a network error or a
5xx, three retries by default); a 4xx is definitive and returns immediately,
because retrying a 401 only delays the real message. `cache: 'cache-storage'`
adds a persistent byte cache for the large bundle files, guarded by
`typeof caches !== 'undefined'` so it is inert under Node.

## Placeholder pack

`gameable/placeholder` is the other end of the same idea: content that
is already in the manifest before a game has any of its own. It ships an arena
splat, its collider, four sound effects and a facial idle clip — about 1 MB,
against the 12 MB cap in `AGENTS.md` rule 14.

```ts
import { parseManifest } from 'gameable/assets';
import { PLACEHOLDER_ASSETS_BASE, placeholderManifest } from 'gameable/placeholder';

const manifest = parseManifest(placeholderManifest, { baseUrl: PLACEHOLDER_ASSETS_BASE });
console.log(manifest.assets.map((a) => a.id));
// ['env.arena', 'sfx.shot', 'sfx.hit', 'sfx.pickup', 'sfx.step']
```

That works under Node and under a dev server, and **not** in a bundled build:
`PLACEHOLDER_ASSETS_BASE` is `new URL('../assets/', import.meta.url)`, and in a
production bundle `import.meta.url` is the emitted chunk, not the package. A
browser build has to hand the bundler each file so it is copied and hashed,
which is what `templates/fps/src/main.ts` does:

```ts
import arenaUrl from 'gameable/assets/arena.spz?url';

const manifest = parseManifest({
  version: 1,
  baseUrl: '/',
  assets: [{ id: 'env.arena', type: 'splat', src: arenaUrl }],
});
```

The template keeps the ids in `src/assets.json` and writes the placeholder
sources as `@placeholder/<file>`, which `main.ts` maps onto those `?url`
imports. A game's own files go in `public/` and need no import at all.

Every byte is **generated**, not collected: `scripts/gen-arena.mjs` scatters
gaussians over analytic planes, boxes, a wedge and a dome and writes SPZ v2;
`gen-sfx.mjs` synthesises the WAVs from oscillators and seeded noise;
`gen-face.mjs` evaluates hand-authored ARKit curves at 30 fps. The generators are
seeded, so `npm run generate -w packages/assets-placeholder` reproduces the
committed files byte for byte, and `prebuild` runs it so a build cannot ship
stale bytes. That is what makes the licensing trivial — there is no upstream, so
`assets/CREDITS.md` has nothing to attribute.

### What the manifest cannot hold

Two of the packaged files are not manifest entries, and deliberately so. The
schema fixes `type` to `splat | gltf | character | audio`; an ARKit weight track
and a list of spawn coordinates are neither, and adding a type to hold them would
be a schema change made for a placeholder. They ship as ordinary exports instead
— `arenaSpawns`, and `placeholderAssetUrl('face_idle.arkit.json')` — which is the
same call the Asset Manager adapter makes when it returns face clips outside the
manifest.

### The collider format

`env.arena` declares `{ shape: 'mesh', src: 'arena.collider.bin' }`. That file is
the smallest thing that can carry a triangle mesh: little-endian `u32`
`vertexCount`, `u32` `indexCount`, `f32 positions[3n]`, `u32 indices[m]`, no
magic number and no padding. `parseCollider` and `encodeCollider` in the package
read and write it, and Jolt wants exactly those two flat arrays — a glTF collider
would drag a glTF parser into the physics path for eight boxes and a wedge.
