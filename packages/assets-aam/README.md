# gameable/aam

## What

The optional AvatarOS Asset Manager (AAM) adapter. It turns an AAM-hosted
character into ordinary `assets.json` entries at runtime, and supplies the
`fetch` that knows which URLs the API key belongs to.

Nothing else in the engine knows AAM exists. Game logic still addresses assets
by string id; the ids simply come from a listing instead of a checked-in file.

## When to use

Use it when a character's splat bundle and animation clips live in AAM rather
than beside the build — a character that is still being iterated on, or one
shared across several games. Do **not** use it for shipped, frozen content: a
static `assets.json` needs no key, no network round trip at boot, and no
adapter.

The adapter is optional in the strongest sense. With `VITE_ASSET_MANAGER_URL`
unset, `aamConfigFromEnv()` returns `null` and the game runs unchanged.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

Add the two variables to your game's `.env.example` so the next person knows
they exist — and only there. The key itself never goes in a committed file:

```sh
# .env.example
VITE_ASSET_MANAGER_URL=https://asset-manager.example
VITE_ASSET_MANAGER_API_KEY=
```

Real values go in `.env.local` (git-ignored). Leaving
`VITE_ASSET_MANAGER_API_KEY` empty is valid: a deployment served from the same
site authenticates with its session cookie and no `X-API-Key` header is sent.

## Minimal example

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

  // Hand this `fetch` to anything that loads the merged entries.
  const resolver = createAamResolver(client);
  const scene = await resolver.fetch(`${built.entries[0].src}scene.json`);
  console.log(built.characterId, scene.ok); // 'char.myra' true
}
```

## API

- `createAamClient({ baseUrl, apiKey, fetch?, retries = 3, backoffMs = 300, cache = 'none' })`
  — `listAnimationAssets(slug)`, `listCharacterBundle(slug)`, `fetchFile(url, { signal?, version? })`,
  `resolveFileUrl(path)`, `owns(url)` and the raw `request(input, init?)`.
  Retries a network error or a 5xx with exponential backoff; a 4xx returns at
  once. `cache: 'cache-storage'` serves file bytes from the
  `gameable-aam-v1` bucket when the browser has one.
- `buildCharacterManifestEntries(client, slug, { idPrefix = 'char.' + slug, rig?, tags? })`
  — `{ characterId, entries, faceClips }`. `entries` is a `character` entry
  whose `src` is the bundle's virtual directory URL, plus a `gltf` entry per
  body clip. `faceClips` is a JSON list, because ARKit tracks have no manifest
  type.
- `mergeManifests(base, extra)` — appends entries to a manifest. A duplicate id
  throws rather than letting one definition win.
- `createAamResolver(client)` — `{ fetch }` for the `fetch` option of
  `loadManifest` and `loadCharacterBundle`.
- `aamConfigFromEnv(env = import.meta.env)` — `{ baseUrl, apiKey }` or `null`.
- `AamError` — carries `path` and, for a failed response, `status`.

## Gotchas

- **Never commit the key, never log it.** It is read once from the environment
  and lives only inside a client closure. It is attached to URLs under `baseUrl`
  and to nothing else, so a manifest that mixes AAM assets with a public CDN
  cannot leak it to the CDN. Do not put it in a query string.
- Ids are derived from clip **names**, sanitised to the manifest's
  `^[a-z0-9][a-z0-9._-]*$`. Two clips whose names sanitise to the same id throw;
  rename one in the Asset Manager rather than working around it here.
- The generated `src` values are absolute URLs, so the base manifest's `baseUrl`
  does not apply to them. That is deliberate: AAM is a different origin.
- `cache: 'cache-storage'` is inert under Node and in any browser without the
  Cache Storage API — the guard is `typeof caches !== 'undefined'`, and a cache
  read or write failure falls through to the network rather than throwing. The
  bucket is opened once per client and shared by every file it fetches.
- `fetchFile` sends `cache: 'no-store'` **only** in `cache-storage` mode, where
  this client is the cache and a second unversioned copy in the HTTP cache
  would be waste. With `cache: 'none'` the browser's own cache is the only one
  there is, and suppressing it would re-download every asset on every run.
- A 5xx that is about to be retried has its body cancelled first. An un-drained
  response body holds its connection open, which is a socket per retry.
- Pass `version` (the row's `updatedAt` or `size`) to `fetchFile` when caching.
  Without it the entry is keyed by URL alone, and re-uploaded bytes are served
  from the old cache entry forever.
- Building entries costs two requests per character. Do it once at boot, not per
  spawn.
