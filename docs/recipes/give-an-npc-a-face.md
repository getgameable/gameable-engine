# Give an NPC a face

## Goal

The `spawn-character` / `set-expression` / `look-at` commands a game already
emits stop being recorded no-ops and start moving a real GNM splat head: the NPC
smiles when the dialogue system says `smile`, and turns to look at whoever it is
talking to. Nothing in the guest changes — this is entirely a host decision.

## Files you will edit

- `src/main.ts`
- `src/assets.json`

## Steps

1. **Bake a rig pack and serve it.** A GNM head is a `.aosrig` pack: a neutral
   mesh, an expression basis, a skeleton and the skinning. It is licensed source
   data, so no template ships one — bake it and drop it in `public/`, which
   Vite copies verbatim:

   ```sh
   npm run gen:pack -w examples/character-showcase
   mkdir -p templates/third-person/public/generated
   cp examples/character-showcase/public/generated/myra_head.e64.aosrig \
      templates/third-person/public/generated/
   ```

   `gen-gnm-pack.mjs` writes two packs. The `e64` one keeps the model's own
   64-coefficient reduced view and is 7.8 MB against the full pack's 42 MB;
   [Preview a rig without decoders](./preview-a-rig-without-decoders.md) has
   what the truncation costs in millimetres. Add `public/generated/` to
   `.gitignore`: a 7.8 MB binary does not belong in a scaffold.

2. **Point the manifest entry at it.** A `character` entry's `rig` block says
   which backend drives the head and, for `gnm`, which file holds it. `pack` is
   resolved like any other `src` — absolute from the site root here, or relative
   to the entry's own directory. In `src/assets.json`:

   ```json
   {
     "id": "char.guide",
     "type": "character",
     "src": "characters/guide/scene.json",
     "tags": ["character"],
     "rig": { "backend": "gnm", "pack": "/generated/myra_head.e64.aosrig" }
   }
   ```

3. **Tell the character feature where the neck is.** The rig stack — the
   backend, the animator, the animated splat — is the **optional** half of
   `gameable/host`, so a game with no characters never downloads it.
   The game opts in with `features: { characters: true }` in `src/game.ts`
   (the template already declares it), and `src/main.ts` resolves the page's
   feature table against that declaration with `resolveFeatures`, then
   `bindFeatures` builds the bridge and the page hands it to
   `createEngineAdapter`. None of that changes. What a splat head needs that a
   skinned rig does not is an offset from the entity's centre to its neck, and
   that is a page decision, so it goes in the `clientFeatures` overrides. In
   `src/main.ts`, where the feature table is built:

   ```ts
   import { clientFeatures } from 'gameable/host/features';

   const FEATURES = clientFeatures({
     // An entity's transform is its physics centre; this is where its neck is.
     characters: { headOffset: [0, 0.78, 0] },
   });
   ```

   The third-person template already carries this line for its `?gnm=1` mode;
   a game built on another scaffold adds the `characters` override to the
   `clientFeatures()` call it already has.

   That is the whole wiring. The bridge resolves the bundle, fetches the pack,
   builds an `AnimatedSplat` and a `GnmRigBackend` under the entity's own
   object, keeps an `Animator` per character, and drops the placeholder capsule
   the moment the head is on screen. On the WebGL fallback it warns once and
   leaves every capsule where it was, so a player without WebGPU still gets a
   playable game rather than an exception.

## Verify

```sh
npm run dev -w templates/third-person
```

Walk up to the guide. The placeholder capsule is gone and in its place, at head
height, is a head-shaped cloud of points tinted by skinning joint. Two things
about that are deliberate: it is a **head** rig, so there is no body to draw —
GNM bakes a head and a neck, not a skeleton with limbs — and it is the **debug**
renderer, one gaussian per rig vertex, because the geometry and appearance
decoders for GNM topology do not exist yet. Press `E`: the face moves on the
lines the script marks `smile`, and the head turns towards the hero and eases
back when the conversation ends.

Nothing on screen means the pack did not load. The bridge never throws — look in
the console for `the GNM rig for "char.guide" … did not load`, which carries the
URL it asked for and the reason. A warning about `no GNM rig pack` instead means
step 2 did not take effect.

The template ships this as `?gnm=1` rather than as the default, so
`npm run dev -w templates/third-person -- --open '/?gnm=1'` is the same thing
without editing anything, and `tests/e2e/third-person.spec.ts` asserts it —
skipping itself when there is no pack on the machine.

## See also

- [Characters](../concepts/characters.md) — the pipeline, and the host integration
- [Add NPC dialogue](./add-npc-dialogue.md) — where the expressions come from
- [Preview a rig without decoders](./preview-a-rig-without-decoders.md) — the same rig, no game
- [Use the sample character](./use-the-sample-character.md) — the skinned body; this recipe is the face
- [Animation](../concepts/animation.md) — head aim, gaze and the expression layer
