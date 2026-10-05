# Gameable Engine collect kit

A pet simulator for up to eight players, out of the box. Everyone wears the
sample character and starts in the middle of the placeholder arena, with gold
coins lying about. Walk over a coin for 5 bucks. Press B to buy an egg (25
bucks); ten seconds later it hatches into a cat, a dog, a unicorn or, one time
in a hundred, a dragon. Your three newest pets follow you around. C combines
four identical pets into one of the next tier. Stand near another player and
press T to offer a swap of your newest pets; they press Y to accept, and the
trade happens all at once or not at all.

Everything you own is your player document, `{ bucks, pets, eggs }`, which
the room's store keeps: leave, come back, it is still yours.

```sh
npm install
npm run build:guest          # Play Solo's authority is the built wasm guest
npm run dev                  # http://localhost:5197: Play Solo, a room of one
npm test                     # the room as its authority, over a memory store
```

## Play it with friends

In a second terminal, beside `npm run dev`:

```sh
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5197/?room=new&rooms=http://localhost:8790`. The
corner shows a four-letter code and **Copy link**; open the link in a second
tab. `--direct` reads `src/game.ts` once: restart it after an edit. The room
list shows the phase, `open`. Without `GAMEABLE_PG_URL` the server keeps documents
in memory until it stops. See the `play-with-friends` recipe.

## What to change first

Every number worth changing is in the `rules` block of `src/game.ts`. The
three that change the game most:

```ts
rules: {
  eggCost: 25,       // bucks per egg
  hatchSeconds: 10,  // how long an egg takes
  coinValue: 5,      // bucks per coin
  ...
},
```

- **`eggCost`** against **`coinValue`**: five coins buy an egg; make it 100
  and pets are rare.
- **`hatchSeconds`** (and `maxEggs`, 3 at once): the wait between buying and
  having.
- **The odds**: the `PET_KINDS` table in `src/pets.ts`, weights 60, 30, 9
  and 1. Add a row for a new pet; it needs only a kind, a weight and a colour.

After a change, run `npm test`, then `npm run build:guest` (Play Solo) and
restart `npx gameable serve --direct` (rooms). The other rules are
`coinCount`, `coinRange`, `startBucks`, `maxTier`, `tradeRange`, `dealBucks`,
`petFollow`, `walkSpeed`, `runSpeed`, `cameraDistance` and `cameraHeight`.

## What is here

```
src/
  game.ts             THE FILE YOU EDIT: features, player, rules, system order
  pets.ts             the document's shape, the hatch table, the draw
  collection.ts       the room's state beside the documents: pet bodies, offers
  docs.ts             read, save and refuse: the document helpers
  prefabs.ts          Collector, PetBody, CoinBody
  arena.ts            the spawn, and where coins may lie
  messages.ts         buy, combine, offer and accept, with their checks
  hud.ts              what each player's HUD says
  systems/
    seats.ts          a join loads the document; a leave takes the pets and offers
    move.ts           the third-person controller, per player
    coins.ts          walk over a coin for bucks
    shop.ts           buy an egg, hatch it, combine four
    trade.ts          offer, accept, one exchange
    follow.ts         the three newest pets follow their owner
    deals.ts          the swap T would offer the nearest player
    controls.ts       the client: B, C, T and Y
  main.ts, session.ts, solo.ts, hostAssets.ts, testHooks.ts   the page (host code)
tests/                the room as its authority over a memory store (tests/room.ts)
```

Every system but `controls` runs on the room's **authority**: it owns the
documents, the coins and the dice, so a page can ask for an egg but never
mint a pet. `controls` runs on each player's **client**.

## Messages

Up, from a page (`src/messages.ts`):

- `buy` `null`: an egg, for `eggCost`.
- `combine` `{ kind, tier }`, or `null` for the first four alike.
- `offer` `{ to, give, take }`: a side is `{ bucks?, pets?: [id] }`. Refused
  unless the sender owns everything in `give` and `to` owns everything in
  `take`. One open offer per sender; a new one replaces the last.
- `accept` `{ offerId }`: only from the player it was made to. Checked again
  against both documents as they are now; then one `ctx.data.exchange`.

Down, from the authority, each to the player it concerns: `coin` `{ bucks }`,
`hatched` (the pet), `deal` (the trade T sends), `offered`
`{ offerId, from, text }`, `trade` `{ ok, reason }` to both sides, and
`refused` `{ what, reason }` (`short`, `busy`, `full`, `need-four`,
`not-yours`, `not-theirs`, `no-player`, `empty`, `stale`).

## Gotchas

- **A failed exchange changes nothing.** If the store refuses (`stale`: the
  document moved on elsewhere), both players are told `trade` `{ ok: false }`
  and both documents stay as they were. Offer again.
- **An offer goes stale.** When either side no longer holds what it named, a
  newer offer replaced it, or either player left, `accept` is refused `stale`.
- **A player mid-trade cannot buy or combine** until the exchange comes back
  (a tick or two): `refused` `busy`.
- **`hatchAt` is the room's clock** (`ctx.elapsed`). An egg brought in from
  another room hatches at most `hatchSeconds` after the join.
- **Only three pets show.** The newest three follow you; the rest are in the
  document, and trade and combine all the same.
- **Play Solo's authority is the built guest.** Under `npm run dev` the page
  warns when `build/guest/` is older than `src/`; run `npm run build:guest`.
