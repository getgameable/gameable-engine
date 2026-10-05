# gameable/character

## What

The gaussian splat character runtime: bundle loading, the rig → vertices → geometry/appearance
decoders → WGSL lift chain, and the body part driver.

Every branch of one avatar — head, eyes, teeth, hair, clothes — writes its gaussians into slot
ranges of **one** `AnimatedSplat`, so the whole character sorts as a unit. The rig stage is
pluggable behind `RigBackend`: `orl` (OpenRigLogic, evaluated by a vendored wasm module) and
`gnm` (a baked parametric head run by `gnm_blend.wgsl` from an `.aosrig` pack).

It also runs the characters the Gameable studio exports (`aosrig-splat`): the loader
(`loadAosrigSplatBundle`), the runtime (`createAosrigSplat`, two TSL compute passes on WebGPU
or WebGL2) and `buildAosrigCharacter`, which builds one with its sinks for a host. The
`gameable/character/aosrig` entry has only that part: no onnxruntime-web and no RigLogic
wasm, so an app that shows exported characters ships neither.

## When to use

Your game needs a photoreal avatar whose face you drive per frame. The decoder and rig-preview
paths require the WebGPU backend — check `engine.caps.characters` first.

For a static splat world, use `gameable/splat` instead; it does not need any of this.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install. `three` is a
peer dependency (any 0.186 patch). `onnxruntime-web` is an optional peer: only the decoder path
needs it.

## Minimal example

```ts
import { createAnimatedSplat } from 'gameable/splat';
import { createCharacter, loadCharacterBundle } from 'gameable/character';

const splat = await createAnimatedSplat(renderer, { capacity: 262144 });
scene.add(splat.object3D);

const bundle = await loadCharacterBundle('/assets/characters/myra/');
const character = await createCharacter(bundle, { renderer, scene, sink: splat });

const weights = new Float32Array(character.expressionSpace.dim);

function frame(dt: number): void {
  character.setExpression(weights);
  character.update(dt, camera);
  splat.markGaussiansChanged();
}
```

## API

**Loading and lifetime**

- `loadCharacterBundle(url, { fetch?, signal?, resolver?, preferFp16? })` → `CharacterBundle`.
  Reads both bundle layouts (`multi_region` and `schema_version: 1`) into the same object.
  Knows nothing about URLs: a directory URL is just the default `resolver`.
- `createCharacter(bundle, { renderer, scene, sink, options? })` → `Character`. Rejects with
  `CharacterUnsupportedError` on the WebGL fallback.
- `character.dispose()` releases every GPU buffer, ORT session, wasm heap and slot range. It
  is idempotent.

**Driving**

- `setExpression(weights)` — the bundle's declared `expressionSpace`: ARKit-52, `head_ext`
  (387) or the reduced GNM view (68).
- `setRig(controls)` — the bundle's own raw control vector, bypassing the expression map.
- `setBodyPose(pose | null)` — per-joint rotations by the rig's joint names, plus a root
  translation in scene metres.
- `setLookAt(target | null)` — a world point, clamped to ±35° yaw and ±25° pitch per eye.
- `update(dt, camera)` — advance one frame. Cheap and allocation-free when nothing changed:
  every setter compares against what the rig is already holding, so an identical
  expression, look-at target or body pose costs nothing at all.
- `settled()` — resolves when every in-flight pass has drained. For tests and screenshots.
- `memoryReport()` — resident bundle bytes, approximate GPU bytes and slot counts, per branch.

**Device**

- `prepareLiftDevice(renderer)` → the renderer's own `GPUDevice`, with
  `maxStorageBuffersPerShaderStage >= 8` asserted.
- `attachOrtDevice(device)` → `OrtDeviceAttachment`. Reports whether it was in time to share
  the device with onnxruntime-web, rather than assuming.

**Rig**

- `OrlRigBackend`, `orlDriveMode(vertexCount)`, `ORL_HEAD_VERTS`.
- `GnmRigBackend`, `GNM_PACK_FILE`, `parseAosRig` / `packAosRig`, `unpackHeadExt`,
  `headExtNames`.
- `gnmForward` / `gnmPose` / `gazeToEyeRotations` — the CPU reference the GPU path is tested
  against.
- `arkitToRig`, `arkitToMh`, `gatherFromRigNames`, `ARKIT_NAMES`, `MH_RIG_NAMES`.

**Rig preview, for a rig whose decoders do not exist yet**

- `createRigPreview({ renderer, sink, backend, getBytes?, tint?, sigma? })` → `RigPreview`.
  Initialises the backend, allocates one slot per vertex, fits the vertices into view and
  sets the sink's bounds. `setControls` / `encode(encoder)` / `render()` / `dispose()`.
- `DebugVertexLift` — the WGSL pass itself: one isotropic gaussian per rig vertex into a slot
  range, through the same four sink buffers and the same covariance split as the real lift.
  `debugLiftDispatch`, `writeDebugLiftParams` and `fitVertsTransform` are its pure parts, so
  the slot arithmetic and the params layout are node-testable.
- `jointTint`, `uvTint`, `heightTint`, `flatTint`, `packRgba` — per-vertex debug colours,
  computed once on the CPU and uploaded as one `pack4x8unorm` word per vertex.

**Expression mapping**

- `ARKIT_TO_GNM_DEFAULT`, `createArkitToGnmMap(layout)`, `GAZE_FULL_SCALE` — a hand-authored
  ARKit-52 → `head_ext` table and a zero-allocation mapper for it: a **stopgap** for a head
  without a fitted table; see the module header.
- `createFittedArkitMap(table, layout)` — the fitted table an exported package carries
  (`face.arkit`, `arkit_to_gnm.bin`), which the exported runtime plays when it is there.

**Sink**

- `SplatSink`, `SplatSinkBuffers`, `SlotRange`, `SlotAllocator`. The sink interface is
  structurally the one `gameable/splat` implements; this package declares it so it can be
  faked in tests without a GPU.

## Gotchas

- **The decoder path is WebGPU only.** `createCharacter` rejects with `CharacterUnsupportedError`
  on the WebGL fallback; there is no CPU path. An exported character's runtime is TSL and also
  runs on WebGL2.
- **The device order is load-bearing.** `initWebGPUPatches()` → `renderer.init()` →
  `prepareLiftDevice` → `attachOrtDevice` → _then_ the first ONNX session. ORT caches its
  device on the first WebGPU session create; set it afterwards and every buffer copy throws
  `Buffer is associated with [Device]`.
- **Never request your own adapter.** The renderer owns the device; everything here borrows
  `renderer.backend.device`.
- **Call `sink.markGaussiansChanged()` once per frame** after the compute pass. Without it the
  sort only re-runs when the camera turns about 1.81°, and a talking head seen from a still
  camera renders in a stale depth order.
- **Slots are fixed, never compacted.** A culled gaussian is written with alpha 0 and keeps its
  address, because the sort's index → splat mapping has to survive the next frame.
- **A character update is exactly two queue submissions, whatever the branch count.** Every
  branch's rig deform, vertex transform, jacobians and plücker rays go into one encoder,
  submitted before ORT is awaited because the appearance decoder reads the ray buffer; every
  branch's two lift passes go into a second, submitted at the end. Nothing else in the package
  may submit on the per-frame path.
- **Setters compare, they do not just assign.** `setExpression`, `setRig`, `setLookAt` and
  `setBodyPose` raise the rig dirty flag only on a real change, and `setBodyPose` believes the
  rig backend's own "did anything move" answer — an ORL rig has no addressable joints and says
  so, so head aim there must not force a decode.
- **Custom `StorageBufferAttribute`s must have `itemSize` 4 or 1.** three pads an `itemSize` of
  3 up to `vec4` and mutates the attribute in place.
- **`poseAnchors` is off by default.** The baked per-pose head anchors are a real ~4.6 mm
  correction, but the blend moves the head whenever the nearest trained poses change — and
  during speech that happens on a _blink_, stepping the head 5.10 mm in one frame.
- **A rig backend's `vertsAABB` describes `vertsBuffer`, not the model.** GNM keeps its
  neutral head-local but emits vertices in the body's **bind** space, because `bindTransform`
  is folded into the skin matrices — a metre of difference on the shipped head. Bounds taken
  from the model's own frame put the sort's depth bins a metre from the gaussians and render
  nothing at all.
- **The default ARKit → GNM table is hand-authored, not fitted.** It was selected by ranking
  coefficients by vertex displacement (`scripts/rank-gnm-coefficients.mjs`) on one identity.
  Expect a fitted table (an exported package's `face.arkit`) to disagree with every number in it.
- **WGSL ships as generated TypeScript.** `scripts/wgsl-to-ts.mjs` runs in `prebuild` and
  `pretest` and writes `src/generated/*.wgsl.ts`; there is no `?raw` import and no bundler
  plugin to configure.

## See also

- [Characters](../../docs/concepts/characters.md)
- [Load a character](../../docs/recipes/load-a-character.md)
- [Preview a rig without decoders](../../docs/recipes/preview-a-rig-without-decoders.md)
- `examples/character-showcase/README.md` — the rig preview as a running app
- `packages/splat/README.md` — gameable/splat

For an unfitted internal prototype, the exported `gameable/character/tools/gnm_neutral_pack.py` tool builds the same `.aosrig` format from a GNM mean-head model, with numpy as its only Python dependency. The adjacent `gnm_pack.py` is included. This preserves the existing BakedHead conversion contract: conversion is offline and the browser receives only the pack. The output retains source-model licensing and must not be placed in the CC0 placeholder package.
