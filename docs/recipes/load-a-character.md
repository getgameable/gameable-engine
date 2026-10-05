# Load a character

## Goal

An AvatarOS splat avatar stands in your scene, loaded by id from the manifest, with a face you
can drive from game code. On a machine without WebGPU the game still boots and says why the
character is missing, instead of throwing.

## Files you will edit

- `assets.json`
- `src/game.ts`

## Steps

1. Declare the character in `assets.json`. `src` is the bundle **directory** — a character is
   a set of files (decoders, meshes, a rig pack) that are only meaningful together, so the id
   addresses the whole directory and no filename inside it ever appears in game code.

   ```json
   {
     "version": 1,
     "baseUrl": "/assets/",
     "assets": [
       {
         "id": "char.myra",
         "type": "character",
         "src": "characters/myra/",
         "tags": ["cast"],
         "rig": { "backend": "orl" }
       }
     ]
   }
   ```

   The `rig` block is required, and it is the bundle's own answer to "which rig posed this
   face". Use `"backend": "gnm"` with a `"pack": "characters/myra/myra.aosrig"` for a baked
   parametric head; `"orl"` reads the rig out of the bundle itself.

2. In `src/game.ts`, create the splat object the character writes into, then bring the bundle
   to life against it. The character does not own a scene object of its own — it writes
   gaussians into slot ranges of **one** `AnimatedSplat`, so a second character added later
   shares the same object and the same sort.

   ```ts
   import { createAnimatedSplat } from 'gameable/splat';
   import { createCharacter, loadCharacterBundle } from 'gameable/character';

   const splat = createAnimatedSplat(ctx.renderer, { capacity: 262144 });
   ctx.scene.add(splat.object3D);

   const bundle = await loadCharacterBundle(ctx.assets.url('char.myra'));
   const myra = await createCharacter(bundle, {
     renderer: ctx.renderer,
     scene: ctx.scene,
     sink: splat,
   });
   ```

   `capacity` is the number of gaussians, fixed for the object's lifetime at 52 bytes each. A
   character needs `uv_res²` slots per branch — 65,536 for a 256² head plus 9,216 for its
   eyes, on the shipped bundles. `myra.memoryReport()` prints what it actually took.

3. Guard the WebGPU requirement. Characters are compute shaders writing into storage buffers;
   there is no WebGL path and no CPU fallback worth having, so check the capability rather
   than catching the error.

   ```ts
   if (!ctx.caps.characters) {
     ctx.log('this build needs WebGPU for characters');
     return;
   }
   ```

4. Drive it and update it. `setExpression` takes whatever the bundle declares in
   `myra.expressionSpace` — ARKit-52 weights for an `orl` bundle, `head_ext` for a `gnm` one.
   Preallocate the weights array: this runs every frame.

   ```ts
   const weights = new Float32Array(myra.expressionSpace.dim);

   function frame(dt: number): void {
     weights[jawOpen] = talking ? 0.4 : 0;
     myra.setExpression(weights);
     myra.setLookAt(playerIsNear ? playerPosition : null);
     myra.update(dt, ctx.camera);
     splat.markGaussiansChanged();
   }
   ```

   `update` is cheap when nothing moved — it re-runs the appearance pass only once the camera
   has genuinely travelled about 2 mm — so calling it every frame is the intended use.

## Verify

```sh
npm run dev
```

The avatar is there, it blinks when you push a weight into it, and it stays sharp as you orbit
— a character that goes soft or smears when the camera turns is the appearance pass not
running, usually a `markGaussiansChanged` you forgot. `F3` shows one draw call for the splat
object no matter how many branches the bundle has.

Then assert it headlessly. A bundle parses with no GPU at all, which is the part worth putting
in CI:

```ts
const bundle = await loadCharacterBundle('/assets/characters/myra/');
expect(bundle.manifest.rig.backend).toBe('orl');
expect(bundle.manifest.expressionSpace.dim).toBe(52);
```

If `createCharacter` rejects with `CharacterUnsupportedError`, the renderer is on the WebGL
fallback — step 3 is the check that should have caught it.

## See also

- [Characters](../concepts/characters.md)
- [Use the sample character](./use-the-sample-character.md) — the skinned body every template ships
- [Gaussian splats](../concepts/splats.md)
- [Play an animation on a character](./play-an-animation.md)
- [Load a character from the Asset Manager](./load-a-character-from-asset-manager.md)
