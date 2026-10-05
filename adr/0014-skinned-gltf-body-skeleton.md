# ADR 0014: Skinned glTF characters, with the aosrig_v0 joint namespace as the canonical body skeleton

- **Status**: Accepted — shipped after M5
- **Date**: 2026-09-15
- **Plan decision**: extends [ADR 0007](./0007-pluggable-rig-backend.md) and
  [ADR 0012](./0012-gnm-head-via-aosrig-bakedhead.md); qualifies
  [ADR 0010](./0010-placeholder-assets-package.md)

## Context

Every shipped surface drew a capsule where a person should be. The character
stack that existed — `RigBackend` for ORL and GNM, the layered animator, the
animated splat sink — rendered a **head** as a debug point cloud, and only on
WebGPU, because the geometry and appearance decoders a splat body needs do not
exist yet and will not until they are trained.

Meanwhile the rig those decoders will be trained against does exist:
`aosrig_v0` in the `soma-x` fork joins a native MHR LOD1 body to a GNM V3 head
into one linear-blend-skinned mesh with 114 joints, 30,031 vertices and
authored UVs. Its output is a numpy dictionary — rest vertices, quads, per-corner
UVs, dense weights, joint names, parents and rest world matrices — and its
skinning is exactly glTF's: `world · inv(bind_world)`.

Two things were missing between that dictionary and a character running around
a template: a way to get it into the browser, and clips for it to play. No
locomotion clips exist anywhere in the organisation's web code (the POC generated
walks server-side per request), and the MHR pose space is a set of ~110 named
semantic scalars, not per-joint rotations, so a Mixamo retarget was not a
shortcut either.

## Decision

1. **A skinned glTF is the third character path.** `rig: { backend: 'skinned' }`
   in the manifest means the entry's own `src` is a GLB with `JOINTS_0` /
   `WEIGHTS_0` and its clips embedded as glTF animations. The bridge loads it
   with three's `GLTFLoader`, clones the parsed scene per spawn with
   `SkeletonUtils.clone`, and hands the rig root to `createAnimator` — the same
   animator the splat paths use, now driving a real `SkinnedMesh` instead of a
   synthesised bone chain. This path needs no GPU device, no compute pass and no
   WebGPU; it renders on the WebGL fallback, which is why the WebGPU gate moved
   from `spawn` into the two splat paths.

2. **The aosrig_v0 joint names are the canonical body skeleton.** `root`,
   `c_spine0..3`, `c_neck`, `c_head`, `l_`/`r_` limbs, `*_proc` twists. Splat
   characters will be trained against this rig, so the engine adopts its
   vocabulary rather than renaming to MetaHuman's. The animator's assumptions
   (`pelvis`, `head`, `neck_01/neck_02`) became options — `bones: { root, head }`
   and `headAim.joints` — and the bridge picks a profile by **probing** the loaded
   skeleton for `c_head`, not by a manifest key. The manifest validator rejects
   unknown keys, so every declared name would be a schema, an Asset Manager
   adapter and a docs change, and the GLB already carries the answer.

3. **Clips travel inside the GLB, tagged.** Each glTF animation carries
   `extras.aos = { speed, loop, locomotion }`. `GLTFLoader` copies `extras` into
   `clip.userData`, so the bridge builds its `LocomotionIndex` from the clips
   whose `locomotion` is true and registers every clip by name. There is no
   side-car `locomotion.json` to keep in step with a hashed asset URL, and the
   retarget tool's one-GLB-per-clip layout still fits: `file` is whichever GLB
   the clip came out of.

4. **The first clips are procedural, baked through the real rig.** Idle, walk,
   run and wave are authored as curves on MHR's semantic pose parameters in
   Python and evaluated through the MHR TorchScript forward kinematics, so the
   34 procedural twist joints are correct by construction. The exporter and the
   clip bake live on the `soma-x` `aosrig_v0` branch with the translator, not in
   this repository; this repository consumes the GLB.

5. **The asset is `gameable/aosrig`, committed through Git LFS.** It is
   derived from Meta's MHR and Google's GNM model data, so it is not CC0 and
   [ADR 0010](./0010-placeholder-assets-package.md)'s rule 14 keeps it out of
   the placeholder pack. It is ~3 MB, one file, and a workspace package of its
   own with a `NOTICE.md`. The package's `files` include `assets/`, so a
   published tarball carries the real bytes and a scaffolded game keeps ADR
   0010's zero-edit bar; inside this monorepo a clone without LFS gets a pointer
   file, the pack test says `git lfs pull`, and the runtime warns once and keeps
   the capsule.

6. **Ground contact is the host's job.** An entity's transform is its physics
   centre; a character's origin is between its feet. The adapter records each
   body's ground offset at `add-body` and passes it with `spawn-character`, so
   no game and no manifest carries a magic 1.15.

7. **Facing is the guest's job.** The rig faces +Z, three's `rotation.y` means
   +Z, and the animator's head-aim clamp means +Z. Templates write
   `Transform.q*` toward their heading in the same fixed step; the bridge reads
   the entity's world yaw and passes it to the animator as `bodyYaw` rather than
   rewriting the rig root's rotation (which draws, and would double-rotate).

## Consequences

- Every template and example draws a person now, on both renderers, and the
  hero, NPCs, enemies and greeter all play the same four clips from the same
  file. The capsule remains the fallback for a missing or unreadable GLB.
- `packages/animation` learned nothing rig-specific: two option names and one
  context field. The splat paths are unchanged, and `?gnm=1` still swaps the
  guide's head for the GNM point cloud.
- The bridge no longer imports `gameable/character` or `gameable/splat`
  statically; both are dynamic imports inside the GNM path. A template that
  creates the bridge unconditionally pays for an `AnimationMixer`, not for
  onnxruntime.
- Head aim on a three skeleton has to be **applied**: the animator folds its
  joint overrides into `bodyPose` for rig backends, so the skinned path
  premultiplies them onto the live bones after `update`. A test asserts the bone
  moved, because the failure is silent.
- Top-4 skinning drops at most 22 % of the influence mass on 982 of 30,031
  vertices; the exporter's parity test measures the resulting error against the
  full weights rather than hiding it. Three's loader reads only `JOINTS_0`.
- The clips are procedural, not captured: feet are ground-clamped, not pinned,
  so some sliding remains. Real clips slot in through the same `extras.aos`
  contract or the retarget tool, without an engine change.
- The third-person template's speeds dropped from 3.2 / 6 to 1.6 / 4.0 m/s. A
  capsule can sprint at 6 m/s; a 1.73 m person cannot, and the blend picks the
  clip by speed.
- The llms bundle budgets grew (300 → 340 KB full, 64 → 72 KB per template)
  because a seventeenth package README and a recipe joined the corpus.
