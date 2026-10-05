# Use the sample character

## Goal

An entity that was a placeholder capsule is drawn as the `aosrig_v0` sample
character — a skinned body with a GNM head — and idles, walks and runs from the
character state your game already publishes. It works on WebGPU and on the
WebGL fallback, and nothing per frame crosses the wasm boundary for it.

## Files you will edit

- `src/assets.json`
- `src/prefabs.ts`

## Steps

1. **Declare the rig in the manifest.** `gameable/aosrig` ships one
   GLB with the skeleton, the skinning and four clips (`idle`, `walk`, `run`,
   `wave`). A `character` entry whose `rig.backend` is `skinned` says "the
   `src` is that GLB". The templates resolve `@aosrig/<file>` to the bundled
   URL the same way they resolve `@placeholder/<file>`:

   ```json
   {
     "id": "char.hero",
     "type": "character",
     "src": "@aosrig/aosrig_v0.glb",
     "tags": ["character"],
     "rig": { "backend": "skinned" }
   }
   ```

   Several prefabs can share one entry: the GLB is parsed once per URL and
   cloned per spawn.

2. **Name it on the prefab.** `character` makes `ctx.spawn` emit a
   `spawn-character` command beside the entity's body. The host stands the rig
   on the body's sole — it knows the capsule's centre is 1.15 m above the feet —
   and drops the placeholder the moment the mesh is on screen. In
   `src/prefabs.ts`:

   ```ts
   import { Player, prefab } from 'gameable';

   export const HeroPrefab = prefab({
     name: 'hero',
     body: { shape: 'capsule', dims: [0.35, 0.8], kind: 'character', mass: 75 },
     character: 'char.hero',
     components: [Player],
   });
   ```

   The rig faces `+Z`. A system that moves the entity should also write its
   facing into `Transform.qx..qw` — the third-person template turns the hero
   toward its heading, the FPS template points enemies at the player — or the
   character walks sideways.

3. **Keep publishing state.** The blend picks idle, walk or run from the planar
   speed in `character.setState(entity, name, vx, vy, vz, grounded)`; the name
   is your vocabulary and the velocity is what the animator reads. A clip that
   is not locomotion, such as `wave`, is played by name:

   ```ts
   import { character } from 'gameable';

   character.setClipWeights(entity, ['wave'], [1], 1);
   ```

   Send it once when the state changes, not every frame.

## Verify

```sh
npm run dev -w templates/third-person
```

The hero stands on the floor with its feet on the arena, not hovering and not
sunk to the knees, and turns to face the way it walks. `WASD` blends idle into
walk; hold `Shift` and the walk blends into a run without the feet skating.
Talk to the guide and its head turns toward you and stops near 45°.

A capsule where the character should be means the GLB did not load: the bridge
warns once with the URL it asked for. On a fresh clone the usual cause is a Git
LFS pointer where the 3 MB file should be — `git lfs pull` fixes it, and
`npm test -w packages/assets-aosrig` says so explicitly.

## See also

- [Characters](../concepts/characters.md) — the three character paths and what each needs
- [Animation](../concepts/animation.md) — the locomotion blend and the `extras.aos` clip contract
- [Give an NPC a face](./give-an-npc-a-face.md) — the GNM splat head, for a face that moves
- `packages/assets-aosrig/README.md` — gameable/aosrig
