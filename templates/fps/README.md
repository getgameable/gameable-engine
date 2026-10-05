# Gameable Engine FPS template

A playable first-person shooter, out of the box: a gaussian-splat arena, six
animated enemies that walk at you and hit you, a hitscan rifle with a magazine
and a reload, three medkits, and a HUD that tells you when the round is over.

```sh
npm install
npm run dev          # http://localhost:5179 — click to play
```

WASD to move, space to jump, mouse to aim, left button to fire, R to reload.

## What is here

```
index.html            the page
vite.config.ts        one plugin: gameable()
src/
  main.ts             the host: engine boot, lights, arena collider, sandbox
  game.ts             THE FILE YOU EDIT — what exists, where, and every number
  prefabs.ts          what things are made of
  arena.ts            where things spawn
  hud.ts              what the HUD shows
  assets.json         asset ids to files. Ids are the contract.
  systems/
    weapon.ts         fire, damage, reload
    enemyAI.ts        idle -> chase -> attack
    pickups.ts        medkits
tests/game.test.ts    the whole game, driven headlessly
scripts/build-guest.mjs  TypeScript -> WebAssembly component
```

Everything under `src/` except `main.ts` is compiled into the wasm guest.
`main.ts` is the host and stays in the browser.

## The two sandbox modes

`npm run dev` runs your TypeScript directly, through the same SDK runtime the
component uses. `npm run build` compiles that same TypeScript into a QuickJS
WebAssembly component and ships that. The host code is identical either way,
and `import.meta.env.GAMEABLE_MODE` is the only thing that differs. If the two ever
behave differently, that is an engine bug.

```sh
npm run build        # guest component + production bundle
npm run preview      # serve it
npm run build:direct # production bundle, direct sandbox — useful when debugging
```

## Change something

Every number worth changing is in the `rules` block of `src/game.ts`:

```ts
rules: {
  walkSpeed: 5,
  magazine: 12,
  damage: 20,
  enemySpeed: 2.2,
  enemySight: 14,
  medkitHeal: 35,
  winMessage: 'ARENA CLEARED',
},
```

Beyond that, in rough order of effort:

- **More enemies, elsewhere** — add spawn points to `src/arena.ts` and the loop
  in `game.ts`'s `init` picks them up.
- **A second weapon** — copy `src/systems/weapon.ts` and add it to `systems`.
- **Your own enemy instead of the sample character** — drop a skinned GLB in
  `public/`, point the `char.enemy` entry in `src/assets.json` at it, and keep
  `rig: { backend: 'skinned' }`. The host reads the clips out of the file.
- **A real model for a prop** — drop the file in `public/`, add an entry to
  `src/assets.json`, and give the prefab `asset: 'your.id'`. The host draws the
  placeholder box until the model loads, then swaps it.
- **Your own arena** — replace the `env.arena` entry in `src/assets.json` and
  the spawn table in `src/arena.ts`.

## Enemies and placeholders

The enemies are real characters. `character: 'char.enemy'` in `src/prefabs.ts`
names an entry in `src/assets.json` that points at `gameable/aosrig` —
one 3.1 MB skinned GLB, 114 joints, with `idle`, `walk`, `run` and `wave` baked
into it. The host loads it once, clones it six times, hides the placeholder
capsule and blends the clips from the velocity `src/systems/enemyAI.ts` sends.
It needs no WebGPU and no decoder, so it draws on the WebGL fallback too.
`ENEMY_COLOUR` still applies: `tint()` clones the rig's materials and sets them
red.

The player has no character on purpose — the first-person camera is inside its
head — and a medkit has no model, so the host draws a box the size of its
physics body. `tint()` in `src/prefabs.ts` colours those; give a prefab an
`asset` and the placeholder is replaced the moment the asset loads.

## Tests

```sh
npm test
```

`tests/game.test.ts` runs the real systems against a mock host: no browser, no
renderer, no physics engine. It walks the player, shoots an enemy, collects a
medkit, and checks that the same seed produces the same frames twice. That is
the loop to work in; the browser is for looking at it.

The end-to-end suite that drives the real thing lives in the engine repository
at `tests/e2e/fps.spec.ts`.
