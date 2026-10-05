# Gameable Engine third-person template

A playable third-person adventure, out of the box: a gaussian-splat arena, a
hero on a spring-arm camera that the walls push in, an idle/walk/run/jump/fall
state machine, two people to talk to, two chests, a key, and a locked door that
ends the round when it grinds open.

```sh
npm install
npm run dev          # http://localhost:5181 — click to play
```

WASD to move, shift to run, space to jump, mouse to orbit, `E` to interact,
`1` / `2` to answer a question.

Find the key, open the door, escape.

## What is here

```
index.html            the page
vite.config.ts        one plugin: gameable()
src/
  main.ts             the host: engine boot, lights, arena collider, sandbox
  hostAssets.ts       packaged asset URLs, the manifest, the arena collider
  sandbox.ts          direct or wasm guest
  session.ts          multiplayer on or off, page modules, features, catalog name
  online.ts           the multiplayer boot (only with features.multiplayer)
  solo.ts             Play Solo's in-page authority (multiplayer, no ?room=)
  testHooks.ts        window.__AOS_TEST__ for the end-to-end suite
  physicsOptions.ts   gravity, shared by the page and a room server
  game.ts             THE FILE YOU EDIT — what exists, where, and every number
  prefabs.ts          what things are made of, and the tags that say what they are
  arena.ts            where things spawn
  dialogue.json       what people say
  hud.ts              what the HUD shows
  assets.json         asset ids to files. Ids are the contract.
  systems/
    locomotion.ts     idle/walk/run/jump/fall, and the orbit camera
    interact.ts       the E prompt, chests, the key, the door
    dialogue.ts       walking a conversation, expressions, gaze
    actors.ts         who acts: the hero alone, or each room player
    seats.ts          per-player state (pocket, conversation, HUD)
tests/game.test.ts    the whole game, driven headlessly
scripts/build-guest.mjs  TypeScript -> WebAssembly component
```

`game.ts` and what it imports are compiled into the wasm guest. `main.ts` and
the host files beside it stay in the browser. Multiplayer is off; to play in
rooms with friends, see `docs/recipes/play-with-friends.md`.

## The camera

This is the part that is genuinely different from the FPS template. The guest
does not own a camera: it states an intent —

```ts
ctx.camera.follow(hero, { yaw, pitch, distance: 4.5, height: 1.5 });
```

— and the host builds a spring arm from it, probes from the orbit pivot towards
where the camera wants to sit, and pulls the boom in when a wall is in the way.
`src/systems/locomotion.ts` owns the orbit and clamps the pitch to a range that
suits a boom rather than an eyeball; the collision is not yours to write.

Forward, for the hero, is away from the camera. That is why one system owns both
the walk direction and the orbit.

Run as a room's authority, the same system walks every player: each one's own
entity (the one they possess), from their own keys, with their own camera
(`updatePlayers` on the controller). Alone, it walks `ctx.player` exactly as
before.

## The two sandbox modes

`npm run dev` runs your TypeScript directly, through the same SDK runtime the
component uses. `npm run build` compiles that same TypeScript into a QuickJS
WebAssembly component and ships that — `src/dialogue.json` included; a JSON
import is bundled into the guest. The host code is identical either way, and
`import.meta.env.GAMEABLE_MODE` is the only thing that differs. If the two ever
behave differently, that is an engine bug.

With `features.multiplayer` on, `npm run dev` needs one build after all: Play
Solo's authority runs the game built to wasm, in every mode. Run
`npm run build:guest` before `npm run dev` (or `npm run build:direct`) and
after each change to the game's rules; under `npm run dev` the page warns when
`build/guest/` is older than `src/`.

```sh
npm run build        # guest component + production bundle
npm run preview      # serve it
npm run build:direct # production bundle, direct sandbox — useful when debugging
```

## Change something

Every number worth changing is in the `rules` block of `src/game.ts`:

```ts
rules: {
  walkSpeed: 1.6,
  runSpeed: 4.0,
  cameraDistance: 4.5,
  cameraHeight: 1.5,
  interactRange: 2,
  doorTravel: 2.4,
  winMessage: 'You escaped',
},
```

Beyond that, in rough order of effort:

- **A third chest, elsewhere** — add a point to `src/arena.ts` and an entry to
  the `spawns` list in `game.ts`.
- **Something new to say** — an entry in `src/dialogue.json` and a tag on a
  prefab.
- **A new kind of interactable** — a tag and a prefab in `src/prefabs.ts`, and
  one branch in `src/systems/interact.ts`.
- **Your own character instead of the sample one** — drop a skinned GLB in
  `public/`, point the `char.hero` entry in `src/assets.json` at it, and keep
  `rig: { backend: 'skinned' }`. The host reads the clips out of the file.
- **A real model for a prop** — drop the file in `public/`, add an entry to
  `src/assets.json`, and give the prefab `asset: 'your.id'`. The host draws the
  placeholder until the model loads, then swaps it.
- **Your own arena** — replace the `env.arena` entry in `src/assets.json` and
  the spawn table in `src/arena.ts`.

## People and placeholders

The hero and both NPCs are real characters. `character: 'char.hero'` and
`character: 'char.guide'` in `src/prefabs.ts` name entries in `src/assets.json`
that point at `gameable/aosrig` — one 3.1 MB skinned GLB, 114 joints,
with `idle`, `walk`, `run` and `wave` baked into it. The host loads it once,
clones it per entity, hides the placeholder capsule and blends the clips from
whatever `character.setState` last said. It needs no WebGPU and no decoder, so
it draws on the WebGL fallback too.

The props have no model. The host draws a box the size of each entity's physics
body — the chests, the door, the key — so the game is playable before any art
exists, and `tint()` in `src/prefabs.ts` colours them. `tint()` works on a
character too: it clones the rig's materials and sets their colour.

`walkSpeed` and `runSpeed` in `src/game.ts` are 1.6 and 4.0 because the clips
were baked at 1.4 and 3.6 m/s. Raise them a long way and the feet skate.

## Give the guide a face

`?gnm=1` swaps the guide NPC's skinned head for a real GNM splat head: the rig
runs on the GPU every frame, the dialogue system's expressions move the face and
`look-at` turns the head towards the hero.

The head is a baked `.aosrig` pack. It is licensed source data and 7.8 MB, so it
is **not in this repository** and `public/generated/` is gitignored. Bake one and
copy it in:

```sh
# from the engine repository root
npm run gen:pack -w examples/character-showcase
mkdir -p templates/third-person/public/generated
cp examples/character-showcase/public/generated/myra_head.e64.aosrig    templates/third-person/public/generated/
```

Then open the game with `?gnm=1`:

```sh
npm run dev
# http://localhost:5181/?gnm=1
```

Without the pack, `?gnm=1` is harmless: the bridge warns in the console with the
URL it asked for and the guide stays the skinned character it was.

What `?gnm=1` actually does is one line in `src/main.ts` — it rewrites the
`char.guide` manifest entry's `rig` block to `{ backend: 'gnm', pack: ... }`.
The character bridge itself is built on every run, because the skinned
characters need it; the GNM half of it is dynamically imported and only fetched
when a `gnm` rig actually spawns, which is why the default build does not carry
that 646 KB chunk or its ~29 MB of never-fetched wasm.

What you see is a head and nothing else: GNM bakes a head and a neck, so the
skinned body goes and no body replaces it. And it is the **debug**
renderer — one small gaussian per rig vertex, coloured by skinning joint —
because the geometry and appearance decoders for GNM topology do not exist yet.
A point cloud is the honest picture of what the rig is doing.

## Tests

```sh
npm test
```

`tests/game.test.ts` runs the real systems against a mock host: no browser, no
renderer, no physics engine. It walks the hero at both speeds, jumps it, checks
that the camera rides a boom behind it, opens a chest, refuses the door without
the key and opens it with one, takes both branches of the guide's question,
asserts that the character commands go out, and checks that the same seed
produces the same frames twice. That is the loop to work in; the browser is for
looking at it.

The end-to-end suite that drives the real thing lives in the engine repository
at `tests/e2e/third-person.spec.ts`.
