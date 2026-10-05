# Gameable Engine survive kit

A multiplayer survival game for four to six players, out of the box. Everyone
wears the sample character and starts at the camp in the middle of the
placeholder arena, with six trees around it. By day, walk to a tree and press
E for wood, then B to put a wall up in front of you (two wood). At dusk the
creatures come out of the tree line, three on the first night and one more
each night after, and walk at the nearest camp body: a player on their feet,
or a wall. What they reach, they hit. A player at 0 health is down until
dawn; a wall at 0 falls. At dawn the creatures are gone, every player still
standing has survived one more night, and the downed get up at the camp.

```sh
npm install
npm run build:guest          # Play Solo's authority is the built wasm guest
npm run dev                  # http://localhost:5195: Play Solo, a room of one
npm test                     # the camp, driven headlessly as the authority
```

## Play it with friends

In a second terminal, beside `npm run dev`:

```sh
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5195/?room=new&rooms=http://localhost:8790`. The
corner shows a four-letter code and **Copy link**; open the link in a second
tab. `--direct` reads `src/game.ts` once: restart it after an edit. The room
list shows each room's phase, `day` or `night`. See the `play-with-friends`
recipe.

## What to change first

Every number worth changing is in the `rules` block of `src/game.ts`. The
three that change the game most:

```ts
rules: {
  daySeconds: 60,          // how long you have to gather and build
  creaturesFirstNight: 3,  // how many come on the first night
  wallCost: 2,             // the wood one wall takes
  ...
},
```

- **`daySeconds`** (and `nightSeconds`, 45): a short day leaves no time to
  build; a long night outlasts the walls.
- **`creaturesFirstNight`** (and `creaturesPerNight`, 1 more each night): the
  difficulty curve. At most 24 are alive at once (`MAX_CREATURES`).
- **`wallCost`** (and `woodPerGather`, 1): how much of the day building takes.

After a change, run `npm test`, then `npm run build:guest` (Play Solo) and
restart `npx gameable serve --direct` (rooms). The other rules are
`creatureSpeed`, `creatureReach`, `creatureDamage`, `creatureHitSeconds`,
`gatherRange`, `buildDistance`, `walkSpeed`, `runSpeed`, `cameraDistance` and
`cameraHeight`.

## What is here

```
src/
  game.ts             THE FILE YOU EDIT: features, player, trees, rules, system order
  camp.ts             the camp's state on the authority: clock, wood, nights, lists
  prefabs.ts          Survivor, Creature, Tree, Wall
  arena.ts            the camp, the ring of trees, the tree line
  messages.ts         gather and build, with their checks
  hud.ts              what each player's HUD says
  systems/
    clock.ts          day and night: dusk spawns, dawn counts and gets the downed up
    creatures.ts      walk at the nearest camp body, hit it
    work.ts           gather beside a tree, build in front of you
    move.ts           the third-person controller, per player
    seats.ts          a seat left or taken starts again
    controls.ts       the client: E and B, and this player's sounds
  main.ts, session.ts, solo.ts, hostAssets.ts, testHooks.ts   the page (host code)
tests/game.test.ts    the camp, driven headlessly through simulatePlayers
```

Every system but `controls` runs on the room's **authority**: it owns the
bodies, the wood and the night, so a page can ask for a wall but never mint
one. `controls` runs on each player's **client**.

## Messages

Up, from a page: `gather` and `build`, both `null` (`src/messages.ts`).
Down, from the authority: `wood` `{ wood }` to the one player whose count
changed; `downed` `{ player }`, `night` `{ night }` and `dawn` `{ night }` to
everyone.

## Gotchas

- **`nightsSurvived` lasts as long as the room.** It lives in `src/camp.ts`
  on the authority; a player who leaves, or a room that closes, loses it.
- **A seat left and taken again starts with nothing**: no wood, no nights, on
  its feet (`src/systems/seats.ts`).
- **Play Solo's authority is the built guest.** Under `npm run dev` the page
  warns when `build/guest/` is older than `src/`; run `npm run build:guest`.
- **Creatures only chase.** They walk straight at the nearest camp body and
  path round nothing: a wall between a creature and a player holds it back,
  and it hits that wall only once the wall is the nearest body it has.
