# Third-party notices

Gameable Engine's own code is MIT licensed ([LICENSE](./LICENSE)). These are
the third-party works it includes or ships with, and their terms.

## Included in this repository and in the `gameable` package

| Work                                                                   | Where                                                                | Licence    | Notes                                                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| [three.js](https://github.com/mrdoob/three.js) `GaussianSplat`         | `packages/splat/src/three-fork/`                                     | MIT        | A modified copy (`AnimatedGaussianSplat.js`); the original notice is in `LICENSE-three.md` beside it. |
| [OpenRigLogic](https://github.com/EpicGames/OpenRigLogic) (Epic Games) | `packages/character/src/rig/orl/vendor/riglogic.wasm`, `riglogic.js` | MIT        | Built to WebAssembly from the upstream release, unmodified.                                           |
| [MHR](https://github.com/facebookresearch/MHR) (Meta)                  | in `packages/assets-aosrig/assets/aosrig_v0.glb`                     | Apache-2.0 | Body geometry, skeleton and skin weights. See that directory's `NOTICE.md` for the changes.           |
| [GNM](https://github.com/google/GNM) V3 (Google)                       | in `packages/assets-aosrig/assets/aosrig_v0.glb`                     | Apache-2.0 | Head geometry and joints. Same `NOTICE.md`.                                                           |

The Apache-2.0 text travels with the rig as
`packages/assets-aosrig/assets/LICENSE-APACHE-2.0.txt` (in the published
package, `assets/LICENSE-APACHE-2.0.txt`).

The placeholder content in `packages/assets-placeholder/assets/` is generated
by scripts in this repository and released under CC0 1.0
(`CREDITS.md` there).

## Bundled into a game

| Work                                              | Licence | Notes                                                                                                                              |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [bitECS](https://github.com/NateTheGreatt/bitECS) | MPL-2.0 | The ECS. It is compiled into every game's WebAssembly guest; MPL-2.0 is file-level, so it places no terms on your game's own code. |

## Installed beside `gameable`

Dependencies and peers are installed by npm with their own licences:
[jolt-physics](https://github.com/jrouwe/JoltPhysics.js) (MIT),
[onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT),
[three](https://github.com/mrdoob/three.js) (MIT),
[Colyseus](https://github.com/colyseus/colyseus) (MIT),
[Vite](https://github.com/vitejs/vite) (MIT),
[jco](https://github.com/bytecodealliance/jco) (Apache-2.0 WITH LLVM-exception),
[componentize-qjs](https://github.com/bytecodealliance/componentize-qjs) (Apache-2.0),
[Binaryen](https://github.com/WebAssembly/binaryen) (Apache-2.0),
[express](https://github.com/expressjs/express), [pg](https://github.com/brianc/node-postgres)
and [ws](https://github.com/websockets/ws) (MIT).

## Names only

Some modules map between rig vocabularies: Apple's ARKit blendshape names,
Mixamo bone names (`packages/animation/assets/mixamo_to_mh.json`) and Epic's
MetaHuman joint names. They contain the names, not any of those products'
assets.
