# gameable/three

## What

A character made in the Gameable studio, in your own three.js scene: one call loads it from
its `character.json` URL onto your `WebGPURenderer`. Add `object3D` to your scene, call
`update(dt, camera)` each frame, `play('wave')`, `setExpression('arkit52', { jawOpen: 0.4 })`.
No engine, ECS or wasm. The full guide ships in this package: `GUIDE.md`
(`node_modules/gameable/three/GUIDE.md` once installed).

## When to use

A three.js app (not a game on the engine) that wants a studio-published character in it.

## Install

```sh
npm install gameable three@0.186
npm install -D @webgpu/types
```

Add `"@webgpu/types"` to `compilerOptions.types` in `tsconfig.json`, with `"moduleResolution":
"bundler"`. This is the only package: the engine code it uses is bundled in, and three is yours.
From a `.tgz`: `npm install three@0.186 ./vendor/gameable-0.0.0.tgz`.

## Minimal example

```ts
import { PerspectiveCamera, Scene, Timer, WebGPURenderer } from 'three/webgpu';
import { loadGameableCharacter } from 'gameable/three';

const renderer = new WebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new Scene();
const camera = new PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 4.2);

const character = await loadGameableCharacter(renderer, 'https://studio.example/character.json');
scene.add(character.object3D);
character.play('wave');
const timer = new Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  character.update(timer.getDelta(), camera);
  renderer.render(scene, camera);
});
```

## API

`loadGameableCharacter(renderer, url, options?)` resolves to a character with `object3D`,
`clips`, `clip`, `play(name, { fade?, loop? })`, `setExpression('arkit52', weights)` (weights
clamped to 0..1), `lookAt(target | null, { head?, eyes? })`, `setTint`, `setExposure`, `castShadow`,
`update(dt, camera)` and `dispose()`. Options: `clip`, `tint`, `exposure`, `castShadow`,
`mouth`, `onProgress`, `fetch`, `signal`, `attachPass`, `allowWebGL` (default true: draws on the WebGL2 fallback),
`allowSoftwareRenderer` (default false). `isSoftwareRenderer(renderer)` tells a GPU-less browser apart.
`attachManualPass(renderer, scene)` is for an app that drives the pass itself. Failures throw
`GameableCharacterError` with `code` `webgpu-required`, `renderer-not-ready`, `load-failed` or
`software-renderer`.
`GUIDE.md` has them all.

## Credit

Show a credit with the character: the words "I made this with Gameable", linking to
https://app.gameable.com/.

## Gotchas

WebGPU first; on a browser without it the character draws on three's WebGL2 fallback, slower
(`allowWebGL: false` makes the load throw `webgpu-required` there instead). The character blends on its sRGB colours as in the studio,
depth-tested against your scene, through a pass it hooks into `scene.onBeforeRender` on its
first `update` (assign your own hook before that). Call `await renderer.init()` first and
`update` every frame; nothing is needed before `init()`.
