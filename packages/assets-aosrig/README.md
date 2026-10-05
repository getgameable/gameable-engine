# gameable/aosrig

## What

One character: `assets/aosrig_v0.glb`, a 3.1 MB skinned glTF with a 114-joint
skeleton and four embedded clips.

| Property | Value                                                           |
| -------- | --------------------------------------------------------------- |
| Geometry | Two primitives, `body` and `head`, sharing one vertex buffer    |
| Skeleton | 114 joints, Y-up, **+Z forward**, feet at `y = 0`, 1.73 m tall  |
| Skinning | Linear blend, four influences per vertex, renormalised          |
| Clips    | `idle` (0 m/s), `walk` (1.4), `run` (3.6), `wave` — all looping |
| Textures | None. It is lit by whatever lights your scene has               |

It is a Meta MHR LOD1 body joined to a Google GNM V3 head, exported by
the AvatarOS rig exporter. **It is Apache-2.0, not CC0** — `assets/NOTICE.md`
has the provenance — which is why it is its own
package and not part of `gameable/placeholder` (`AGENTS.md` rule 14).

This is the canonical body skeleton. Splat characters are trained against these
joint names, so a clip authored for one aosrig character plays on every other
one.

## When to use

You want a person in the scene instead of a capsule, and you want it to work on
the WebGL fallback: the `skinned` rig backend is a plain `AnimationMixer` over a
three `SkinnedMesh`, so it needs no WebGPU, no decoder and no ORT.

Both game templates use it for their hero, NPCs and enemies. Reach for
`gameable/character` and a GNM pack instead when you want a real splat face;
reach for your own GLB when you have art.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.
The GLB is tracked with Git LFS, so a clone needs `git lfs install` and
`git lfs pull` before the bytes are real.

## Minimal example

```ts
import { parseManifest } from 'gameable/assets';
import { AOSRIG_ASSETS_BASE, aosrigManifestEntry } from 'gameable/aosrig';

const manifest = parseManifest(
  { version: 1, assets: [aosrigManifestEntry('char.hero')] },
  { baseUrl: AOSRIG_ASSETS_BASE },
);

console.log(manifest.assets[0].src.endsWith('aosrig_v0.glb')); // true
console.log(manifest.assets[0].rig?.backend); // 'skinned'
```

Then name `char.hero` in a prefab's `character` field and the host draws the rig
where the placeholder capsule was.

In a bundled app, import the file with `?url` so it is emitted into `dist/`
with a hashed name, and point the manifest entry at that URL instead — that is
what both templates do.

## API

- `AOSRIG_ASSETS_BASE` — absolute URL of the packaged `assets/` directory, with
  a trailing slash. Use it as a manifest `baseUrl`.
- `AOSRIG_GLB_FILE` — `'aosrig_v0.glb'`.
- `aosrigAssetUrl(file)` — the absolute URL of one packaged file.
- `aosrigManifestEntry(id, src?)` — the manifest entry, `type: 'character'` with
  `rig: { backend: 'skinned' }` and no `pack`.
- `AOSRIG_JOINTS` — all 114 joint names, in `JOINTS_0` index order.
- `AOSRIG_ROOT_JOINT` (`'root'`), `AOSRIG_HEAD_JOINT` (`'c_head'`) and
  `AOSRIG_HEAD_AIM_JOINTS` (`c_neck` 0.4, `c_head` 0.6) — the names
  `createAnimator` has to be told, because its defaults are Unreal's.
- `AOSRIG_CLIPS` and `AOSRIG_CLIP_SPEEDS` — the four clip names, and the ground
  speed each locomotion clip was baked at.
- `AOSRIG_HEIGHT` — 1.73, the bind-pose standing height in metres.
- `AosrigManifestEntry` — the type `aosrigManifestEntry` returns: an alias of
  `gameable/assets`' `AssetEntry`, not a second declaration of it.

## Gotchas

- **Apache-2.0, not CC0.** The rig is a derivative of Meta MHR and Google GNM,
  both Apache-2.0. Keep `assets/NOTICE.md` and `assets/LICENSE-APACHE-2.0.txt`
  with the GLB whenever you redistribute it.
- **Without Git LFS** the GLB clones as a ~130-byte pointer and every character
  spawn fails on a bad magic. `src/pack.test.ts` says so in as many words.
- **The GLB is an input, not an output.** No script here generates it; it comes
  from the AvatarOS rig exporter and is copied in. `src/pack.test.ts` is the contract
  that catches an exporter change.
- **Yaw 0 faces +Z**, which is three's `rotation.y` convention and the opposite
  of the "0 looks down -Z" comment in some older spawn tables. A character that
  walks backwards is this, every time.
- **`aosrigManifestEntry` returns an `AssetEntry`**, so `rig` is optional on the
  type even though this function always sets it. Read it as `entry.rig?.backend`
  — that is what `parseManifest` hands back too.
- **The animator's default bone names are Unreal's** (`pelvis`, `neck_01`,
  `neck_02`, `head`). Pass `AOSRIG_ROOT_JOINT`, `AOSRIG_HEAD_JOINT` and
  `AOSRIG_HEAD_AIM_JOINTS` or the head aim silently does nothing.
- **`AOSRIG_JOINTS` order is load-bearing.** It is the `JOINTS_0` index space,
  not a display list; do not sort it.
- **The 34 `*_proc` joints are procedural twists** baked by MHR's own forward
  kinematics. Pose them by hand and the elbows and knees fold wrong.
- **The resolvers need `import.meta.url`**, so they are host-side only. Do not
  import this package into the QuickJS guest; pass asset ids across the
  boundary instead.
