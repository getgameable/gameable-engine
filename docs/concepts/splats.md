# Gaussian splats

Worlds are gaussian splats rendered by three.js r186's native `GaussianSplat` on a
`WebGPURenderer`. There are two paths and they exist for different reasons.

**Static** is for worlds. `loadSplat` decodes SPZ (recommended), PLY, SPLAT or KSPLAT — or a
glTF carrying `KHR_gaussian_splatting` — and `createSplatObject` puts an unmodified
`GaussianSplat` in the scene. Nothing is forked: a world never changes, so three's one-time
repack and its camera-driven re-sort are exactly right.

**Dynamic** is for characters. `createAnimatedSplat` allocates a fixed capacity of gaussians
with **no CPU copy at all** and hands out the four `GPUBuffer`s behind them, so a compute
shader writes centres, covariances and colours straight into the buffers the vertex stage
reads. That needs a maintained fork of `GaussianSplat.js`: a subclass cannot do it,
because the base constructor repacks the source geometry, keeps it, and derives bounds
from it before `super()` returns, and undoing that afterwards costs 13 MB and about
90 ms of CPU per 250k-gaussian character.

## What a splat is, on the GPU

`GaussianSplat` repacks its source geometry **once** into four storage buffers and never looks
at the source attributes again except for raycasting, bounds and the WebGL CPU sort. Those
four buffers are the real data model, and a producer must match them exactly:

| Buffer        | WGSL type          | Contents                                  | Bytes/splat |
| ------------- | ------------------ | ----------------------------------------- | ----------- |
| `center`      | `array<vec4<f32>>` | `xyz` = centre in local space, `w` unused | 16          |
| `covarianceA` | `array<vec4<f32>>` | `(c00, c01, c02, c11)`                    | 16          |
| `covarianceB` | `array<vec4<f32>>` | `(c12, c22, 0, 0)`                        | 16          |
| `color`       | `array<u32>`       | `pack4x8unorm(vec4(r, g, b, a))`          | 4           |

The six covariance floats are the upper triangle of the symmetric 3×3 covariance
`Σ = (R·S)(R·S)ᵀ`, in the order `c00, c01, c02, c11, c12, c22` — the order three's own
`writeCovariance` writes, split 4/2 across the two `vec4` buffers. `covarianceB.zw` is padding
and is never read.

Two consequences worth internalising:

- **52 bytes per gaussian.** A 250 000-gaussian character is 13 MB of GPU memory, fixed at
  allocation and never reallocated.
- **A colour word of zero is invisible.** Alpha 0 falls out of `pack4x8unorm` for a zeroed
  word, so a slot nobody has written renders as nothing. That is what makes unallocated
  capacity free, and what `clearSlots` relies on when a branch is retired.

All of this lives behind `packages/splat/src/backendBuffers.ts`, which is the only file in the
repository allowed to touch `renderer.backend` (`AGENTS.md` hard rule 8). If a three upgrade
moves the private surface, exactly one file fails, and it fails with a message naming the
version it was written against.

## Colour space

Splats are nearly always sRGB, fitted blending sRGB values, so both paths default to
`colorSpace: 'srgb'`, drawn only by the sRGB pass (`attachSrgbPass`, which the engine attaches);
without it they draw nothing and warn once. `'linear'` draws in the app's own pass.

## Sorting

Splats are transparent and must be drawn back to front, so every frame's draw order is a
depth sort of every gaussian. On WebGPU that is `CountingSort`: 4096 depth bins, four compute
passes, and — this is the surprising part — a cost that is almost flat in the splat count.

Three decides _whether_ to sort by comparing the view direction against the last one it sorted
for:

```
needsSort = dot(sortDirection, lastSortDirection) < 0.9995   // about 1.81 degrees
```

So a camera that barely moves does not re-sort, and a **static** splat is usually free. A
camera panning at 2°/frame re-sorts every frame, which is the worst case and the one budgeted
below.

That threshold is also a trap for dynamic splats: if a producer moves the gaussians while the
camera holds still, the order is stale and three has no way to know. `markGaussiansChanged()`
is the fix — it clears the one internal flag that forces a dispatch — and a producer calls it
once per frame after its compute pass. Rendering without it looks _almost_ right, which is
why the end-to-end suite asserts `sortsPerFrame === 1` rather than trusting review.

### Measured cost

Reference box, headless Chromium with WebGPU, 1280×720, camera turning 2°/frame so **every
frame re-sorts**. `sort` is GPU time for the four `CountingSort` passes; `render` is GPU time
for the draw; `writeBuffer/frame` counts every CPU→GPU upload the whole page makes.

| Mode    | Splats | Backend | Sort ms (p50) | Render ms (p50) | Producer ms (p50) | writeBuffer/frame |
| ------- | -----: | ------- | ------------: | --------------: | ----------------: | ----------------: |
| static  |  150 k | WebGPU  |          0.31 |            0.13 |                 — |         2 (160 B) |
| dynamic |  100 k | WebGPU  |          0.31 |            0.09 |             0.004 |         2 (160 B) |
| dynamic |  250 k | WebGPU  |          0.33 |            0.21 |             0.008 |         2 (160 B) |
| dynamic |  500 k | WebGPU  |          0.37 |            0.42 |             0.013 |         2 (160 B) |

Read that column again: **the sort is 0.31 ms at 100 k and 0.37 ms at 500 k.** The bin count
dominates, not the splat count, so sorting is a fixed ~0.35 ms tax rather than a per-splat
cost. The spike measured 0.42 ms for a 1 M-gaussian SPZ on the same box. What does scale is
the _draw_, roughly linearly in splats.

The two `writeBuffer` calls per frame are three's own camera uniforms; they are present in the
static case too. **No gaussian data crosses the bus after allocation** — that is the whole
point of the dynamic path, and it is asserted, not assumed.

## Dynamic splats: slots

One character is one `AnimatedSplat`, and every branch of it — head, body, eyes, hair — is a
slot range inside that one buffer. That is not an optimisation: splats can only be sorted
against others in the same object, so an avatar split across several `GaussianSplat`s would
have its own parts drawn in the wrong order against each other.

```ts
const sink = await createAnimatedSplat(renderer, {
  capacity: 250_000,
  boundingSphere: { center: [0, 1, 0], radius: 1.4 },
});
scene.add(sink.object3D);

const head = sink.allocate(120_000); // { offset: 0, count: 120000 }
const body = sink.allocate(90_000); //  { offset: 120000, count: 90000 }
```

Allocation is first fit, and frees coalesce with both neighbours, so a load/unload cycle does
not fragment the buffer. Capacity is fixed for the object's lifetime: there is no growth path,
because growing would mean reallocating four GPU buffers and rebuilding every bind group that
points at them.

The bounding sphere is **not** cosmetic. The sort's depth range is derived from it, and a
sphere that does not contain the gaussians crushes them into too few of the 4096 bins.
Frustum culling is off in dynamic mode for the same reason it has to be declared rather than
measured: a producer can move gaussians outside it between two frames and the CPU would never
know. Keep it up to date with `setBoundingSphere`.

## Draw order

Splats draw **after** opaque geometry, with depth test on and depth write off, and after
ordinary transparent meshes (`renderOrder = 1000`, `SPLAT_RENDER_ORDER`). An sRGB splat (the
default) is drawn by the sRGB pass (see Colour space): before your render, against a depth-only
render of your opaque objects, into a target of its own; during your render one transparent
object, placed at the nearest splat with its render order, lays the result over the frame. A
linear splat draws in your render directly, as a transparent object.

This is a real constraint on level design, not a detail:

- **A transparent mesh must not intersect a splat volume.** Three sorts transparent objects by
  their object centre, so an intersecting pair has exactly one draw order for the whole
  overlap and one of them will be wrong somewhere. The sRGB splats are one such object between
  them: a pane of glass in front of a character is drawn under it.
- **Two splat objects that overlap in space will interleave incorrectly**, for the same
  reason. Each sorts its own gaussians perfectly; nothing sorts across objects. If two things
  must blend into each other, they belong in one `AnimatedSplat`, in different slot ranges.
- Opaque geometry is fine at any depth: its depth is drawn first, in one render, and the
  splats test against it. Each mesh keeps its material's side, and a cut-out (`map` or
  `alphaMap` with `alphaTest`) hides only where its texture is solid.
- The sRGB pass uses camera layers 30 and 31 for its own renders: leave them free.
- The pass hooks `scene.onBeforeRender` and `scene.onAfterRender`. If your app assigns those
  itself, or renders through something that skips them, attach it with
  `attachSrgbPass(renderer, scene, { hook: false })` and call `pass.begin(camera)` just before
  `renderer.render(scene, camera)` and `pass.end()` just after. Without the hook, a render of
  the scene made during yours (a reflection) is not told apart and shows the splats too.

## The WebGL fallback

`WebGPURenderer` falls back to a WebGL backend when the browser has no WebGPU, and static
splats still work there — three sorts on the CPU instead. It is slower, and it gets worse with
size, because unlike the GPU sort this one really is linear:

| Splats | CPU sort ms (p50) |
| -----: | ----------------: |
|   75 k |               0.9 |
|  150 k |               1.7 |
|  250 k |               3.0 |
|    1 M |              11.6 |

At 1 M gaussians the sort alone is two thirds of a 16.6 ms frame. Budget the fallback at a few
hundred thousand splats, and remember the sort only runs when the camera turns far enough — a
player standing still pays nothing.

**Dynamic splats run on the fallback, written from TSL.** There are no `GPUBuffer`s there, so
a producer writes `sink.nodes` with a TSL compute node dispatched over `sink.storageCapacity`
(three runs it as transform feedback: one full dispatch per frame, invocation `i` writes slot
`i`). The CPU sort needs centres, which dynamic mode keeps only on the GPU, so `AnimatedSplat`
reads them back behind a fence, at most every 50 ms, and sorts from them when they land; the
camera side of the sort is always current. On an RTX 4080 SUPER at 250 k gaussians the read costs
about 2 ms of main thread and the sort about 1.2 ms, and neither ever waits on the GPU.

**GNM heads and decoder characters need WebGPU**: check `engine.caps.characters` before creating
one, and design a game that degrades (capsules, not a black screen). The Gameable studio's
exported characters draw on the fallback too, through the character bridge, slower;
`gameable/three` too.

## The fork

`packages/splat/src/three-fork/AnimatedGaussianSplat.js` is three's `GaussianSplat.js`
verbatim plus marked insertions (listed in `UPSTREAM.md`): among them a capacity constructor
that skips the O(N) repack, `markGaussiansChanged`, owner-supplied bounds, no-op CPU-mirror
readers, the WebGL fallback's readback sort and transform-feedback-friendly storage, the
colour's space, the studio's kernel and the sRGB pass's output switch.
Every deviation lives between `// GAMEABLE EDIT <n> BEGIN` and `END`, and
`packages/splat/scripts/diff-upstream.mjs` strips those blocks and asserts what is left is
byte-identical to the pinned upstream file. It runs as the package's `pretest` and as a unit
test, so a three upgrade cannot slip through quietly. `src/three-fork/UPSTREAM.md` explains
each edit, and each of the three planned edits that turned out to be unnecessary.

## See also

- [Characters](./characters.md)
- [Assets and the manifest](./assets.md)
- [Load a splat environment](../recipes/load-a-splat-environment.md)
- `packages/splat/README.md` — gameable/splat
