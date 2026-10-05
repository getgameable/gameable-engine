---
title: Gameable Engine
---

# Gameable Engine

Gameable Engine is a browser game engine where the world
is a gaussian splat, the renderer is WebGPU, and **all game logic is a
WebAssembly component**.

## The 60-second quickstart

```sh
npm create gameable my-game -- --template fps
cd my-game
npm run dev
```

That gives you a splat arena you can walk around, three capsule enemies you can
shoot, an ammo and health HUD, and a win condition — with zero edits and no Git
LFS. [Install](./start/01-install.md) has the requirements and the options.

Then open `src/game.ts`. It is one `defineGame` call:

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

Edit it, save, and the guest hot-reloads through a snapshot/restore cycle. That
is the whole loop.

## Where to go next

| You want to                        | Read                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| Play the examples in your browser  | [Play](./play.md)                                     |
| Install the toolchain              | [Install](./start/01-install.md)                      |
| Build a first-person game          | [Build your first FPS](./start/02-first-fps.md)       |
| Put a studio character in three.js | [In your three.js app](./three/gameable-character.md) |
| See the whole architecture at once | [Concepts](./concepts/index.md)                       |
| Understand how a frame works       | [The engine loop](./concepts/engine-loop.md)          |
| Understand the wasm split          | [The wasm boundary](./concepts/wasm-boundary.md)      |
| Do one specific thing              | [Recipes](./recipes/index.md)                         |
| Look up a function                 | [API reference](./api/index.md)                       |
| Fix an error message               | [Troubleshooting](./troubleshooting.md)               |
| Decode the jargon                  | [Glossary](./glossary.md)                             |

## If you are a language model

Read [llms-fps.txt](/llms-fps.txt) or [llms-third-person.txt](/llms-third-person.txt)
before writing any game code. They are task-scoped bundles built for exactly this.
The core corpus is [llms-full.txt](/llms-full.txt) (rooms and splat characters have bundles
of their own, which it points to); the index is [llms.txt](/llms.txt).
These files also live at the repository root. The hard rules are in `AGENTS.md`.
