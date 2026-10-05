# Build your first FPS

Twenty minutes from nothing to a shooter you can play, and one file to change.

## 1. Scaffold

```sh
npm create gameable my-fps -- --template fps
cd my-fps
npm run dev
```

Open the page, click the canvas, and play: WASD to move, space to jump, mouse
to aim, left button to fire, R to reload. Six red-tinted characters chase you
across a gaussian-splat arena, three green boxes heal you, and the HUD tells you when
the round is over.

That is the starting point, not the destination. The rest of this page explains
what you were given so you can change it.

Working inside the engine repository instead? The same template is a workspace
member:

```sh
npm install
npm run dev -w templates/fps
```

## 2. What the template contains

```
my-fps/
├─ index.html
├─ vite.config.ts       one plugin: gameable()
├─ src/
│  ├─ main.ts           the host: engine boot, lights, arena collider, sandbox
│  ├─ game.ts           THE FILE YOU EDIT
│  ├─ prefabs.ts        what things are made of
│  ├─ arena.ts          where things spawn
│  ├─ hud.ts            what the HUD shows
│  ├─ assets.json       asset ids to files
│  └─ systems/
│     ├─ weapon.ts      fire, damage, reload
│     ├─ enemyAI.ts     idle -> chase -> attack
│     └─ pickups.ts     medkits
├─ tests/game.test.ts   the whole game, driven headlessly
└─ AGENTS.md            these rules, scoped to your game
```

Everything under `src/` except `main.ts` is compiled into the **wasm guest**.
It may not touch the DOM, fetch anything, or ask for the time. `main.ts` is the
host and stays in the browser.

## 3. The shape of `game.ts`

```ts
import { defineGame } from 'gameable';

import { arenaSpawns } from './arena';
import { updateHud } from './hud';
import { EnemyPrefab, MedkitPrefab, PlayerPrefab, tint } from './prefabs';
import { enemyAI } from './systems/enemyAI';
import { pickups } from './systems/pickups';
import { weapon } from './systems/weapon';

export default defineGame({
  assets: ['env.arena', 'sfx.shot', 'sfx.hit', 'sfx.pickup', 'sfx.step'],
  world: { gravity: -9.81, maxEntities: 512 },
  player: { prefab: PlayerPrefab, spawn: [0, 1.15, 9], camera: 'firstPerson' },
  rules: {
    walkSpeed: 5,
    magazine: 12,
    damage: 20,
    enemySpeed: 2.2,
    enemySight: 14,
    medkitHeal: 35,
    winMessage: 'ARENA CLEARED',
  },
  init: (ctx) => {
    for (const spawn of arenaSpawns.enemies) {
      tint(
        ctx.spawn(EnemyPrefab, { x: spawn.position[0], y: 1.05, z: spawn.position[2] }),
        0.82,
        0.18,
        0.16,
      );
    }
  },
  systems: [movePlayer, weapon, enemyAI, pickups, updateHud],
});
```

`assets`, `world` and `player` are sugar over built-in systems, so two games
that declare the same thing behave identically. `rules` is handed straight back
as `ctx.rules`, and every tuning number in the template reads from it — change
one there and nothing else has to know.

## 4. A system, in outline

```ts
import { Health, MOUSE_BUTTONS, Transform, type GameContext } from 'gameable';

/** Reused ray. A system must not allocate. */
const eye = { x: 0, y: 0, z: 0 };
const forward = { x: 0, y: 0, z: -1 };
const HIT_LAYERS = Object.freeze({ enemy: true, staticGeometry: true });

export function weapon(ctx: GameContext): void {
  if (!ctx.input.mouseDown(MOUSE_BUTTONS.LEFT)) return;
  ctx.audio.play('sfx.shot', { entity: ctx.player, volume: 0.7 });
  aimFromCamera(ctx, eye, forward); // writes into the hoisted vectors
  const hit = ctx.physics.raycast(eye, forward, 60, HIT_LAYERS, ctx.player);
  if (hit) Health.current[hit.entity] -= Number(ctx.rules.damage);
}
```

`src/systems/weapon.ts` is this plus a cooldown, a magazine and a reload.
Four things to notice:

1. **`physics.raycast` is synchronous.** Physics queries are the only blocking
   host calls a guest may make; everything else is a command applied after the
   guest returns.
2. **Nothing allocates.** Systems run sixty times a second inside a QuickJS
   heap. Hoist your vectors and your query term arrays.
3. **`'sfx.shot'` is a manifest id**, not a path. Adding a sound is an entry in
   `src/assets.json`.
4. **The player is excluded with a layer mask**, not by asking the host to skip
   it. Cheaper, and it is what layers are for.

## 5. Placeholders, and replacing them

Nothing in the template has a model. The host draws a mesh the size and shape
of each entity's **physics body** — a capsule for a person, a box for a medkit
— so the game is playable before any art exists, and `tint()` colours them.

Give a prefab an `asset` and the placeholder is replaced the moment the asset
loads:

```ts
export const EnemyPrefab = prefab({
  asset: 'enemy.grunt', // add it to src/assets.json
  body: { shape: 'capsule', dims: [0.35, 0.7], kind: 'character', mass: 70 },
  health: 40,
  components: [Enemy],
});
```

## 6. Change something

Pick one; each is a recipe of its own:

- [Add a weapon](../recipes/add-a-weapon.md) — a shotgun, in two files.
- [Add an enemy](../recipes/add-an-enemy.md) — a second kind, tougher and slower.
- [Change the level](../recipes/change-the-level.md) — your own arena and spawn table.
- [Add a HUD element](../recipes/add-a-hud-element.md) — a new number on screen.

## 7. Test it

```sh
npm test
```

`tests/game.test.ts` runs the real systems against a mock host — no browser, no
renderer, no physics engine — and asserts that W walks the player, that a shot
takes health off the enemy in the crosshair, that the win message appears when
the last one dies, and that the same seed produces the same frames twice.

That is the loop to work in. The browser is for looking at it.

## 8. Ship it

```sh
npm run build     # guest component + production bundle
npm run preview
```

`npm run dev` runs your TypeScript directly; `npm run build` compiles the very
same TypeScript into a QuickJS WebAssembly component. The host code is
identical and `import.meta.env.GAMEABLE_MODE` is the only difference. If the two
behave differently, that is an engine bug — report it rather than working
around it.

## See also

- [ECS and game code](../concepts/ecs.md)
- [The wasm boundary](../concepts/wasm-boundary.md)
- [Assets and the manifest](../concepts/assets.md)
- [Recipes](../recipes/index.md)
