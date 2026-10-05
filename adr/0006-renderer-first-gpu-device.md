# ADR 0006: The renderer owns the GPUDevice; everything else borrows it

- **Status**: Accepted — shipped in M3
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 5

## Context

The lift compute shaders, onnxruntime-web and three must all write into the same
GPU memory. If ORT requests its own adapter, buffers cannot be shared and every
frame pays a CPU round trip.

## Decision

Bootstrap order is `initWebGPUPatches()` -> `renderer.init()` ->
`ort.env.webgpu.device = renderer.backend.device` -> ORT sessions -> lift
pipelines. Nothing calls `navigator.gpu.requestAdapter()` itself. If ORT refuses
the supplied device, demote to download-outputs (a CPU round trip) rather than
creating a second device. Characters are explicitly unsupported on the WebGL
fallback backend, surfaced as `engine.caps.characters`.

## Consequences

- Compute output feeds straight into splat storage buffers.
- `initWebGPUPatches()` becomes an explicit, ordered bootstrap step.
- ORT is pinned exactly, with an identity integration test guarding the device
  hand-off across upgrades.
- WebGL users get splat worlds but no splat characters, by design.
- The order is not merely preferred, it is one-shot: `onnxruntime-web` caches its
  device on the **first** WebGPU session create, and a later
  `env.webgpu.device = …` is silently ignored. Every copy between a decoder
  output and a lift buffer then throws `Buffer is associated with [Device]`. So
  `attachOrtDevice` _reports_ whether it was in time
  (`OrtDeviceAttachment.shared`) rather than assuming, and the pipeline demotes
  to `DownloadOutputs` — correct, but a CPU round trip per output — when it was
  not. `createCharacter` does the whole sequence for you; the individual
  functions exist for a host that wants to attach the device before it loads any
  character.
- `prepareLiftDevice` additionally asserts
  `maxStorageBuffersPerShaderStage >= 8`. Eight is WebGPU's default limit, which
  every adapter grants, and the lift's heaviest pass binds exactly eight — which
  is also why the pass folds its validity test into the `triim` value rather than
  taking a ninth buffer.
