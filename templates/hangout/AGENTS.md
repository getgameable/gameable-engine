# AGENTS.md

## What this is

A multiplayer hangout built on Gameable Engine. It already works: up to twelve
players on a street of six placeholder houses, two to a house, with front doors
that open, two cars anyone can drive, two benches, colours and chat. There is
no round and no win. You are here to change it, not to finish it.

## The one rule

**Edit `src/game.ts`.** Most changes are a number in `rules`, an entry in the
street, or a line in `systems`. If a change needs more, the next files, in order:

| File                      | What lives there                                            |
| ------------------------- | ----------------------------------------------------------- |
| `src/game.ts`             | What exists, where each system runs, every tuning number    |
| `src/street.ts`           | Where the houses, doors, cars, benches and spawns are       |
| `src/prefabs.ts`          | What things are made of: shapes, tags, colours              |
| `src/messages.ts`         | What players send up and the authority sends down           |
| `src/systems/interact.ts` | E: doors and cars, and every player's prompt                |
| `src/systems/drive.ts`    | How a car moves, and the `sit` state for drivers and seated |
| `src/hud.ts`              | What each player's HUD shows                                |
| `src/main.ts`             | The host: engine boot, the room, the chat prompt. Rarely.   |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM, no
   `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). `main.ts` and
   the host files it imports (`hostAssets.ts`, `session.ts`, `solo.ts`,
   `chatPrompt.ts`, `testHooks.ts`) stay in the browser.
2. **The authority decides.** Every system but `controls` runs `on: 'authority'`:
   it owns the bodies, the doors and the cars, and reads each player's own keys
   through `ctx.players.get(id).input`. A client only turns keys into messages.
3. **No allocation in a system.** Per-player state is a flat lane indexed by
   seat (`src/residents.ts`); hoist query terms and payload objects.
4. **Assets are string ids.** A new asset is an entry in `src/assets.json`.
5. **Module state is frozen into the wasm component.** Reset it in `init`;
   every module with state has a `reset*` for that.
6. **A message is declared once** with `defineMessage` and a check. A payload
   that fails the check never reaches a system.

## Commands

| Command               | Does                                                            |
| --------------------- | --------------------------------------------------------------- |
| `npm run build:guest` | The wasm guest Play Solo's authority runs; rerun after a change |
| `npm run dev`         | Vite dev server: Play Solo, and `?room=` for a real room        |
| `npm test`            | The street on the authority, through `simulatePlayers`          |
| `npm run build`       | Guest component + production bundle                             |

Two tabs on one room: `npm run dev` and `npx gameable serve --direct` side by
side, then open `http://localhost:5196/?room=new&rooms=http://localhost:8790`
and open the link the corner's **Copy link** gives you in a second tab.

## Where to look next

- `README.md` — what the kit contains and the three rules to change first.
- The recipes: play with friends, send a message, give players a colour.
