# Splat characters

A character is a splat avatar produced by the AvatarOS pipeline. It is not a mesh with a
texture and it is not a point cloud: it is a few hundred thousand gaussians whose centres,
covariances and colours are recomputed on the GPU every time the face or the camera moves.

## The pipeline

Five stages, once per branch, all on the GPU after the first one:

```
expression weights            setExpression / setRig
        |
        v
  [ rig backend ]             ORL (wasm) or GNM (WGSL) -> posed vertices
        |                     packages/character/src/rig/
        v
  [ vert transform ]          vertices -> the decoders' training frame
        |                     src/wgsl/vert_transform.wgsl
        v
  [ decoders ]                ONNX: rig -> trunk -> geom_uv, (code, view) -> color_uv
        |                     src/decoder/, onnxruntime-web on the shared device
        v
  [ lift, two passes ]        UV texels -> gaussians
        |                     pass 1: jacobian, triangle bounds, scale, cull
        |                     pass 2: eigen-decompose, rotate, Sigma = M*M^T, pack
        v
  SplatSink.buffers           written at this branch's slot offset
```

The "branches" are the parts the exporter split the avatar into — `head`, `eyes`, and on a
clothed bundle `top`, `bottom`, `hair` and so on. Every branch has its own decoders and its
own slot range, but they all write into **one** `AnimatedSplat`, because gaussians only sort
correctly against gaussians in the same object. A character that rendered its hair in a second
splat object would show the hair in front of or behind the whole head, never through it.

### What the lift actually computes

The geometry decoder emits a UV map whose texels are positions on the avatar's surface. Pass 1
differentiates that map to get a local frame (the jacobian), bounds each texel against the
triangle it came from, applies the scale clamps, and folds the validity test into the
`triim` value so the pass stays inside eight storage buffers. Pass 2 eigen-decomposes the
frame, builds `M = R(q) · diag(s · worldScale)`, and writes `Σ = M · Mᵀ` as its upper
triangle. Colour is `rgb → u8`; opacity is a logit, so it is written as
`u8(255 · sigmoid(x))`. A culled texel is written with **alpha 0**, which is invisible — the
slot keeps its place rather than being compacted away.

That last point is the one non-obvious design rule: **slots are fixed, never compacted.** The
sort builds an index → splat mapping and reuses it across frames; if a cull removed a gaussian
and shifted its neighbours down, every subsequent frame would draw a different avatar than the
one that was sorted. Culling changes alpha, not addresses.

## The device order is load-bearing

There is exactly one `GPUDevice` and everything borrows it. The order these calls happen in is
not a style preference:

```ts
initWebGPUPatches(); // gameable/core, before the renderer exists
await renderer.init(); // -> renderer.backend.device
const device = prepareLiftDevice(renderer);
attachOrtDevice(device); // ort.env.webgpu.device = device
// ...only now may the first ONNX session be created...
```

`onnxruntime-web` caches its device on the **first** WebGPU session create. Setting
`env.webgpu.device` after that is silently ignored, ORT builds a device of its own, and every
copy between a decoder output and a lift buffer throws `Buffer is associated with [Device]`.
`attachOrtDevice` therefore _reports_ whether it was in time (`OrtDeviceAttachment.shared`)
instead of assuming; when it was not, the pipeline falls back to `DownloadOutputs` — correct,
but it round-trips every decoder output through the CPU.

`createCharacter` does all of this for you. The exported functions exist for a host that wants
to attach the device before it loads any character.

## WebGPU only

Splat characters need compute shaders and a shared device — a skinned glTF needs neither and
draws on both renderers. On the WebGL fallback backend there is no compute, and there is no CPU path worth demoting to, so `createCharacter` rejects with
`CharacterUnsupportedError`. `EngineCaps.characters` tracks this exactly; check it before
calling, and show the user something else rather than catching the error.

`prepareLiftDevice` also asserts `maxStorageBuffersPerShaderStage >= 8`. Eight is WebGPU's
default limit, which every adapter grants, and the lift's heaviest pass binds exactly eight.

## The bundle

A bundle is a directory of files the exporter produced. `loadCharacterBundle` reads it:

```ts
const bundle = await loadCharacterBundle('/assets/characters/myra');
```

It takes a URL by default but knows nothing about URLs: pass a `resolver` and the same loader
runs against an asset registry, an in-memory map, or the Asset Manager adapter.

Two on-disk layouts are supported and produce the same object:

| Layout              | Marker                           | Branches                          |
| ------------------- | -------------------------------- | --------------------------------- |
| `multi_region`      | `scene.json`, `mode` field       | as many as `order` lists          |
| `schema_version: 1` | `export_manifest.json`, no scene | one, fused, adapted to look alike |

A `multi_region` `scene.json` names, per branch, its decoders (`geom`, `appr`, optional
`trunk`), its mesh (`mesh_bin` + `mesh_json`, or `mesh_glb`), its UV resolution and its lift
tuning. The eyes branch additionally carries its own static geometry and is `gaze_conditioned`.

### The two blocks the engine adds

The exporter's schema is left byte-for-byte alone — a shipped bundle must keep parsing. The
engine adds two optional blocks to `scene.json`:

```json
{
  "rig": {
    "backend": "gnm",
    "pack": "myra.aosrig",
    "control_names": ["..."],
    "vertex_count": 17821
  },
  "expression_space": {
    "kind": "gnm",
    "dim": 387,
    "segments": [{ "name": "left_eye", "start": 0, "count": 100 }]
  }
}
```

`rig` states **which** rig posed this face, because that is the first question asked of a
wrong-looking one and the answer must not depend on a URL flag. `expression_space` states
**what** the animation layer is supposed to send, because two spaces that happen to share a
width are otherwise indistinguishable.

Every bundle shipped so far declares neither, so both have defaults: `rig.backend: "orl"` with
the bundle's own `rig_names.json`, and an `arkit52` expression space mapped through the rig
gather. Those defaults are what the prototype actually ran.

## Four character paths

`spawn-character` names a manifest entry, and the entry's `rig.backend` decides what the
bridge builds for it:

| `rig.backend`    | What draws                                                                                     | Needs WebGPU |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| `skinned`        | The entry's own GLB: a `SkinnedMesh`, its embedded clips                                       | No           |
| `aosrig-splat`   | A character exported by the Gameable studio ([below](#characters-exported-by-gameable-studio)) | No (slower)  |
| `gnm` (+ `pack`) | The `.aosrig` head as one gaussian per vertex (the debug lift)                                 | Yes          |
| `orl` / a bundle | The full decoder path through `createCharacter`                                                | Yes          |

The **skinned** path is the one every template ships. `gameable/aosrig` carries
`aosrig_v0.glb` — the MHR body joined to a GNM head, 114 joints, top-4 skinning — and the
bridge parses it once per URL, clones the scene per spawn with `SkeletonUtils.clone`, turns
off frustum culling on the skinned meshes (their bounds are the bind pose, and a wave leaves
it), and hands the rig root to the same `createAnimator` the splat paths use. Its joint
names are the canonical body skeleton: `root`, `c_spine0..3`, `c_neck`, `c_head`, `l_` /
`r_` limbs. The bridge probes the loaded skeleton for `c_head` to choose head-aim joints and
the root bone, so the manifest declares nothing rig-specific.

Two host-side details make it stand where it should. An entity's transform is its physics
body's centre and a character's origin is between its feet, so the adapter records each
body's **ground offset** at `add-body` and passes it with `spawn-character`; a capsule of
radius 0.35 and half-height 0.8 puts the soles 1.15 m below the origin. And the rig faces
`+Z`, which is what three's `rotation.y` means, so a guest system that moves an entity also
writes its facing into `Transform.qx..qw`; the bridge reads the entity's world yaw and gives
it to the animator's head-aim clamp as `bodyYaw` rather than rotating the rig root again.

Head aim on a three skeleton has to be applied: `animator.jointOverrides` are folded into
`bodyPose` for a rig backend, not written to bones, so the skinned path premultiplies each
override onto the live bone after `animator.update`. A skinned character has no blendshapes
in v0, so `set-expression` is recorded and warns once.

## Rig backends

The rig stage is pluggable behind `RigBackend` — `init`, `setControls`, `encode(encoder)`,
`vertsBuffer`, `dispose`. Two implementations ship:

**`orl` — OpenRigLogic.** The character's own DNA, evaluated by a vendored wasm module, then
int8 blendshape deltas and linear-blend skinning on the GPU. It is the exact rig the avatar
was authored with, so it is correct by construction, and it is per-character: the pack ships
inside the bundle. Its neutral is in centimetres. A small branch (under 4096 vertices — hair,
a garment) uses the cheaper _shell_ mode instead of full skinning.

**`gnm` — a baked parametric head.** A linear expression basis plus LBS, packed offline into
one `.aosrig` file and run by `gnm_blend.wgsl`. There is no ONNX export and there will not be
one: the model _is_ a matrix multiply and an LBS, and pushing that through an inference runtime
would be slower than the shader. 17,821 vertices, metres, 383 expression coefficients plus four
gaze angles. `gnmReference.ts` is a CPU implementation of the same maths, and the GPU path is
tested against a fixture generated by the python original.

Both share `lbs_common.wgsl`, so "the skinning differs between backends" is not a bug that can
exist.

### Expression spaces

| `kind`    | `dim` | What you send                                                                       |
| --------- | ----- | ----------------------------------------------------------------------------------- |
| `arkit52` | 52    | the ARKit blendshape weights, in `ARKIT_NAMES` order                                |
| `gnm`     | 387   | `head_ext`: 383 expression coefficients + `[pitchL, yawL, pitchR, yawR]` in radians |
| `gnm68`   | 68    | the reduced ML view: 64 truncated coefficients + the same four gaze angles          |

`setExpression` takes whichever the bundle declares. `setRig` bypasses it and drives the
bundle's own control vector directly — use it when you are authoring against one specific
character, not when you are playing back animation.

Sending an ARKit vector to a GNM bundle that carries no trained `arkit_map` is **refused**,
loudly. The two spaces are unrelated; a silent reinterpretation is a face that moves wrongly
with nothing on screen to explain it.

## Rig preview / debug lift

The rig stage is ready long before a character is: a `.aosrig` pack or an ORL DNA poses
vertices on its own, while the geometry and appearance decoders are trained per character and
per topology. For GNM they do not exist yet at all — they are being retrained on GNM topology
by another team — so between those two dates the rig has nothing to render into and a rig bug
has nowhere to show itself.

`DebugVertexLift` closes that gap. It is a second consumer of `RigBackend.vertsBuffer` that
writes **one small isotropic gaussian per rig vertex** into a `SplatSink` slot range:

```ts
import { createRigPreview, GnmRigBackend, jointTint } from 'gameable/character';

const preview = await createRigPreview({
  renderer,
  sink: splat,
  backend: new GnmRigBackend({ packFile: 'myra_head.aosrig' }),
  getBytes: (name) => files.get(name),
  sigma: 0.002, // metres
});

preview.setControls(headExt);
preview.render(); // rig pass + debug lift, one encoder, one submission
```

It binds the same four sink buffers in the same order as `lift_pass2_cov.wgsl`, writes the
covariance in the same `writeCovariance` split, and addresses slots the same way
(`slot_offset + i`, fixed for life) — so a preview exercises the real buffer contract rather
than a parallel one that could agree with nothing. What it does **not** do is appearance:
every gaussian is a sphere of fixed radius and flat colour, because anything that looked like
a face would hide the thing being debugged.

Colour comes from the CPU, one packed RGBA per vertex, uploaded once:

| Tint         | Reads        | What it shows                                                     |
| ------------ | ------------ | ----------------------------------------------------------------- |
| `jointTint`  | the skinning | a vertex weighted to the wrong joint; eyes are called out in cyan |
| `uvTint`     | `uv`         | a seam in the wrong place, a flipped island, a missing `uv` blob  |
| `heightTint` | the vertices | nothing but geometry — works for a rig this package cannot parse  |
| _`'normal'`_ | the vertices | a radial pseudo-normal, for reading curvature without a palette   |

**The bounds must describe `vertsBuffer`, not the model.** GNM keeps its neutral head-local so
the expression basis and the gaze rotation stay in the frame they are defined in, but the
shader emits vertices in the body's **bind** space — `bindTransform` is folded into the skin
matrices. On the shipped head that is a metre of difference, and a bounding sphere placed by
the model's own bounds puts the sort's depth bins a metre away from the gaussians, which
renders exactly nothing.

`examples/character-showcase` is the whole path as a running app, including a `?selftest=1`
that reads `vertsBuffer` back once and compares it against `gnmPose` on the CPU over the ten
recorded reference frames.

## Per frame

`update(dt, camera)` is cheap when nothing changed. It splits the work in two:

- **geometry** — rig, vert transform, trunk and geom decode, lift. Runs when the expression,
  the pose or the gaze changed.
- **appearance** — plücker rays and the appr decode, against the geometry pass's cached
  `code`. Runs when the _camera_ moved, which is most frames.

A camera that moved less than 2 mm (plus a rotation and fov term) re-runs nothing at all,
because a pass is a full decode plus a lift. Passes are coalesced `latestOnly`: while one is in
flight, further calls collapse to the most recent state rather than queueing.

Call `sink.markGaussiansChanged()` once per frame after the compute pass — without it a moving
avatar seen from a still camera renders in a stale depth order.

## Host integration

Game logic never touches any of the above. It says `character.spawn(entity, 'char.guide')`,
`character.setExpression(entity, 'arkit52', weights)` and `character.lookAt(entity, point)` —
six commands in the WIT vocabulary — and the host decides what, if anything, they draw.

The thing that decides is the **character bridge**, `createCharacterBridge` from
`gameable/host/characters`. It is a separate entry point rather than part of the
package's index on purpose: `gameable/character`'s decoder path brings `onnxruntime-web` (an
optional peer; the package's `/aosrig` entry, all an exported character needs, never loads it)
and `gameable/splat` brings the animated splat fork, and a game with no characters must not
download either. `engineAdapter.ts` names only the `CharacterBridge` **type**, which
disappears at compile time, so importing the module is the opt-in.

The templates never import it by hand. The game declares `features: { characters: true }` in
`defineGame`, and the page resolves that against its feature table: `clientFeatures()` from
`gameable/host/features` maps `characters` to a dynamic import of the bridge,
`resolveFeatures` downloads only what the game declared, and `bindFeatures` builds the bridge
against the booted engine. Options the page owns (callbacks, a splat head's `headOffset`) go in
the `clientFeatures` overrides:

```ts
import { bindFeatures, resolveFeatures } from 'gameable/core';
import { featuresOf } from 'gameable';
import { createEngineAdapter } from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { clientFeatures } from 'gameable/host/features';

const loaded = await resolveFeatures(featuresOf(definition), clientFeatures());
// ...createEngine with the loaded features' modules, then:
const bound = await bindFeatures(loaded, engine);
const characters = bound.get('characters') as CharacterBridge | undefined;
const adapter = createEngineAdapter(engine, { modules, characters });
```

What each command becomes:

| Command               | Becomes                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `spawn-character`     | a rig backend, an `AnimatedSplat` and an `Animator`, under the entity   |
| `set-character-state` | `animator.setState` — locomotion blends from the velocity, not the name |
| `set-clip-weights`    | `CharacterState.clips`; inert until the character has a clip library    |
| `set-expression`      | the animator's face layer, mapped into the bundle's space               |
| `look-at`             | `CharacterState.lookAt` — head aim into joints, the residual into gaze  |
| `say`                 | a log line; speech and visemes are not implemented                      |
| `despawn`             | dispose the preview, the backend, the sink and the animator             |

On `spawn-character` the bridge resolves the manifest entry and picks a path from it:

- **`rig.backend === 'gnm'` or `rig.pack` is set** — the rig path. Fetch the `.aosrig`, build a
  `GnmRigBackend` and a `createRigPreview` over a per-character `AnimatedSplat`, parented under
  the entity's own `Object3D`. This is the only path that runs today, because GNM decoders do
  not exist yet, and it renders the debug point cloud described above.
- **a bundle with `scene.json` branches** — `loadCharacterBundle` plus `createCharacter`, the
  real thing. Guarded behind `decoders: true` and reached through a dynamic import, because
  deciding costs a fetch against a directory that no shipped bundle has.
- **neither** — the placeholder capsule stays, with one warning naming what to add.

Each rendered frame the adapter's `update(dt, alpha)` interpolates transforms and then, per
character: `animator.update(dt)`; the animator's expression vector is copied into the backend's
control space; `animator.gaze` is added into the four gaze channels at the tail, negating pitch
because GNM spells it positive-down and the animator positive-up; `animator.jointOverrides` go
to `setJointOverrides` in the rig's `(w, x, y, z)` order; then `preview.render()`.

Two failure modes are handled rather than thrown. On the WebGL fallback
(`engine.ctx.caps.characters === false`) the bridge warns once and every character keeps its
placeholder. A pack that 404s, a bundle that will not parse or a device that refuses the lift's
storage-buffer limit all warn with the URL and the cause, and the capsule stays — a missing
head is never a black screen or an exception.

[Give an NPC a face](../recipes/give-an-npc-a-face.md) is the whole thing as a recipe.

## Memory

`memoryReport()` returns resident bundle bytes, approximate GPU bytes and slot counts, broken
down per branch. The two numbers that dominate are the decoders (tens of MB of ONNX, halved by
the fp16 siblings when the bundle ships them) and the splat capacity itself, at 52 bytes per
gaussian, fixed at allocation.

## See also

- [Gaussian splats](./splats.md)
- [Animation](./animation.md)
- [Load a character](../recipes/load-a-character.md)
- [Preview a rig without decoders](../recipes/preview-a-rig-without-decoders.md)
- [Give an NPC a face](../recipes/give-an-npc-a-face.md)
- [Load a character from the Asset Manager](../recipes/load-a-character-from-asset-manager.md)
- `packages/character/README.md` — gameable/character

## Characters exported by Gameable Studio

The studio publishes a complete `aosrig-splat` character: its gaussians, a body skeleton with
clips, a baked GNM face, and per-splat bindings. Extract it (or point at its published folder)
under `public/characters/hero/` and add a manifest entry:

```json
{
  "id": "char.hero",
  "type": "character",
  "src": "characters/hero/character.json",
  "rig": { "backend": "aosrig-splat" }
}
```

Use the existing character spawn and animation commands. No ONNX decoders are involved. Each
frame two TSL compute passes run: the head pass (the face's 383 coefficients and four gaze
values move the head's vertices) and the deformation (body skinning and the face's triangles
move each gaussian's centre and covariance together). The same passes run on WebGPU and, as
transform feedback, on WebGL2 (slower, sorted on the CPU): the engine's bridge draws an exported
character on either, and so does `gameable/three`. Expression values are offsets
from the fitted face's reference expression. ARKit controls play the package's own fitted table
(`face.arkit` in `character.json`, the file `arkit_to_gnm.bin`) when it carries one, which most
do not, and a hand-made stopgap mapping otherwise. The gaussians draw with the Gameable studio's splat kernel
(`kernel: 'studio'`), so their shape matches the studio's.

The loader verifies the content hashes and binding counts before constructing
the character. Files must remain together after extraction. The original PLY
retains its source coordinates; `character.json` records its ground transform.

Two versions of the package load:

- **Version 2**, what the studio publishes now: `skeleton.json` and `clips.json` (the body
  skeleton and the character's own clips), `body.glb` (its body mesh, for shadows),
  `head.aosrig`, the gaussians and bindings, usually packed
  (`character.psp`, `bindings.pbn`, unpacked on load). `character.json` may name a shared clip
  pack (`sharedClips`, fetched once per page for every character that names it; the loader's
  `sharedClips: false` skips it) and list every file with its size (`package.files`), so only
  the optional files that are there are asked for. A looping clip closes on its first frame at
  `frames / fps`, so its wrap skips no frame.
- **Version 1**: `character.ply`, `bindings.bin`, `head.aosrig` and `rig.glb` (the `aosrig_v0`
  body and its clips), and optionally the pose corrections below.

The PLY's colours are sRGB, drawn in the sRGB pass (see Gaussian splats, Colour space), so the
character looks as it does in the studio. A `character.json` may
declare `"colorSpace": "linear"` for a cloud whose colours are already linear
light; absent or `"srgb"` means sRGB.

### The inside of the mouth (optional)

A package may carry the teeth's own points beside its files: `teeth.json`
names `teeth.ply` (a small splat of the teeth, gums, tongue and mouth bag, in the
character frame) and `teeth.bin` (`AOSTTH01`: per point a head triangle, where on
it and how far off it, plus the studio's set-back), and its `head.aosrig` then
carries the mouth's meshes (a `mouth` header entry). The engine draws the inside
when the lips part: the mouth meshes lit from the camera and the teeth's points as
a second splat, both moved by the same 383 coefficients as the face (the lower
teeth with the jaw), seen through the opening between the lips. The opening
follows the lips' own points (the face's bound points at each lip's edge, moved by
the expression), so it never opens wider than the splat lips do; it starts to show
once they are 2 mm apart and shows fully from 3.5 mm, and its rim is a soft mask about 10 px
wide at a 1024 view, so there is no line where the inside meets the lips; the
lips' own points stay in front of the teeth. No renderer option is needed; without
`teeth.json` the character draws as before. `characters.entryOf(id).mouth` reports
it; `enabled = false` turns it off.

A package may also carry `mouth_hidden.bin` (`AOSMHD01`: u32 count, the head's up and
forward as 3 f32 each, then per splat its row in `character.ply`, its kind, its upper
and its lower lip vertex, u32 each): the closed mouth's inside points. Each frame the
lips' gap at such a splat is how far its two lip vertices have parted past rest, along
up, and `ramp = smoothstep(0.5 mm, 2 mm, gap)`. A plug (kind 1) fades by the ramp, sits
half way between its two lip vertices and is pushed back along forward by
`3 mm · smoothstep(0, 2 mm, gap) + min(gap, 3 cm) / 4`; an inside point (kind 2) only fades; a splat
of the lips' band (kind 3) is never faded but its three sizes are capped at 2.5 mm by the
ramp. `characters.entryOf(id).hiddenPoints` reports the counts; `enabled = false` draws
them as any other splat.

### Pose corrections (optional)

A version 1 package may carry `corrective/`: the studio's fix for a pose the skin tears at
(both arms raised, say), blended in as the pose approaches. Version 2 packages carry none (the
corrections were made on the version 1 body), and the loader does not look for them. `character.json` may name the index
(`"corrective": { "index": "corrective/index.json", "sha256": "…" }`); a folder beside it
without that entry is found too. `corrective/index.json` (`format`
`aosrig-splat-corrective`, `version` 1) lists `corrections`, each with a `name`, its
`splatCount` (the package's), its new `points`, two `drives` and five `files` (paths
relative to `corrective/`, `sha256` when given). A drive is one side: `side` (0 left,
1 right), `bone` (the upper arm's joint and the joint after it), `frame` (the joint whose
rest orientation the arm is read in), `restDeg`, `fromDeg`, `toDeg`, `curve: "smoothstep"`.

| File                  | Layout                                 | Use                                                             |
| --------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `fade.bin`            | float16 × splatCount                   | opacity factor at full blend: `alpha *= 1 − w[side]·(1 − fade)` |
| `side.bin`            | u8 × splatCount                        | which side's weight the splat takes                             |
| `points.ply`          | `character.ply`'s properties and frame | new splats; opacity × `w[side]`                                 |
| `points_bindings.bin` | `bindings.bin`'s layout                | their skin, none face-bound                                     |
| `points_side.bin`     | u8 × new splats                        | which weight each new splat takes                               |

Per frame and drive, the arm's direction is turned into the frame joint's rest
orientation (a lean of the torso does not count) and `θ = degrees(acos(−d′.y))` is its
elevation from hanging; `t = clamp((θ − fromDeg)/(toDeg − fromDeg))`, `w = t²(3 − 2t)`.
Up to two corrections play (four weight slots). With every weight 0 the frame is the one
a package without the folder draws. `characters.entryOf(id).corrective` reports the
angles and weights; `enabled = false` turns them off.

For a working host example, run the character showcase with
`?character=/generated/exported/character.json` after extracting the archive into
its `public/generated/exported/` directory. The example includes body clip and
facial expression controls.
