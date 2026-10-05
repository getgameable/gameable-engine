# ADR 0005: Fork three.js's GaussianSplat into gameable/splat as AnimatedGaussianSplat

- **Status**: Accepted — shipped in M3
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 4

## Context

three r186's `GaussianSplat` copies its attributes into storage buffers **once**
and re-sorts only when the camera direction moves more than about 1.81°. There
is no per-frame update path and no way to reach the underlying `GPUBuffer`.
Splat characters need to rewrite every gaussian, every frame, from a compute
shader.

A subclass cannot do it. Three of the five behaviours below are decisions the
base constructor makes before `super()` returns — skipping the O(N) repack,
keeping no source geometry, and not deriving bounds from zero-filled data. The
spike shipped a subclass and had to allocate, then discard, `capacity * 13`
floats to get past them: 13 MB and about 90 ms of CPU per 250k-gaussian
character.

## Decision

Fork `GaussianSplat.js` into `packages/splat/src/three-fork/` as an
**insertion-only** patch. Every change lives between `// GAMEABLE EDIT <n>
BEGIN` and `END`; `packages/splat/scripts/diff-upstream.mjs` strips those blocks,
maps the two rewritten import specifiers back, and asserts the result is
byte-identical to `three@0.186.0`'s `examples/jsm/objects/GaussianSplat.js`
(sha256 recorded in `UPSTREAM.md`). It runs as the package's `pretest` and as a
unit test.

Six marked blocks: an import remap, and **five real edits**.

| Edit | What it does                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Import specifiers: `../gpgpu/CountingSort.js` → `three/addons/…`, likewise `GaussianSplatUtils.js`. The fork lives outside three's examples tree, and hard rule 1 wants addon specifiers anyway. `CountingSort.js` itself needs no fork. |
| 1    | Dynamic capacity: `new AnimatedGaussianSplat({ capacity, boundingSphere })` swaps the geometry for an O(1) stand-in, so the four storage buffers are allocated zero-filled with no CPU copy and no repack.                               |
| 4    | `markGaussiansChanged()`: clears `_sortInitialized`, the one lever upstream has for forcing a sort, because a producer that moves gaussians under a still camera has no other way to say so.                                             |
| 6    | Owner-supplied bounding sphere, plus `frustumCulled = false` in dynamic mode. The sort's depth range is derived from the sphere, so it has to be declared rather than measured.                                                          |
| 8    | `raycast` / `computeBoundingBox` / `computeBoundingSphere` return early — they iterate a CPU geometry dynamic mode does not keep.                                                                                                        |
| 9    | `SplatUnsupportedError` on the WebGL fallback: the CPU sort reads a position attribute that is `null` in dynamic mode, so fail with a sentence rather than deep inside the sort.                                                         |

Three further edits were planned and turned out to be unnecessary, which
`UPSTREAM.md` records so nobody re-derives them: the storage-buffer usage flags
are already `STORAGE | VERTEX | COPY_SRC | COPY_DST`; there is no periodic
re-upload to suppress; and SH degree 0 is a supported upstream path.

All private-backend access is confined to `packages/splat/src/backendBuffers.ts`
(hard rule 8).

## Consequences

- **Zero CPU → GPU traffic per animated character.** Measured: two
  `writeBuffer` calls per frame at 500k dynamic gaussians, and both are three's
  own camera uniforms — the same two a static splat makes.
- The forced per-frame sort is the dominant cost, and it is nearly flat in splat
  count: **0.31 ms at 100k, 0.37 ms at 500k** on the reference box, because 4096
  depth bins dominate rather than the gaussians. The draw is what scales.
- One character is one `AnimatedGaussianSplat`, with every branch in a slot
  range, because gaussians only sort against gaussians in the same object.
- Slots are fixed and never compacted: a culled gaussian is written with alpha 0
  and keeps its address, so the sort's index mapping stays valid.
- The fork must be re-diffed on every three upgrade, and `three` is pinned
  exactly in the root `overrides`. `UPSTREAM.md` has the four-step procedure.
- Dynamic splats do not run on the WebGL fallback at all. Static ones do.
