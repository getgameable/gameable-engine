# gameable/core

## What

The engine host. Owns the canvas, the `WebGPURenderer`, the fixed-step loop, the module registry, the three.js scene graph, the camera rigs, the asset registry and the debug overlay.

## When to use

You are bootstrapping an application shell (a template, an example, a custom host). Game code should import `gameable` instead and never touch this package.

Server code (a room's authority, a headless test rig) imports **`gameable/core/headless`**, not the package root. The root exports the renderer engine, whose `engine/Engine.ts` imports `three/webgpu`, so importing anything from it loads three. The `/headless` entry carries `createHeadlessEngine` and the three-free rest a server needs: `resolveFeatures`, `bindFeatures`, `FeatureError` and the feature types, `ModuleError`, `EngineModule`, `EngineServices`, `ModuleRegistry`, `HostContext`, `EngineContext` and `requireRenderContext`.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { createEngine } from 'gameable/core';

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no <canvas> on the page');

const engine = await createEngine({
  canvas,
  manifest: '/assets/assets.json',
  modules: [],
  fixedHz: 60,
  renderer: { backend: 'auto' },
  debug: true,
});

engine.start();
console.log(engine.ctx.caps.webgpu); // true on WebGPU, false on the WebGL fallback
```

## API

**Engine**

- `createEngine(options): Promise<Engine>` — boot around a canvas. Options:
  `{ canvas, manifest?, modules?, fixedHz = 60, maxSubsteps = 5, renderer?: { backend: 'auto' | 'webgpu' | 'webgl', antialias?, pixelRatioCap? }, debug?, loaders?, dracoDecoderPath?, ktx2TranscoderPath? }`.
- `Engine` — `{ start(), stop(), dispose(): Promise<void>, get(id), resize(w, h), scene, camera, renderer, ctx, assets, graph, events, modules, overlay, loop, running }`.
- `resolveEngineConfig(options): EngineConfig` — the defaults, without booting.
- `isWebGPUBackend(renderer): boolean` — which backend three actually gave you.
- `createHeadlessEngine({ manifest?, modules?, fixedHz = 60, maxSubsteps = 5 }): Promise<HeadlessEngine>` — exported from the root and from `gameable/core/headless`, which is where server code takes it. The same modules, loop, clock, events and assets with no renderer, scene or camera (a server tick). `HeadlessEngine` — `{ step(nowMs), start(), stop(), dispose(), get(id), ctx, assets, events, modules, loop, time, running }`; `start()` steps on a drift-free timer, `step` drives it by hand. Modules that need a renderer fail their `init` through `requireRenderContext`.

**Module context**

- `HostContext` — what every module's `init(ctx)` receives on either engine: `{ assets, events, time, config, caps, registerService(id, service), get(id) }`. No scene, camera or renderer.
- `EngineContext` — `HostContext` plus `scene`, `camera` and `renderer`; what `createEngine`'s modules actually get.
- `requireRenderContext(ctx, moduleId): EngineContext` — narrow a `HostContext` in a module that needs the scene or renderer; on a headless engine it throws a `ModuleError`.
- `isRenderEngine(engine): engine is Engine` — tell an `Engine` from a `HeadlessEngine`, for code (a feature's `bind`) that takes either.

**Modules**

- `EngineModule` — `{ id, order?, init(ctx), beginFrame?, fixedUpdate?(dt), update?(dt, alpha), endFrame?, dispose() }`.
- `createModuleRegistry(): ModuleRegistry`, `ModuleError`.
- `EngineServices` / `EngineEventMap` — empty interfaces other packages merge into; see [Engine modules](../../docs/concepts/modules.md).

**Features**

- `resolveFeatures(features, table): Promise<LoadedFeature[]>` — load the declared features from a name-to-loader table; an unknown name throws `FeatureError`.
- `bindFeatures(loaded, engine): Promise<Map<string, unknown>>` — run each feature's `bind` against the booted engine; results keyed by feature name.
- `FeatureTable`, `FeatureLoader`, `LoadedFeature`, `FeatureOptions`, `FeatureError`.

**Loop, time and events**

- `createFixedLoop({ fixedDt, maxSubsteps, fixedUpdate, update, render }): FixedLoop`, `loop.step(nowMs) -> FrameTiming`.
- `createTime(fixedDt): MutableTime` — `{ now, elapsed, fixedDt, frame, timeScale }`.
- `createEvents<M>(): Events<M>` — `on` / `once` / `off` / `emit`, no allocation on emit.

**Scene and cameras**

- `TransformStore` — prev/curr transforms in typed arrays; `set`, `commit()`, `writeInterpolated(id, object3d, alpha)`, `snap(id)`.
- `SceneGraph` — `spawn(id, object, parentId?)`, `despawn(id)`, `get(id)`, `setParent(id, parentId)`; `NO_ENTITY` is `0`.
- `createFirstPersonRig({ camera, eyeHeight?, maxPitch? })` — `setPose(position, yaw, pitch)`.
- `createThirdPersonRig({ camera, pivotHeight?, minDistance?, collisionPadding?, collisionProbe? })` — `setTarget`, `setOrbit(yaw, pitch, distance)`, spring arm shortened by the probe.

**WebGPU and debugging**

- `initWebGPUPatches({ maxStorageBuffersPerShaderStage?, timestampQuery? })` — call before `renderer.init()`.
- `createDebugOverlay({ renderer, backendName })` — F3 panel; `createFrameStats(n)` is the window behind it.

`candleFlicker(seconds, fixtureSeed)` returns a deterministic, continuous intensity
gain in [0.58, 1.2]. The application owns point lights, positions and base intensity.
`createFpsCounter(engine, element)` counts rendered frames into a supplied text
element, resets on tab visibility changes, and returns a cleanup callback. It adds
no UI unless explicitly called; keep markup and Gameable styling in the application.

## Gotchas

- `initWebGPUPatches()` is an explicit call in bootstrap; `createEngine` makes it for you, but a custom host must make it itself, **before** any `GPUDevice` exists.
- The loop runs `fixedUpdate` at 60 Hz with at most 5 substeps, then one interpolated `update`. Do not allocate in either.
- Frames beyond the substep cap are **discarded**, not owed. `FrameTiming.clamped` tells you it happened.
- Server code must not import the package root: it loads three. Use `gameable/core/headless`; `packages/wasm-host/src/server/threeFree.test.ts` holds the server's import graph at zero three loads.
- GNM and decoder characters need WebGPU. On the WebGL fallback `caps.characters` is `false`; check it rather than letting `createCharacter` throw. Exported (`aosrig-splat`) characters draw there too, through the character bridge.
- `engine.dispose()` returns a promise, because `renderer.dispose()` does. Await it before creating another engine on the same canvas.
