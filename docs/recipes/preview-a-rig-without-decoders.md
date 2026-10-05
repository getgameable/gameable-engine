# Preview a rig without decoders

## Goal

A new rig — a freshly baked GNM head, a re-exported ORL DNA — is on screen as one small
gaussian per vertex, posed by its real compute shader on the renderer's own device, months
before anyone has trained geometry and appearance decoders for its topology. You can drive it,
watch it deform, and see immediately whether the units, the frame, the skinning and the gaze
are right.

## Files you will edit

- `src/game.ts`
- `package.json`

## Steps

1. Bake the rig into an `.aosrig` pack. The packer is numpy-only — it needs neither the `gnm`
   package nor `aosrig` — and it reads the `BakedHead` npz keys directly, so a machine with
   python and numpy is enough. Add it as a script so the pack is a build artefact and never a
   committed binary:

   ```json
   {
     "scripts": {
       "prebuild": "node scripts/bake-rig.mjs",
       "bake:rig": "python node_modules/gameable/character/tools/gnm_pack.py --head ../rig/assets/myra/myra.head.npz --rig ../rig/assets/myra/myra.aosrig --out public/generated/myra_head.aosrig --trunc-exp 64 --lean"
     }
   }
   ```

   `--trunc-exp 64` keeps the model's own reduced view — the first few coefficients of every
   region, in the proportions the model considers sufficient — and turns a 42 MB pack into
   7.8 MB. Add `--trunc-report <reference_frames.npz>` and the packer prints what the
   truncation costs in millimetres instead of leaving you to guess.

2. Point a `DebugVertexLift` at the backend's own `vertsBuffer` and let it write into the same
   `AnimatedSplat` a finished character would use. `createRigPreview` is the whole wiring:

   ```ts
   import { createAnimatedSplat } from 'gameable/splat';
   import { createRigPreview, GnmRigBackend, jointTint } from 'gameable/character';

   const splat = await createAnimatedSplat(ctx.renderer, { capacity: 32768 });
   ctx.scene.add(splat.object3D);

   const pack = new Uint8Array(await (await fetch('/generated/myra_head.aosrig')).arrayBuffer());
   const backend = new GnmRigBackend({ packFile: 'myra_head.aosrig' });

   const preview = await createRigPreview({
     renderer: ctx.renderer,
     sink: splat,
     backend,
     getBytes: (name) => (name === 'myra_head.aosrig' ? pack : undefined),
     // 2 mm spheres: small enough to read the surface, big enough to see at a metre.
     sigma: 0.002,
   });
   ```

   The preview allocates one slot per rig vertex, fits the vertices into view — the two rigs
   disagree about units and neither is anywhere near the origin — and sets the sink's bounding
   sphere. Colour it by skinning region with `tint: jointTint(backend.assets)`: a vertex
   weighted to the wrong joint is then a wrongly-coloured patch, and a bake that lost its eye
   weights has no cyan in it at all.

3. Drive it every frame. `setControls` takes the backend's own control space — `head_ext` for
   GNM, 387 floats of which the last four are gaze in radians — and `render` records the rig
   pass and the debug lift into one encoder, submits once, and asks the sink to re-sort:

   ```ts
   const headExt = new Float32Array(backend.controlNames.length);

   function frame(): void {
     headExt[0] = Math.sin(performance.now() / 600); // the first left-eye coefficient
     preview.setControls(headExt);
     preview.render();
   }
   ```

   There is no readback and no per-vertex upload: the vertices are born on the GPU and the
   only thing crossing the bus is a few hundred bytes of coefficients and skin rows.

## Verify

```sh
npm run bake:rig && npm run dev
```

A head-shaped cloud of points, with the eyeballs picked out in cyan and the neck and shoulder
bands in their joints' colours. Moving a coefficient deforms it; the gaze angles rotate the
eyeballs and nothing else.

Then measure it rather than trusting it. `examples/character-showcase` ships the two checks
worth copying:

- `?selftest=1` runs the recorded reference frames through the GPU, reads `vertsBuffer` back
  once, and compares against `gnmPose` on the CPU. On the shipped myra head that is **2.4e-7 m**
  against a 1e-5 m tolerance.
- `?bench=1` times the rig pass and the sort with timestamp queries: **0.014 ms** for the blend
  plus the lift at 17,821 vertices, **0.32 ms** for the sort.

A preview that renders nothing usually means the bounds and the vertices are in different
spaces — check that `backend.vertsAABB` describes what `vertsBuffer` actually holds, which for
GNM is the body's **bind** space and not head-local.

## See also

- [Characters](../concepts/characters.md)
- [Load a character](./load-a-character.md)
- [Use the sample character](./use-the-sample-character.md)
- [Gaussian splats](../concepts/splats.md)
- `packages/character/README.md` — gameable/character
