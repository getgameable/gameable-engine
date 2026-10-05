# AGENTS.md

## What this is

A playable multiplayer round built on Gameable Engine: three to six players, a
lobby, a secret "it" (or several), tag-outs, votes and chat. It already works.
You are here to change it, not to finish it.

## The one rule

**Edit `src/game.ts`.** The numbers worth changing are in its `rules` block;
the three to try first are `roundSeconds`, `its` and `tagRadius`. If a change
needs more than that, the next files to reach for, in order, are:

| File                    | What lives there                                         |
| ----------------------- | -------------------------------------------------------- |
| `src/game.ts`           | Features, the player block, every rule, the system order |
| `src/messages.ts`       | What players send up, and each message's check           |
| `src/systems/tag.ts`    | Tagging, and the end of the round by tag or by clock     |
| `src/systems/vote.ts`   | The vote: who may vote, the majority, the timeout        |
| `src/systems/ready.ts`  | The lobby and the start rule                             |
| `src/systems/pickIt.ts` | The deal: who is "it", the starting ring                 |
| `src/hudModel.ts`       | What each player's HUD says                              |
| `src/round.ts`          | The round's state on the authority                       |
| `src/main.ts`           | The host: engine boot, the room, the page. Rarely.       |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop: that is a missing feature,
not a workaround.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM,
   no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). `main.ts`
   and the host files it imports (`hostAssets.ts`, `session.ts`, `solo.ts`,
   `chatPrompt.ts`, `testHooks.ts`) stay in the browser.
2. **Every system says where it runs.** `on: 'authority'` for anything that
   decides (it owns the bodies and the secret); `on: 'client'` for keys and
   local sounds. A client never learns who "it" is except through its own HUD.
3. **The secret lives in one HUD.** Never put who is "it" in a `send` before
   `round-over`. `tests/game.test.ts` checks every step for a leak.
4. **No allocation in a system.** Systems run sixty times a second. Hoist
   vectors and arrays to module scope; the round's state is flat lanes indexed
   by player id (`src/round.ts`).
5. **`ctx.players` is read by id, never iterated.** A `Map` iterator is an
   allocation every tick.
6. **Assets are string ids.** `'sfx.tag'`, never a path or a URL. A new asset
   is an entry in `src/assets.json`.
7. **Module-level state is frozen into the wasm component at build time.**
   Anything mutable is reset in `defineGame({ init })`.

## Commands

| Command                       | Does                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `npm test`                    | The round, driven headlessly as the room's authority        |
| `npm run build:guest`         | The wasm guest Play Solo's authority runs: after every edit |
| `npm run dev`                 | The page, http://localhost:5192; no `?room=` plays solo     |
| `npx gameable serve --direct` | A local room server on 8790, from `src/game.ts` as-is       |
| `npm run build`               | Guest component + production bundle                         |

Two tabs in one room: `http://localhost:5192/?room=new&rooms=http://localhost:8790`,
then **Copy link** into the second tab. Restart `serve --direct` after an edit.

## Where to look next

- `README.md`: what is here, the messages, and the gotchas.
- The recipes in the engine docs: play with friends, send a message, add a
  lobby, add a vote. Each one is at most two files.
