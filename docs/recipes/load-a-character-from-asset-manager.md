# Load a character from the Asset Manager

## Goal

An AvatarOS Asset Manager character appears in your game under an ordinary asset
id — `char.myra` — without its URL ever being written down. The game still boots
from its own `assets.json`, and still runs unchanged when the Asset Manager is
not configured.

## Files you will edit

- `.env.local`
- `src/game.ts`

## Steps

1. Point the adapter at your deployment. `.env.local` is git-ignored; the key
   never goes in `.env` or in `assets.json`.

   ```sh
   VITE_ASSET_MANAGER_URL=https://asset-manager.example
   VITE_ASSET_MANAGER_API_KEY=<your key>
   ```

   Add the same two names, with an empty value, to `.env.example` so the next
   person knows they exist.

2. In `src/game.ts`, read the configuration. `null` means the adapter is not in
   use, and the rest of this recipe is skipped — that is the supported case, not
   an error.

   ```ts
   import { aamConfigFromEnv, createAamClient } from 'gameable/aam';

   const config = aamConfigFromEnv();
   const client = config === null ? null : createAamClient({ ...config, cache: 'cache-storage' });
   ```

3. Merge the character into the manifest you already loaded. One call reads the
   character's bundle listing and its clips; `mergeManifests` appends them and
   throws if an id collides with one of yours.

   ```ts
   import { buildCharacterManifestEntries, mergeManifests } from 'gameable/aam';

   let manifest = await loadManifest('/assets/assets.json');
   if (client !== null) {
     const built = await buildCharacterManifestEntries(client, 'myra');
     manifest = mergeManifests(manifest, built.entries);
   }
   ```

4. Build the registry from the merged manifest, and give the loaders the
   resolver's `fetch` so the AAM entries carry the key and the public ones do
   not.

   ```ts
   import { createAamResolver } from 'gameable/aam';

   const fetchImpl = client === null ? fetch : createAamResolver(client).fetch;
   const assets = createAssetRegistry({
     manifest,
     loaders: createDefaultLoaders({ fetch: fetchImpl }).loaders,
   });
   ```

5. Use the character by id, exactly like a local one. Nothing below this line
   knows where the bytes came from.

   ```ts
   await assets.load('char.myra');
   ```

## Verify

Run `npm run dev`. The character renders, and the network panel shows the
requests to `/api/characters/myra/ogs` carrying an `X-API-Key` header while the
requests to your own `/assets/` directory carry none.

Asserting it in a test: the merged manifest gains the character id, and the key
is attached only to the Asset Manager's own origin.

```ts
const built = await buildCharacterManifestEntries(client, 'myra');
expect(mergeManifests(manifest, built.entries).assets.map((e) => e.id)).toContain('char.myra');
expect(client.owns('https://cdn.example/arena.spz')).toBe(false);
```

## See also

- [Assets and the manifest](../concepts/assets.md)
- [Characters](../concepts/characters.md)
- `packages/assets-aam/README.md` — gameable/aam
- [Play an animation on a character](./play-an-animation.md)
