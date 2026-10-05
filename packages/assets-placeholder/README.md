# gameable/placeholder

## What

A 1.0 MB bundle of CC0 placeholder content: a procedural arena splat with a
matching collision mesh and spawn table, four synthesised sound effects, an
ARKit-52 idle clip and `assets/CREDITS.md`.

Every byte is **generated** by `scripts/gen-arena.mjs`, `scripts/gen-sfx.mjs`
and `scripts/gen-face.mjs` from seeded maths and the Node standard library.
Nothing is downloaded, sampled or traced, so the licensing story is trivially
clean: there is no upstream to attribute.

| File                   | What it is                                               | Size   |
| ---------------------- | -------------------------------------------------------- | ------ |
| `arena.spz`            | 121,385 gaussians, SPZ v2, 24 x 24 m arena plus sky dome | 899 KB |
| `arena.collider.bin`   | 98 vertices, 142 triangles                               | 2.8 KB |
| `arena.spawns.json`    | 1 player, 6 enemy and 3 pickup spawn points              | 950 B  |
| `shot.wav`             | Noise burst with a pitch drop, 0.22 s                    | 9.5 KB |
| `hit.wav`              | Body thud with a transient, 0.20 s                       | 8.7 KB |
| `pickup.wav`           | Rising A-major arpeggio, 0.54 s                          | 23 KB  |
| `step.wav`             | Damped footfall, 0.13 s                                  | 5.6 KB |
| `face_idle.arkit.json` | 120 frames at 30 fps: one breath, two blinks             | 38 KB  |
| `assets.json`          | The manifest, ids `env.arena` and `sfx.*`                | 628 B  |

The arena is Y-up, in metres, with the origin at the centre of the floor: a
24 x 24 m checkered floor, four 3 m walls, six pillars, a crate, a ramp and a
dome of large faint gaussians standing in for sky.

## When to use

A template or example needs something to render before real content exists. Both
shipped scaffolds depend on it, and the engine's own tests use it as a fixture
that is guaranteed to parse.

Reach for real content the moment you have it. This pack exists so that "nothing
renders" is never the first thing a new game does.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.
The `.spz` and `.wav` files are tracked with Git LFS, so a clone needs
`git lfs install` before the bytes are real.

## Minimal example

```ts
import { parseManifest } from 'gameable/assets';
import { arenaSpawns, PLACEHOLDER_ASSETS_BASE, placeholderManifest } from 'gameable/placeholder';

const manifest = parseManifest(placeholderManifest, { baseUrl: PLACEHOLDER_ASSETS_BASE });

console.log(manifest.assets.map((a) => a.id));
// ['env.arena', 'sfx.shot', 'sfx.hit', 'sfx.pickup', 'sfx.step']
console.log(arenaSpawns.player.position, arenaSpawns.enemies.length); // [0, 0, 9] 6
```

## API

- `placeholderManifest` — a typed copy of `assets/assets.json`: `env.arena`
  (`splat`, with a `mesh` collider pointing at `arena.collider.bin`) and
  `sfx.shot`, `sfx.hit`, `sfx.pickup`, `sfx.step` (`audio`).
- `PLACEHOLDER_ASSETS_BASE` — absolute URL of the packaged `assets/` directory,
  with a trailing slash. Use it as the manifest `baseUrl`.
- `placeholderAssetUrl(file)` — the absolute URL of one packaged file, for the
  two documents that cannot be manifest entries.
- `arenaSpawns` — a typed copy of `assets/arena.spawns.json`: `bounds`, `player`,
  six `enemies` and three `pickups`, each `{ position: [x, y, z], yaw }`.
- `parseCollider(buffer, { validate? })` /
  `encodeCollider(positions, indices)` — the `arena.collider.bin` format,
  documented in `src/collider.ts`. `validate` walks the index array; it
  defaults to `import.meta.env.DEV`, and to `true` where there is no
  `import.meta.env` at all.
- `ColliderFormatError` — thrown by both when a buffer or a mesh is malformed.
- Types: `PlaceholderManifest`, `PlaceholderAssetEntry` (an `AssetEntry`),
  `PlaceholderCollider` (an `AssetCollider`), `ArenaSpawns`, `ArenaBounds`,
  `SpawnPoint`, `ColliderMesh`, `ParseColliderOptions`.

`npm run generate` rebuilds every asset; `prebuild` runs it, so a build can never
ship stale bytes. The generators are seeded, so regeneration is a no-op in
`git status`.

## Gotchas

- **CC0 only, 12 MB cap** (`AGENTS.md` rule 14). In practice: if a script cannot
  compute it, it does not go here. Anything with an attribution requirement
  belongs in the game's own asset directory or in the Asset Manager.
- **`face.idle` is not in the manifest.** `docs/schemas/assets.schema.json`
  fixes `type` to `splat | gltf | character | audio`; an ARKit weight track is
  none of them, and inventing a type would be a schema change. Load it with
  `placeholderAssetUrl('face_idle.arkit.json')`, the same way
  `gameable/aam` returns face clips outside the manifest.
  `arena.spawns.json` is out for the same reason, and is re-exported as
  `arenaSpawns`.
- **Never edit `assets/`.** Change a generator and rerun `npm run generate`;
  the committed bytes are outputs (`AGENTS.md` rule 5).
- **The entry types are `gameable/assets`' own.** `PlaceholderAssetEntry` and
  `PlaceholderCollider` are aliases of `AssetEntry` and `AssetCollider`, not
  copies of them: these entries go straight into `parseManifest`, so a second
  declaration of the same shape could only drift from the one that is
  validated. `tags` is therefore optional on the type, even though every entry
  here has one.
- **`parseCollider` skips the index-range scan in a production build.** It is
  `O(indexCount)` on the loading path and it only ever catches a corrupt file.
  Pass `{ validate: true }` to force it, `{ validate: false }` to skip it. A bad
  index is not made safe by skipping the check — Jolt reads the array itself.
- **Without Git LFS** the `.spz` and `.wav` files clone as ~130-byte pointer
  text and the tests fail with `Invalid SPZ magic` or a bad RIFF header. That is
  the symptom of a missing `git lfs install`, not of a corrupt pack.
- **The resolvers need `import.meta.url`**, so they are host-side only. Do not
  import this package into the QuickJS guest; pass ids and spawn coordinates
  across the boundary instead.
- **Enemies and the player are capsules** until `gameable/character` lands.
  The pack ships no locomotion GLBs, because nothing here can animate yet.
- **Pillars collide as boxes.** The splats draw square pillars and the collider
  agrees, but if a generator is ever changed to round them, the collision proxy
  will still be the box.
