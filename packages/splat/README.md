# gameable/splat

## What

Gaussian splat rendering, on three.js r186's native `GaussianSplat` and a `WebGPURenderer`.

The static path wraps three's SPZ / PLY / SPLAT / KSPLAT / glTF loaders; a linear, unlit splat
without shadows is three's own `GaussianSplat`, anything else (an sRGB splat, the default; one
that is lit or receives shadows) is the fork below. The dynamic path is a maintained, insertion-only fork of
`GaussianSplat.js` that allocates a fixed capacity of gaussians with **no CPU copy**, exposes
the four storage buffers as real `GPUBuffer`s, and can force a re-sort — so a compute shader
owns the gaussians and nothing crosses the bus per frame.

This package also owns every line of private three internals in the repository, in
`src/backendBuffers.ts` (`AGENTS.md` hard rule 8).

## When to use

You are rendering a splat world, or you are writing a producer — a character lift — that
writes gaussians directly into GPU memory. Game code usually does neither: it declares a
`splat` asset in `assets.json` and lets the `splat()` module do the rest.

## Install

```sh
npm install gameable
```

Inside this repository it is a workspace member and needs no install. `three` is a peer
dependency, pinned exactly at `0.186.0` by the root `overrides` — the fork is a copy of one
file from that exact version and the build refuses to drift from it.

## Minimal example

```ts
import { createEngine } from 'gameable/core';
import { splat } from 'gameable/splat';

const engine = await createEngine({
  canvas,
  manifest: { version: 1, assets: [{ id: 'arena', type: 'splat', src: '/arena.spz' }] },
  modules: [splat()],
});

await engine.assets.load('arena');
engine.get('splat').add('arena');
engine.start();
```

Without the engine, for a producer:

```ts
import { createAnimatedSplat, getGPUDevice } from 'gameable/splat';

const sink = await createAnimatedSplat(renderer, {
  capacity: 250_000,
  boundingSphere: { center: [0, 1, 0], radius: 1.4 },
});
scene.add(sink.object3D);

const head = sink.allocate(120_000); // { offset: 0, count: 120000 }
// ... a compute pass on getGPUDevice(renderer) writes sink.buffers.* over that range ...
sink.markGaussiansChanged(); // once per frame, after the pass
```

## API

**Static.** `loadSplat(url, { format?, signal? })` → `SplatAsset { geometry, count, shDegree,
boundingSphere, format, url }`. `parseSplat(buffer, url, format?)` for bytes you already have,
`sniffSplatFormat(url, bytes)` for the decision on its own. `createSplatObject(asset,
{ autoSort?, colorSpace?, environmentLighting? })` → a splat object with bounds computed and
`renderOrder` set.
`registerGltfSplatExtension(gltfLoader)` teaches a `GLTFLoader` `KHR_gaussian_splatting`.

**Dynamic.** `createAnimatedSplat(renderer, { capacity, boundingSphere?, colorSpace?, kernel?,
renderOrder? })` → `AnimatedSplat`,
which implements `SplatSink`: `capacity`, `allocate(count) → SlotRange`, `free(range)`,
`buffers`, `markGaussiansChanged()`, `setBoundingSphere(center, radius)`, `object3D`. Plus
`clearSlots(range?)` and `dispose()`. `createSlotAllocator(capacity)` is the allocator on its
own.

**Colour space.** `colorSpace: 'srgb'` is the default for both: nearly every splat is trained
blending its stored sRGB colours, and three blends in linear light. An sRGB splat is drawn only
by the sRGB pass, `attachSrgbPass(renderer, scene)` from `gameable/core` (or
`gameable/core/render`), which blends it on sRGB values inside your own render; without a
pass it draws nothing and warns once. The engine attaches the pass to its scene at boot.
`colorSpace: 'linear'` is for a splat trained in linear light; it draws in your render directly.
`kernel: 'studio'` draws with the Gameable studio's kernel (exported characters use it).

**Backend.** `getGPUDevice(renderer)`, `isWebGPUBackend(renderer)`,
`acquireSplatGPUBuffers(renderer, splat)`. The layout the buffers use is documented in full at
the top of `src/backendBuffers.ts`.

**Module.** `splat()` → an `EngineModule` that registers the `splat` asset type and publishes a
`splat` service with `add(id)` (it receives shadows) and `added`.

**Shadows.** `createSplatShadows(renderer, scene, { quality?, characterBias?, placeBias? })`:
`addCharacter`, `addPlace(splat, { collider?, panorama? })`, `setQuality(level)`, `setKeyLight`,
`update(dt)`, `info`, `dispose`. The depth maps are drawn again only when something in them
moved (`info.rendered`); characters standing apart get a light camera each, up to four tiles of
one map (`info.tiles`, `clusterShadowCasters`). The biases are metres: 0.12 on a character (its
gaussians sit a little inside the rig mesh that casts), 0.03 on the place. The character bridge
runs one for you. The key light's estimators
(`estimateKeyLightFrom{Panorama,Surfels}`, `panoramaFromGaussians`) are exported too.

**Bench.** `gameable/splat/bench` exports `benchStatic`, `benchDynamic` and the synthetic
`ANIMATE_WGSL` producer. Drive them from `examples/splat-viewer/?bench=1`.

Enable relighting through the standard service after loading the asset:

```ts
const world = engine.get('splat').add('arena', {
  environmentLighting: { radianceSH: probe.radianceSH, emissionWeight: 0.25 },
});
```

`createSplatObject(asset, { environmentLighting })` supports the same opt-in.
Omitting the option draws the splat unlit. The caller owns the returned
object: remove it from the scene and dispose it before disposing the engine.
`createEnvironmentProbe(scene, renderer, panorama, options)` filters a caller-owned
HDR panorama for mesh IBL and scales matching world-space SH for Gaussian lighting.
Its cleanup restores the previous scene environment and frees the filtered texture;
the caller disposes the original panorama. `yaw` rotates the panorama only: rotate
SH into world space during probe preparation.

## Gotchas

- **Splats draw after opaque geometry with depth test on and depth write off.** The sRGB
  splats reach the frame as one transparent layer at the nearest splat. Transparent
  meshes must not intersect splat volumes, and two overlapping splat objects will interleave
  incorrectly — nothing sorts across objects. One character is one `AnimatedSplat`, with every
  branch in a slot range, for exactly this reason.
- **`markGaussiansChanged()` every frame you write gaussians.** Three only re-sorts when the
  view direction moves more than ~1.81°, so a moving avatar in front of a still camera renders
  in a stale order. It looks almost right, which is the problem.
- **The bounding sphere is a promise, not a measurement.** The sort's depth range comes from
  it and frustum culling is off because of it. Keep it current.
- **Capacity is fixed.** Growing would mean reallocating four GPU buffers and every bind group
  pointing at them. Size for the worst case; unallocated slots are zero, and zero is invisible.
- **On the WebGL fallback, write with TSL.** `sink.buffers` throws there; a TSL compute node
  over `sink.nodes`, dispatched once per frame over all of `sink.storageCapacity`, writes the
  splat on both backends. The fallback sorts on the CPU from a fenced readback of the centres,
  read at most every 50 ms. Static splats sort on the CPU there too, about 1.7 ms per 150 k
  gaussians.
- **The fork is byte-checked against upstream.** `npm test -w packages/splat` runs
  `scripts/diff-upstream.mjs` first; every change to `src/three-fork/` must be inside an
  `GAMEABLE EDIT` block or the check fails. See `src/three-fork/UPSTREAM.md`.
- **Shadows come from rig meshes.** The silhouette is the body's (no big hair); a floor's shadow
  edge follows its gaussians (one value each). The light is read once, never per frame.
- **`npx playwright test -c tests/e2e/playwright.config.ts`** runs the end-to-end suite
  (`npx playwright install chromium` once first). A root `test:e2e` script still needs to be
  added, and `src/three-fork/**` still needs a `.prettierignore` entry — the fork is byte-for-
  byte upstream and Prettier would reformat it into permanent drift.

`AnimatedGaussianSplat.setEnvironmentLighting()` optionally mixes captured
emission with diffuse image-based lighting. Supply nine world-space RGB radiance
SH coefficients (three's `SphericalHarmonics3` order), `emissionWeight` and
`diffuseWeight`. Normals follow the current covariance on the GPU; an authored
local `normalOrigin` or the current bounding-sphere centre chooses the outward
hemisphere. `inputColorSpace: 'srgb'` decodes display-referred source colors.
Pass `null` to restore the original shader. Configure when the probe changes,
not per frame. This is approximate relighting of baked colors: no inverse
rendering, recovered material properties, occlusion or path tracing is implied.

Supply `pointLights: [lamp]` to include up to sixteen three `PointLight` objects.
Their position, color, intensity, distance, decay and visibility remain live via
uniforms; animate the lights normally without calling `setEnvironmentLighting`
again. `twoSided: true` lights both sides of approximate normals in room interiors.
`pointLightSoftness` bounds near-source attenuation (default 0.25 world units).
For local lights alone, provide nine zero SH coefficients. Static geometry passed
to `new AnimatedGaussianSplat(asset.geometry)` supports this on both renderers;
dynamic GPU-only geometry still requires WebGPU. Point lights do not cast splat
shadows or remove baked illumination.
