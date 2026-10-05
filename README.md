# Gameable Engine

**A browser game engine where the world is a gaussian splat, the renderer is
WebGPU, and all game logic is a WebAssembly component.**

[Documentation](https://engine.gameable.com) ·
[Play the examples](https://engine.gameable.com/play) ·
[npm](https://www.npmjs.com/package/gameable) ·
[MIT licence](./LICENSE)

- **Splat worlds.** Environments are gaussian splats, rendered through
  three.js r186's `GaussianSplat` on `WebGPURenderer`, with a WebGL fallback for
  static splats.
- **Game logic in WebAssembly.** You write TypeScript; it compiles to a QuickJS
  WebAssembly component. Any language that implements the WIT world works — a
  Rust guest is included.
- **Batteries in the host.** Jolt physics, input, audio, assets, animated splat
  characters and authoritative multiplayer rooms are provided by the engine;
  the game only describes what happens.
- **Starts playable.** Every template runs with zero edits and no Git LFS.

## Quickstart

```sh
npm create gameable my-game -- --template fps
cd my-game
npm run dev
```

Open `http://localhost:5173`: a splat arena you can walk around, enemies you
can shoot, a HUD and a win condition. Then open `src/game.ts`. It is one
`defineGame` call:

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

Edit it, save, and the game hot-reloads. That is the whole loop.

## Templates

`npm create gameable <dir> -- --template <name>`:

| Template       | What you get                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `fps`          | First-person shooter: splat arena, animated enemies, hitscan weapon, pickups, HUD              |
| `third-person` | Third-person adventure: follow camera, locomotion states, interactables, dialogue              |
| `brawl`        | Two to four players, a punch, a dash and a ground slam; first to three knockouts               |
| `collect`      | Collect pets with friends: coins, eggs that hatch into pets that follow you, trading           |
| `hangout`      | Up to twelve players on a street of houses: chat, colours, seats and cars                      |
| `mystery`      | Three to six players, a secret "it", tag-outs, votes and chat                                  |
| `steal`        | Grab collectibles off a conveyor and steal them from each other's bases; progress persists     |
| `survive`      | Gather wood by day, build walls, hold the camp against creatures at night                      |
| `visit`        | A character's own page: where it lives and how people visit, with voice and typed conversation |

The multiplayer templates run in rooms on an authoritative server
(`gameable serve`); see [Make a multiplayer game](https://engine.gameable.com/start/05-make-a-multiplayer-game).

## A Gameable character in your three.js app

Characters made in the [Gameable studio](https://app.gameable.com) drop into an
ordinary three.js scene, without the rest of the engine:

```sh
npm install gameable three@0.186
```

```ts
import { loadGameableCharacter } from 'gameable/three';
```

[The guide](https://engine.gameable.com/three/gameable-character) covers the
whole API: placement, body clips, and a face driven by ARKit blendshapes.

## Talking characters

Characters can hold a spoken or typed conversation through Gameable's hosted
conversation and transcription services. Set `GAMEABLE_API_KEY` — the API key
from your [Gameable account](https://app.gameable.com) — on the relay that
ships with the engine; the key never reaches the browser. See
[Hello world](https://engine.gameable.com/start/01-hello-world).

## One package

Everything is in `gameable`. Game code imports only the root; the page that
hosts a game imports the rest.

| Import                                                       | What it is                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `gameable`                                                   | The SDK: `defineGame`, the ECS, input, physics and HUD facades |
| `gameable/core`                                              | The host: fixed-step loop, modules, scene, cameras             |
| `gameable/host`                                              | Loads the WebAssembly guest and binds it to the host           |
| `gameable/splat`, `gameable/character`                       | Splat worlds and animated splat characters                     |
| `gameable/physics`, `gameable/input`, `gameable/audio`       | Jolt physics, input, WebAudio                                  |
| `gameable/assets`, `gameable/placeholder`, `gameable/aosrig` | Asset manifests, CC0 placeholder content, the sample rig       |
| `gameable/net`, `gameable/rooms`                             | Multiplayer: the client and the room server                    |
| `gameable/conversation`, `gameable/voice`                    | Talking characters                                             |
| `gameable/three`                                             | A studio character in your own three.js app                    |
| `gameable/vite`                                              | The Vite plugin                                                |
| `gameable/test`                                              | Mock host, record/replay, determinism helpers                  |

The `gameable` command (`npx gameable dev | build | serve | doctor | docs`)
comes with it.

## Requirements

- **Node.js 24** or later, npm 11 or later.
- **A browser with WebGPU** for development and play: current Chrome or Edge,
  Safari 26 and later. Splat worlds fall back to WebGL elsewhere.

## Performance

Measured in headless Chromium with WebGPU, 1280×720, with the camera turning
2° a frame so every frame re-sorts.

| Measurement                                       | Value                     |
| ------------------------------------------------- | ------------------------- |
| Guest tick, QuickJS, steady state p50             | **0.19 ms** (p99 0.30 ms) |
| Guest tick, Rust guest, p50                       | 0.07 ms                   |
| Splat sort, 100 k / 500 k / 1 M gaussians         | 0.31 / 0.37 / 0.42 ms     |
| Splat draw, 500 k dynamic gaussians               | 0.42 ms                   |
| CPU→GPU traffic per animated character, per frame | **0 bytes**               |

Regenerate with `examples/splat-viewer/?bench=1`.

## Documentation

- **[engine.gameable.com](https://engine.gameable.com)**:
  [Install](https://engine.gameable.com/start/01-install),
  [your first FPS](https://engine.gameable.com/start/02-first-fps),
  [concepts](https://engine.gameable.com/concepts/),
  [recipes](https://engine.gameable.com/recipes/),
  [API reference](https://engine.gameable.com/api/) and
  [troubleshooting](https://engine.gameable.com/troubleshooting).
- **For language models**: [`llms.txt`](./llms.txt) is the index;
  `llms-fps.txt`, `llms-third-person.txt` and the other task bundles are what
  to read before writing game code. [`AGENTS.md`](./AGENTS.md) has the rules.

## Working on the engine

```sh
npm install      # the only build step
npm run check    # lint, typecheck, tests, docs lint
```

Every workspace resolves its siblings to TypeScript sources through the
`gameable-source` export condition, so there is no watch build. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

The engine is [MIT](./LICENSE). The sample rig in `gameable/aosrig` is derived
from Meta's MHR and Google's GNM and is Apache-2.0; the placeholder content is
CC0. [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) lists everything.
