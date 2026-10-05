# AGENTS.md

## What this is

A playable multiplayer pet simulator built on Gameable Engine: up to eight
players pick up coins, buy eggs, hatch pets that follow them, combine four
into one, and trade. Everything a player owns is their player document, kept
by the room's store between visits. It already works. You are here to change
it, not to finish it.

## The one rule

**Edit `src/game.ts`.** The numbers worth changing are in its `rules` block;
the three to try first are `eggCost`, `hatchSeconds` and `coinValue`. The
hatch odds are the `PET_KINDS` table in `src/pets.ts`. If a change needs
more than that, the next files to reach for, in order, are:

| File                    | What lives there                                           |
| ----------------------- | ---------------------------------------------------------- |
| `src/game.ts`           | Features, the player block, every rule, system order       |
| `src/pets.ts`           | The document's shape, the hatch table and its draw         |
| `src/systems/shop.ts`   | Buy, hatch, combine                                        |
| `src/systems/trade.ts`  | Offer, accept, the one exchange, and every refusal         |
| `src/systems/coins.ts`  | Where coins lie and what they pay                          |
| `src/systems/follow.ts` | The three pets that follow you                             |
| `src/messages.ts`       | What players send up, and each message's check             |
| `src/hud.ts`            | What each player's HUD says                                |
| `src/main.ts`           | The host: engine boot, the room, the page. Rarely.         |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop: that is a missing feature,
not a workaround.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM,
   no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`, on the
   authority: that is how a hatch cannot be rerolled). `main.ts` and the host
   files it imports (`hostAssets.ts`, `session.ts`, `solo.ts`, `testHooks.ts`)
   stay in the browser.
2. **Only the authority writes documents.** `ctx.data.save` and
   `ctx.data.exchange` do nothing on a client. Never edit a document in
   place: build the new one and save it whole (`saveDoc` in `src/docs.ts`).
3. **A trade is one `ctx.data.exchange`.** Never save two documents to fake a
   trade: a crash between the two saves duplicates or loses a pet. The
   exchange is all or nothing in the store.
4. **No allocation in a system on a quiet tick.** Systems run sixty times a
   second. Building a new document when something happened is fine; doing it
   every tick is not.
5. **Assets are string ids.** `'sfx.coin'`, never a path or a URL. A new asset
   is an entry in `src/assets.json`.
6. **Module-level state is frozen into the wasm component at build time.**
   Anything mutable is reset in `defineGame({ init })`.

## Commands

| Command                        | Does                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `npm test`                     | The room, as its authority, over a memory store             |
| `npm run build:guest`          | The wasm guest Play Solo's authority runs: after every edit |
| `npm run dev`                  | The page, http://localhost:5197; no `?room=` plays solo     |
| `npx gameable serve --direct` | A local room server on 8790, from `src/game.ts` as-is       |
| `npm run build`                | Guest component + production bundle                         |

Two tabs in one room: `http://localhost:5197/?room=new&rooms=http://localhost:8790`,
then **Copy link** into the second tab. Restart `serve --direct` after an edit.

## Where to look next

- `README.md`: what is here, the messages, and the gotchas.
- The recipes in the engine docs: play with friends, send a message, trade
  with another player. Each one is at most two files.
