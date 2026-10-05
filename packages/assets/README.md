# gameable/assets

## What

The manifest loader and asset registry. Parses and validates `assets.json` against its JSON Schema, resolves string ids to stable handles and URLs, and loads glTF (with Draco and optional KTX2) and audio. Splats and characters plug their own loaders in.

## When to use

Any host build. The engine constructs it from the `manifest` option; you rarely call it yourself.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { createAssetRegistry, createDefaultLoaders, parseManifest } from 'gameable/assets';

const manifest = parseManifest({
  version: 1,
  baseUrl: '/assets/',
  assets: [
    { id: 'arena', type: 'gltf', src: 'arena.glb', tags: ['world'] },
    { id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] },
  ],
});

const assets = createAssetRegistry({ manifest, loaders: createDefaultLoaders().loaders });
await assets.preload('world');

console.log(assets.resolve('arena')); // 1 — the handle that crosses the wasm boundary
console.log(assets.url('shot')); // '/assets/sfx/shot.ogg'
```

## API

**Manifest**

- `parseManifest(json, options?): AssetManifest` — hand-written validation; throws `ManifestError` with a `path` such as `assets[2].collider.radius`.
- `loadManifest(url, options?): Promise<AssetManifest>` — fetch plus parse; `baseUrl` defaults to the manifest's own directory.
- `resolveAssetUrl(manifest, entryOrId): string`, `findEntry(manifest, id)`, `joinUrl(baseUrl, src)`.
- Types: `AssetManifest`, `AssetEntry`, `AssetType` (`splat | gltf | character | audio`), `AssetCollider`, `AssetRig`, `ExpressionSpace`.

**Registry**

- `createAssetRegistry({ manifest, loaders?, signal? }): AssetRegistry`.
- `AssetRegistry` — `resolve(id): number` (stable 1-based `u32`, `0` = none), `idOf(handle)`, `entry(idOrHandle)`, `url(idOrHandle)`, `load(idOrHandle)`, `get(idOrHandle)`, `preload(tag?)`, `onProgress(cb)`, `registerLoader(type, fn)`, `hasLoader(type)`, `dispose()`.
- `AssetError` — carries the `assetId` that failed.

**Loaders**

- `createDefaultLoaders(options?)` — `{ loaders: { gltf, audio }, dispose() }`, what `createEngine` registers.
- `createGltfLoader({ dracoDecoderPath?, ktx2TranscoderPath?, renderer? })`, `createAudioLoader({ fetch? })`, `DEFAULT_DRACO_DECODER_PATH`.
- `AssetLoader` — `(url, entry, ctx) => Promise<unknown>`.

## Gotchas

- Ids are the guest/host contract. Renaming an id is a breaking change; changing a `src` is not.
- Handles are assigned in manifest order. Reordering `assets.json` renumbers them, which invalidates a saved snapshot.
- `audio` resolves to an `ArrayBuffer`, not an `AudioBuffer`: decoding needs an `AudioContext`, which is `gameable/audio`'s business.
- The Draco decoder is **not** bundled. Copy `three/examples/jsm/libs/draco/` into your `public/` directory or point `dracoDecoderPath` at a CDN.
- `preload` settles every entry before it rejects, so one bad asset does not hide the rest; the failures arrive together in an `AggregateError`.
- `load(id)` hands back **one shared promise** per id — the in-flight one while it loads, then the resolved one forever after — so a hot path may call it every frame without allocating. A load that _fails_ is not memoised: the next call really retries.
- An unknown id rejects with a **shared** `AssetError`, one per distinct name, so a game that asks for a missing sound sixty times a second does not build sixty stack traces. It is deliberately the same error object each time.
- `entry(id)` and `entry(handle)` return the manifest's own entry object, never a copy, and `url()` is precomputed per handle — both are an array index.
- `findEntry` memoises its lookup table against the manifest **object**. That is exact rather than convenient: `parseManifest` freezes what it returns, so the entries behind an index can never change. A manifest built by hand and mutated afterwards is not something this package supports.
