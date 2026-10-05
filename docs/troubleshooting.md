# Troubleshooting

Symptom first, then the fix.

## Setup

### `npm install` fails with `EBADENGINE`

`.npmrc` sets `engine-strict=true` and the repository requires Node >= 24. Check
`node --version` against `.nvmrc`. Do not work around it by disabling
`engine-strict`; install the right Node.

### ESLint reports `no-bare-three-import`

You wrote `import { Mesh } from 'three'`. Use `three/webgpu` (renderer and core),
`three/tsl` (node materials) or `three/addons/...` (loaders and controls). The
bare entry point pulls in the WebGL renderer and can create a second three
singleton in the bundle, which breaks `instanceof` checks in confusing ways.

## Rendering

### Nothing renders and the console mentions `requestAdapter`

WebGPU is unavailable. Check `chrome://gpu`. Splat worlds fall back to the WebGL
backend; splat **characters** do not — `engine.caps.characters` will be `false`
and `createCharacter` rejects with `CharacterUnsupportedError`.

### Splats look correct but transparent objects flicker through them

Splats draw after opaque geometry with depth test on and depth write off, and the
sRGB splats (the default) reach the frame as one transparent layer placed at the
nearest splat. A transparent mesh that intersects a splat volume, or sits between
two splat objects, has no correct ordering. Move the mesh out of the volume, or
make it opaque.

### A splat draws nothing and the console asks for an sRGB pass

Attach one: `attachSrgbPass(renderer, scene)` from `gameable/core` (the engine does it itself).

### `renderer.backend.device` is undefined

You read it before `await renderer.init()`. Bootstrap order is
`initWebGPUPatches()` -> `renderer.init()` -> hand the device to
onnxruntime-web -> create lift pipelines.

## Wasm guest

### The game behaves differently in `npm run dev` and `npm run build`

That is a parity bug between direct and wasm mode, and it is a real bug, not a
configuration issue. Run the parity test; it hashes transform buffers from both
modes over the same tape.

### Every run produces identical "random" numbers

You seeded at module scope. Wizer snapshots the QuickJS heap at build time, so
module-level state is frozen into the binary. Seed from `env.seed()` inside
`init()`.

### `TextDecoder is not defined` (or a timer API is missing)

QuickJS does not ship the whole web platform. The SDK prelude polyfills what the
engine needs; if you need something else, add it to the prelude rather than
reaching for a browser global in guest code.

### A command had no effect this frame

Commands are batched into `frame-output` and applied by the host afterwards. You
cannot read back the result of a spawn in the same tick. The guest mints handles
precisely so you do not need to.

## Assets

### `Unknown asset id`

The id is not in `assets.json`, or you used a path. Assets cross the boundary as
string ids only. Add a manifest entry; `docs/schemas/assets.schema.json` is the
shape it must have.

### A binary file is a text stub after cloning

Git LFS is not installed and the file is LFS-tracked. Install LFS and
`git lfs pull`. Note that `fixtures/**` and `tests/fixtures/**` are deliberately
**not** LFS-tracked, so tests run on a clone without it.

## See also

- [Install](./start/01-install.md)
- [Glossary](./glossary.md)
- [The wasm boundary](./concepts/wasm-boundary.md)
