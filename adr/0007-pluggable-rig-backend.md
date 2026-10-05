# ADR 0007: Pluggable RigBackend: ORL now, GNM next

- **Status**: Accepted — `orl` shipped in M3, `gnm` in M5. See
  [ADR 0012](./0012-gnm-head-via-aosrig-bakedhead.md) for how the GNM pack is
  produced.
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 6

## Context

The head is currently driven by OpenRigLogic. The project is pivoting to Google's
GNM parametric head, which is Apache-2.0 but exists today only as Python and
`.npz`. Decoders will be retrained on GNM topology by another team, on a
different schedule than the engine.

## Decision

Put the rig stage behind `RigBackend` — `kind`, `controlNames`, `vertexCount`,
`init`, `setControls`, `setJointOverrides?`, `encode(encoder)`, `vertsBuffer`,
`vertsAABB`, `dispose`. The bundle's `scene.json` names the backend, in an
optional `rig` block the engine added to the exporter's schema; a bundle that
declares nothing defaults to `orl` with its own `rig_names.json`, which is what
every shipped bundle does.

Two implementations:

- **`orl`** wraps the vendored OpenRigLogic wasm module, then int8 blendshape
  deltas and linear-blend skinning on the GPU. It is the rig the avatar was
  authored with, so it is correct by construction, and it is per-character: the
  pack ships inside the bundle. Its neutral is in centimetres. A branch under
  4096 vertices — hair, a garment — takes a cheaper _shell_ path instead of full
  skinning.
- **`gnm`** consumes a baked `.aosrig` pack and runs as WGSL (`gnm_blend.wgsl`):
  a 383-coefficient linear blend plus LBS. Not ONNX — the model _is_ a matrix
  multiply and an LBS, and pushing that through an inference runtime would be
  slower than the shader. 17,821 vertices, metres, 383 expression coefficients
  plus four gaze angles.

Both share `lbs_common.wgsl`.

## Consequences

- Swapping `"rig": "orl"` for `"gnm"` changes nothing else in a game.
- The seam between "which rig posed this face" and "what the animation layer
  should send" had to be split into two blocks. `rig` says which rig;
  `expression_space` (`arkit52` / `gnm` 387 / `gnm68` 68) says what to send, and
  is separate because two spaces that happen to share a width are otherwise
  indistinguishable. Sending an ARKit vector to a GNM bundle with no trained
  `arkit_map` is refused loudly rather than reinterpreted.
- GNM identity is baked offline, so there is no identity basis at runtime — a
  pack is one character.
- "The skinning differs between backends" is not a bug that can exist, because
  there is one LBS shader.
- Correctness is gated on reference frames exported from the Python model, and
  `gnmReference.ts` is a CPU implementation of the same maths the GPU path is
  tested against.
- ORL remains the shipping backend for faces whose decoders were trained on ORL
  topology; the GNM milestone gated only the rig stage, exactly as planned.
