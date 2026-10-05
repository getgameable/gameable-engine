# Create an engine around a canvas

## Goal

A page that boots `gameable/core`, renders a scene at 60 Hz on WebGPU (or the
WebGL fallback), resizes with its canvas, and shows the F3 debug overlay in
development.

## Files you will edit

- `src/main.ts`
- `assets.json`

## Steps

1. Declare your content. Every asset the game can reference lives here, and game
   code refers to it by `id` only.

   ```json
   {
     "version": 1,
     "baseUrl": "/assets/",
     "assets": [{ "id": "arena", "type": "gltf", "src": "arena.glb", "tags": ["world"] }]
   }
   ```

2. Boot the engine in `src/main.ts`. `createEngine` is async because the
   renderer has to acquire a `GPUDevice` before anything else can use it.

   ```ts
   import { createEngine } from 'gameable/core';

   const canvas = document.querySelector('canvas');
   if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no <canvas> on the page');

   const engine = await createEngine({
     canvas,
     manifest: '/assets/assets.json',
     modules: [],
     fixedHz: 60,
     renderer: { backend: 'auto', antialias: true, pixelRatioCap: 2 },
     debug: true,
   });

   console.log(engine.ctx.caps.webgpu ? 'webgpu' : 'webgl fallback');
   ```

3. Put something in the scene and load the world. `engine.graph` maps numeric
   entity ids onto three objects; `engine.assets` resolves ids to bytes.

   ```ts
   import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
   import { DirectionalLight } from 'three/webgpu';

   engine.scene.add(new DirectionalLight(0xffffff, 2));
   engine.camera.position.set(0, 1.7, 4);

   const arena = (await engine.assets.load('arena')) as GLTF;
   engine.graph.spawn(1, arena.scene);
   ```

4. Start the loop, and stop it again when the page goes away.

   ```ts
   engine.start();
   window.addEventListener('pagehide', () => {
     void engine.dispose();
   });
   ```

## Verify

```sh
npm run dev
```

The canvas fills its container and redraws as you resize the window. Press
**F3**: an overlay appears in the top-left showing the backend name, a frame
rate, `p50`/`p95` frame times and the draw-call count. `engine.running` is
`true`, and the console line printed in step 2 says which backend you got.

## See also

- [The engine loop](../concepts/engine-loop.md)
- [Engine modules](../concepts/modules.md)
- [Assets and the manifest](../concepts/assets.md)
- `packages/core/README.md` — gameable/core
