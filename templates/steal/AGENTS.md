# AGENTS.md

## What this is

A playable multiplayer "steal a brainrot" game built on Gameable Engine: up
to six players, a base each on a ring, a conveyor that brings out a
collectible every few seconds, income per collectible, steals, a shield and
rebirths. Each player's progress is their document in the room's store, so it
outlives the session. It already works. You are here to change it, not to
finish it.

## The one rule

**Edit `src/game.ts`.** The numbers worth changing are in its `rules` block;
the three to try first are `conveyorSeconds`, `stealSeconds` and
`incomePerItem`. If a change needs more than that, the next files to reach
for, in order, are:

| File                     | What lives there                                           |
| ------------------------ | ---------------------------------------------------------- |
| `src/game.ts`            | Features, the player block, the layout, every rule, order  |
| `src/wallet.ts`          | The saved document and its pure rules: payout, offline pay |
| `src/systems/steal.ts`   | Standing in a base, the one exchange per steal             |
| `src/systems/belt.ts`    | Spawning on the conveyor, riding, grabbing                 |
| `src/systems/seats.ts`   | Loading a wallet at join, offline income, the room phase   |
| `src/systems/income.ts`  | The payout every `incomeSeconds`                           |
| `src/systems/actions.ts` | The shield and the rebirth                                 |
| `src/messages.ts`        | What players send up, and each message's check             |
| `src/hud.ts`             | What each player's HUD says                                |
| `src/main.ts`            | The host: engine boot, the room, the page. Rarely.         |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop: that is a missing feature,
not a workaround.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM,
   no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). The
   server's clock is `heist.now(ctx)`, from the time the room stamps on every
   join (`PlayerHandle.joinedAt`). `main.ts` and the host files it imports
   (`hostAssets.ts`, `session.ts`, `solo.ts`, `testHooks.ts`) stay in the browser.
2. **Only the authority writes documents.** `ctx.data.save(id, wallet)` with a
   new object, never the one `walletOf` returned changed in place. Anything
   that moves between two players goes through ONE `ctx.data.exchange`, never
   two saves: two saves can half-happen, an exchange cannot.
3. **Every system says where it runs.** `on: 'authority'` for anything that
   decides; `on: 'client'` for keys and local sounds.
4. **No allocation in a system on a quiet tick.** A save is a new object, so
   it happens only on the ticks a wallet changes. Hoist everything else to
   module scope; the heist's state is flat lanes (`src/heist.ts`).
5. **Walk `ctx.players.list` with an index.** Iterating the `ctx.players` map
   allocates.
6. **Assets are string ids.** `'sfx.grab'`, never a path or a URL.
7. **Module-level state is frozen into the wasm component at build time.**
   Anything mutable is reset in `defineGame({ init })`.

## Commands

| Command                       | Does                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `npm test`                    | The heist, as the room's authority over a memory store        |
| `npm run build:guest`         | The wasm guest Play Solo's authority runs: after every edit   |
| `npm run dev`                 | The page, http://localhost:5193; no `?room=` plays solo       |
| `npx gameable serve --direct` | A local room server on 8790, from `src/game.ts`, with a store |
| `npm run build`               | Guest component + production bundle                           |

Two tabs in one room: `http://localhost:5193/?room=new&rooms=http://localhost:8790`,
then **Copy link** into the second tab. Restart `serve --direct` after an edit.

## Where to look next

- `README.md`: what is here, the document, the messages, and the gotchas.
- The recipes in the engine docs: play with friends, send a message, save
  player progress. Each one is at most two files.
