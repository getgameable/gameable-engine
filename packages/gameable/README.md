# gameable

**Gameable Engine**: a browser game engine where the world is a gaussian
splat, the renderer is WebGPU, and all game logic is a WebAssembly component.

[Documentation](https://engine.gameable.com) ·
[Play the examples](https://engine.gameable.com/play) ·
[Source](https://github.com/getgameable/gameable-engine)

## What

The whole engine in one package. Game code imports only `gameable` (the SDK:
`defineGame`, the ECS, the input, physics and HUD facades). The page that hosts
the game imports the rest: `gameable/core`, `gameable/host`, `gameable/splat`,
`gameable/character`, `gameable/physics`, `gameable/input`, `gameable/audio`,
`gameable/assets`, `gameable/net`, `gameable/rooms`, `gameable/conversation`,
`gameable/vite`, `gameable/test`, `gameable/three` and more. The `gameable`
command (`npx gameable dev | build | serve | doctor | docs`) comes with it.

## When to use

- Starting a game: use `npm create gameable`, which installs this package and
  wires up a template.
- Putting a character made in the [Gameable studio](https://app.gameable.com)
  into your own three.js app: install this package and use `gameable/three`.

## Install

```sh
npm create gameable my-game -- --template fps
```

or, into an existing project:

```sh
npm install gameable three@0.186
```

## Minimal example

`src/game.ts` in a new game:

```ts
import { defineGame, input, physics, hud } from 'gameable';

export default defineGame({
  assets: './assets.json',
  world: 'arena',
  player: { spawn: [0, 1.7, 0], speed: 5, jump: 4.5 },
  systems: [
    (ctx) => {
      if (input.pressed('fire')) {
        const hit = physics.raycast(ctx.camera.origin, ctx.camera.forward, 100);
        if (hit) ctx.damage(hit.entity, 25);
      }
      hud.set({ ammo: ctx.player.ammo, health: ctx.player.health });
    },
  ],
});
```

## API

The [API reference](https://engine.gameable.com/api/) lists every export of
every subpath. `entries.mjs` in this package is the table of subpaths.

## Gotchas

- `three` is a peer dependency (`>=0.186.0 <0.187.0`). Import it from
  `three/webgpu`, never bare `three`.
- Tooling some tasks need is an optional peer: `@bytecodealliance/jco` and
  `componentize-qjs` build the WebAssembly guest (the templates install them);
  `pg`, `express`, `ws` and the Colyseus server packages run rooms.
- Node.js 24 and a browser with WebGPU are required.
- Licence: MIT. The sample rig (`gameable/aosrig`, `assets/aosrig_v0.glb`) is
  Apache-2.0, derived from Meta's MHR and Google's GNM; `THIRD_PARTY_NOTICES.md`
  lists every third-party work.
