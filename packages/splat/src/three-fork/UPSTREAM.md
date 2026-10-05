# three-fork/AnimatedGaussianSplat.js

A fork of three.js's `GaussianSplat`, kept as an **insertion-only** patch so drift is
mechanically detectable.

|                  |                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| Upstream package | `three@0.186.0` (pinned exactly in the root `package.json` `overrides`; the published packages accept any 0.186 patch, whose `GaussianSplat.js` is this file) |
| Upstream path    | `examples/jsm/objects/GaussianSplat.js`                                                |
| Upstream sha256  | `ea3f148d39413ef31781cdbb1c97a8972b2dce01ef5eebe6ef800c2b1ba7ab42`                     |
| Upstream lines   | 1039                                                                                   |
| Licence          | MIT, Copyright © 2010-2025 three.js authors — see `LICENSE-three.md` next to this file |

`node scripts/diff-upstream.mjs` (wired as the package's `pretest`) removes every
`// GAMEABLE EDIT <n> BEGIN … END` block, maps the two rewritten import specifiers back,
and asserts the result is byte-identical to the file above. **Every** change to this file
must live inside a marked block; there is no "small tidy-up" exemption, because the check
cannot tell one from a mistake.

## Why a fork and not a subclass

Three of the behaviours below are decisions the base constructor makes before `super()`
returns: skipping the O(N) repack, keeping no source geometry, and not deriving bounds from
zero-filled data. A subclass cannot get in front of them. The spike shipped a subclass and
had to allocate — and then throw away — `capacity * 13` floats to do it; at 250k gaussians
that is 13 MB and ~90 ms of CPU per character.

## The edits

The numbering is the plan's, not a sequence: edits 2, 5 and 7 are deliberately absent (they were
planned, then found unnecessary — see the last section). 10 and 11 came later, from the
performance audit, and continue the same numbering; a new edit takes the next unused number and
never reuses a retired one. 12 is reserved: it was taken on another branch and never landed.

### EDIT 0 — import specifiers

`../gpgpu/CountingSort.js` → `three/addons/gpgpu/CountingSort.js` and
`../utils/GaussianSplatUtils.js` → `three/addons/utils/GaussianSplatUtils.js`.

The fork lives outside three's examples tree, so the relative paths cannot resolve; and
`AGENTS.md` hard rule 1 (`gameable/no-bare-three-import`) wants addon specifiers anyway.
Both resolve through three's own `exports` map (`"./addons/*": "./examples/jsm/*"`).
`CountingSort.js` itself imports only `three/webgpu` and `three/tsl`, so it does **not**
need to be forked or copied.

### EDIT 1 — dynamic capacity

`new AnimatedGaussianSplat({ capacity, boundingSphere })`:

- the descriptor is swapped for an O(1) stand-in that answers the four reads the constructor
  makes of a geometry (`createDynamicStandIn`);
- the stand-in's attribute arrays are `null`, which routes `createStorageBuffers` past its
  `for` loop — the four typed arrays are already zero-filled, which is exactly the state a
  producer wants (a colour word of 0 is alpha 0, i.e. invisible);
- `this._dynamic` records the mode and `this.splatGeometry` is set to `null`, because nothing
  mirrors the GPU data on the CPU;
- `AnimatedGaussianSplat` and `SplatUnsupportedError` are exported.

The stand-in is deliberately **not** a `BufferGeometry`: `getSphericalHarmonicsDegree`
returns 0 for anything without `isBufferGeometry`, which is the SH-degree-0 path dynamic mode
supports. Passing a real `BufferGeometry` still takes the upstream path unchanged.

### EDIT 4 — `markGaussiansChanged()`

Sets `this._sortInitialized = false`, which is the one lever upstream has for forcing a sort:
`updateSort` dispatches when `_sortInitialized === false || _needsSort( camera )`, and
`_needsSort` is a camera-direction test against `SORT_DIRECTION_THRESHOLD = 0.9995` (about
1.81°). A producer that rewrites the centres every frame invalidates the order even with a
perfectly static camera.

### EDIT 6 — owner-supplied bounds

The constructor takes the owner's sphere (default: unit sphere at the origin) and
`setBoundingSphere( center, radius )` updates it. `frustumCulled = false` in dynamic mode,
because a producer can move gaussians outside the declared sphere between two frames and the
CPU would never know. The sphere is not cosmetic: `_updateSortUniforms` builds the sort's
depth range from it, and a sphere that does not contain the splats quantises them into too
few of the 4096 bins.

### EDIT 8 — `raycast` / `computeBoundingBox` / `computeBoundingSphere`

All three iterate `splatGeometry`'s attributes, which dynamic mode does not have. They return
early. `computeBoundingSphere` still guarantees a non-null sphere, because
`_updateSortUniforms` calls it when `boundingSphere === null`.

### EDIT 9 — the WebGL fallback sorts a dynamic splat from centres its owner reads back

The fallback's `_sortCPU` reads `this._positionAttribute.array`, which is `null` in dynamic
mode. This edit used to make `updateSort` throw `SplatUnsupportedError` there. Since the
character TSL work it does not: `setSortCenters( centers )` (xyz per gaussian, kept by
reference) gives the CPU sort something to read and forces the next sort, and until the first
call `updateSort` switches the storage reads to PBO textures and returns false, drawing in the
upstream initial order (the identity). `AnimatedSplat` (`src/AnimatedSplat.ts`) reads the
deformed centres back with a fenced, non-blocking readback (`createStorageReadback` in
`src/backendBuffers.ts`) and calls `setSortCenters` when one lands, so the sort's keys are a
frame or a few old while its camera is current.

`SplatUnsupportedError` stays: edit 1 throws it for spherical-harmonics degree above 0, and
`setSortCenters` throws it on a static splat.

### EDIT 11 — `dispose()`

Upstream has none, and there is a lot to leak: the four `StorageBufferAttribute`s in `_buffers`,
the spherical-harmonics contribution buffer `ensureSphericalHarmonicsContributionBuffer`
allocates lazily, and the four a `CountingSort` holds (`orderAttribute` plus the bin, histogram
and offset attributes, which are constructor locals and are therefore reached through
`binRead`/`histogramAtomic`/`offsetAtomic`). r186's `CountingSort` has no `dispose` of its own.
About 2 MB of GPU memory per despawned character.

`storageAttributes()` returns the deduplicated set (read/write node pairs share one attribute);
`dispose( release )` calls `release` on each, then `attribute.dispose()`, then the geometry and
the material, and is idempotent through `_disposed`.

`release` is injected rather than done here: `BufferAttribute#dispose` only dispatches a
`dispose` event, and `Geometries.js` listens for one on vertex and index attributes but never on
a storage attribute, so the buffer is only freed by `backend.destroyAttribute`. That is
`renderer.backend`, which by hard rule 8 lives in `src/backendBuffers.ts` — hence
`releaseStorageAttribute( renderer, attribute )` there and a plain callback here.

### EDIT 13 — optional environment diffuse lighting

`setEnvironmentLighting` rebuilds only the material graph. Its default remains
captured radiance with no lighting cost. When enabled, four adjugate power
iterations estimate the shortest covariance axis from the current GPU data,
orient it away from an authored interior point, transform it with the world
normal matrix, and evaluate a nine-coefficient irradiance SH convolution.
Captured emission and Lambert diffuse weights are independent; alpha, sorting,
Gaussian coverage and the single-tick guest boundary remain unchanged. Source
sRGB decoding is explicit. No CPU readback or additional storage is introduced.
This is approximate relighting of baked colors, not inverse rendering or path
tracing; concave shapes need a more suitable normal/orientation source.

Edit 13 also accepts up to sixteen host `PointLight` references. Reused uniforms
sample position, linear color, intensity, range, decay and visibility per render;
flicker and movement do not rebuild the shader or read back GPU buffers. The
actual Gaussian centre is transformed to world space before softened distance
attenuation and Lambert shading. `twoSided` supports interior surfaces whose
covariance normal has no reliable orientation. This is unshadowed approximate
lighting, supported on WebGPU and the static-geometry WebGL path.

### EDIT 14 — the colour buffer's convention (`colorSpace`)

Upstream reads the packed colour as linear light, and three's output pass
(`RenderOutputNode`, `workingToColorSpace( SRGBColorSpace )`) encodes every fragment to
sRGB. A Gaussian cloud trained against photographs stores sRGB in `f_dc` (the studio's
PlayCanvas renderer puts `0.5 + SH_C0 * f_dc` on screen untouched), so the engine encoded
those colours twice and every Gameable studio character drew lifted toward white — measured on
Tala, Steph and the bundled greeter: engine = sRGB-encode(studio) to within three levels in
every region. The dynamic descriptor takes `colorSpace: 'linear' | 'srgb'` (default
`'linear'`, upstream's behaviour and the static world path). With `'srgb'` the vertex node
applies `sRGBTransferEOTF` to the colour after the spherical harmonics (the harmonics are
trained in the stored space too), for tint, light and shadow in linear light; edit 20 encodes it
back when the sRGB pass draws it, and without the pass the output encode lands back on the file's
colour. Edit 13's lighting then takes the decoded colour
with `inputColorSpace: 'linear'`, never decoding twice. `this.colorSpace` exposes the
answer. `gameable/splat`'s `createAnimatedSplat` passes the option through, and
`gameable/host` sets `'srgb'` for every `aosrig-splat` export unless its
`character.json` declares `colorSpace: 'linear'`.

A static geometry opts in the same way through `userData.colorSpace` (read inside the same
block, only when there is no dynamic descriptor); `createSplatObject( asset, { colorSpace:
'srgb' } )` sets it and draws through the fork. Measured on a studio place (Plain photo
studio, 2026-09-25): its back wall drew at 194 against 107 in the maker's own panorama of the
same wall, and sRGB-encode(107) is 174 — the same double encode.

### EDIT 15 — an owner's per-fragment opacity factor (`setFragmentAlpha`)

`setFragmentAlpha( builder )` takes a function from the splat's view-space centre (a `vec3`
node, carried to the fragment stage as the varying `vSplatView`) to a float node, and the
fragment's opacity is multiplied by it; `null` restores upstream's fragment exactly (the
varying is not even written). It rebuilds the material nodes the way edit 13's
`setEnvironmentLighting` does, and both keep each other's state on `_buffers`. A character's
mouth uses it (`gameable/character`, `aosrigSplat/mouthRuntime.ts`): where the mouth's
inside shows through the lips, the face's points behind the lips' line fade by a feathered
mask, so the lips meet the teeth with no hard edge.

### EDIT 16 — receiving a key light's shadow (`setShadowReceiver`)

`setShadowReceiver( options )` darkens each gaussian a key light's depth map says is blocked,
and each gaussian on the floor under a foot; `null` restores the shader. It rebuilds the
material the way edits 13 and 15 do and keeps their state on `_buffers`. The lookup is at each
gaussian's centre in the vertex stage (after edit 14's decode and edit 13's lighting): the centre
goes to world space, then through the owner's light matrix (depth 0..1) to a texel; the owner's
taps (`[dx, dy, weight]` triples, baked into the shader) are compared with the map by
`textureLoad`, and the colour keeps `1 - strength * (1 - lit)`. Points outside the map or past
its far plane are lit. The contact shadow loops over up to sixteen floor points (a `vec4`
uniform array: position, weight) and darkens gaussians within a radius across and 22 cm above
each. `createShadowReceiver( options )` checks the options and builds the uniforms;
`shadowFactorAt( worldPosition, receiver )` is the factor as a node, exported so a mesh (the
ground `gameable/splat`'s shadows draw when there is no place) shades the same way. The
matrix, strength, bias and contact points are read every render; only a new level rebuilds.
Measured on the desk (RTX 4090, Tala plus the 1.92 M-gaussian Plain photo studio, 1024², GPU
timestamps): +0.05 to 0.07 ms a frame with 9 taps (the simple level, its depth pass included),
+0.30 ms with 25 taps and the characters' own map (soft). The depth maps and the light are
`src/shadows.ts`'s.

### EDIT 17 — dynamic storage that the WebGL fallback's transform feedback can write

A TSL compute node that writes the four gaussian buffers runs on WebGPU as a compute shader
and on the WebGL2 fallback as transform feedback (`WebGLBackend.compute`). Three things in
r186 decide whether the latter works, found by the character-TSL spike (2026-09-28, SwiftShader
and an RTX 4080 SUPER through ANGLE/D3D11):

- **Instanced attributes.** `WebGLBackend.compute` draws instanced — `instanceIndex` =
  `gl_InstanceID` — only when the pipeline's first attribute `isStorageInstancedBufferAttribute`;
  otherwise every invocation reads and writes element 0 (the picture is one dot). In dynamic
  mode `createStorageBuffers` wraps the four zero-filled arrays in
  `StorageInstancedBufferAttribute`s instead (the plain attributes upstream builds are dropped
  before anything uploads them). WebGPU treats the two classes the same.
- **Capacity padded to the PBO texture.** The draw reads each buffer through a texture
  `2^ceil(log2(sqrt(n)))` wide, and `GLSLNodeBuilder.setupPBO` grows `attribute.array` to
  `width * height` when the material builds. If a compute pass created the GL buffer first at
  the smaller size, the buffer-to-texture copy after every pass overflows
  (`glTexSubImage2D ... overflow`) and nothing draws. `padStorageCapacity( n )` (exported)
  returns `width * height`, and the stand-in allocates that many slots, on both backends. The
  padded slots stay zero, i.e. invisible. `AnimatedSplat.capacity` is still what was asked for;
  `storageCapacity` is the padded size a compute on the fallback dispatches.
- **One full dispatch per buffer per frame** (not code, a rule for producers): transform
  feedback writes invocation `i` to element `i`, three keeps two GL buffers per storage
  attribute and swaps them after every pass, so a partial dispatch or a second dispatch into
  the same buffers leaves elements from two frames back. Documented on `SplatStorageNodes`.

Every storage node a WebGL compute touches becomes a transform-feedback output, read-only ones
included (`StorageBufferNode.generate` → `registerTransform`), and WebGL2 allows four: the four
gaussian buffers use them all. A producer's inputs must be `StorageInstancedBufferAttribute` +
`setPBO( true )` nodes, which the compute stage reads with `texelFetch` instead.

### EDIT 18 — the Gameable studio's kernel (`kernel: 'studio'`)

A dynamic splat can draw with the kernel the studio draws characters with (PlayCanvas 2.22
classic GSplat, which the studio's stage uses), instead of three's. Exported characters were
made and judged on it, and three's made them look washed-out and grainy beside the studio:

- **No opacity reduction.** three multiplies each gaussian's opacity by
  `sqrt(det(cov2D) / det(cov2D + 0.3 I))`, the compensation for its 0.3 px² blur. Small and
  thin gaussians (lashes, brows, hair, a whole head at a distance) lose a large part of their
  trained opacity. The studio keeps the trained value; so does `'studio'` here.
- **2.83 sigma, tail subtracted.** three cuts at 2 sigma (`r² > 4`, alpha `exp(-r²/2)`), a hard
  edge at 0.135 of the peak. The studio's quad reaches `sqrt(8)` sigma and its falloff is
  `(exp(-r²/2) - e⁻⁴) / (1 - e⁻⁴)`, which reaches exactly 0 at the edge. Here the same unit quad
  is scaled by `sqrt(2)` (the vertex offset and the fragment's `splatUv`), and the fragment
  discards past `r² > 8`.

- **Its constants, in true pixels.** PlayCanvas projects the covariance with `focal = viewport
  width * P00`, twice the pixel focal length, so its splat constants are in half-pixel units: its
  `+0.3` blur is **0.075 px²** (three adds a real 0.3 px², four times as much, which washed out
  skin, brows and lashes), its minor-axis floor of 0.1 is 0.025 px² (never reached above the blur),
  its `minPixelSize` of 2 skips a gaussian whose larger half-extent is under **1 px**, and its
  forward pass discards fragments under alpha **1/255**. Measured 2026-09-28 on a studio character
  (neutral pose, same camera, both drawing into an 8-bit canvas blending sRGB values): with these
  the engine matches the studio's own renderer to 46.6 dB PSNR / SSIM 0.996, and every
  spatial-frequency band within 1%; with three's 0.3 px² it kept 22-36% of the finest detail.

`kernel` on the dynamic descriptor (`'three'` by default); `gameable/splat`'s
`createAnimatedSplat` takes it, and both the engine's character bridge and
`gameable/three` ask for `'studio'`. Static splats (places) keep three's.

The studio blends in sRGB space (8-bit canvas, colours as stored), and three's `WebGPURenderer`
with an sRGB output blends in a linear half-float buffer before encoding. Splats are trained
blending their sRGB values, so edit 20 lets an sRGB pass (`gameable/core`'s `attachSrgbPass`) draw
them that way, depth-tested against the scene.

### EDIT 19 — a colour scale (`setColorScale`)

`buffers.colorScale`, a `vec3` uniform (white by default), multiplies every gaussian's colour in the
vertex stage right after edit 14's colour-space decode, so in linear light; `setColorScale(r, g, b)`
sets it (no rebuild). A tint and an exposure, to fit a character into a lit scene
(`gameable/three`'s `tint` / `exposure`). Three blocks: the constructor, the vertex stage, the
method.

### EDIT 20 — sRGB output for an sRGB pass (`srgbOutput`)

An sRGB cloud (edit 14) gets `buffers.srgbOutput`, a `float` uniform (0 by default), also exposed as
`splat.srgbOutput`. At the end of the vertex stage's colour work (after edits 14, 19, 13 and 16:
decode, tint, light, shadow, all in linear light) the colour is encoded back to sRGB.
`gameable/core`'s `attachSrgbPass` sets the uniform to 1 while it draws the sRGB splats into
their own target, where they blend on sRGB values as they were trained, and back to 0 after. At 0
every gaussian is moved off screen: an sRGB cloud draws only in its pass, never blended in
linear light, and `onBeforeRender` warns once when something draws it without one. Six blocks:
the import, the buffers, the property, the warning, the colour, the clip.

## The edits that were planned and are NOT here

### EDIT 10 — one compute pass per sort: **lives in `src/sortPatch.ts`, not the fork**

`CountingSort#compute` (`CountingSort.js:195-201`) calls `renderer.compute` four times, and
`WebGPUBackend.beginCompute`/`finishCompute` build one command encoder and one compute pass per
call and `submit` once per `finishCompute` — four encoders and four submissions per splat per
sort. `Renderer.compute` accepts an array (`Renderer.js:2916`) and runs every node in one pass.
The static arena splat is three's own `GaussianSplat`, not this fork, so a fork edit would only
have fixed half the scene: `initCountingSortPatch()` patches `CountingSort.prototype.compute`
once, for both classes, and falls back to the original when a pass node is missing.

### EDIT 2 — storage-buffer usage flags: **not needed**

The plan asked for `STORAGE | COPY_DST | COPY_SRC`. `WebGPUBackend.createStorageAttribute`
already allocates `STORAGE | VERTEX | COPY_SRC | COPY_DST` for every `StorageBufferAttribute`,
which covers compute writes, the vertex-stage storage reads the splat material does, and
readback. Verified at run time: the example prints `usage 0x...` for each acquired buffer.

### EDIT 5 — ignore `needsUpdate` on dynamic attributes: **nothing to ignore**

The four storage attributes are uploaded once when the backend first materialises them, and
their `version` is never bumped again — upstream sets `needsUpdate` on the _material_, never
on these attributes. There is no periodic re-upload to suppress. The spike confirms it: a
250k dynamic splat with a forced per-frame re-sort makes **zero** extra `queue.writeBuffer`
calls per frame (the two that remain are three's own camera/uniform uploads, and they are
present in the static case too).

### EDIT 7 — `sh = null` degrades to SH0: **already upstream**

`getSphericalHarmonicsDegree` returns 0 when there are no `sphericalHarmonics*` attributes;
`createSphericalHarmonicsComputeNode` returns `null` at degree 0; `updateSphericalHarmonics`
returns `false` immediately when that node is `null`; and `createMaterialNodes` only builds
the SH vertex node when the degree is above 0. Degree 0 is a fully supported upstream path,
so dynamic mode gets it for free. Edit 1 throws `SplatUnsupportedError` if a dynamic splat is
ever asked for a higher degree, rather than silently mis-rendering.

## Upgrading three

1. Bump the pin in the root `package.json` (`overrides.three`) and `npm install`.
2. `node packages/splat/scripts/diff-upstream.mjs` — it will fail, and print the first
   differing line.
3. Re-fork: copy the new upstream file, re-apply each block above, update the version, path
   and sha256 in the table at the top.
4. Re-run the S2 dynamic bench (`examples/splat-viewer/?bench=1&mode=dynamic&n=250000`) and
   the e2e suite. The numbers in `docs/concepts/splats.md` are the regression baseline.
