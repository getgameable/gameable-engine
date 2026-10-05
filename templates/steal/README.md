# Gameable Engine steal kit

A multiplayer "steal a brainrot" game for up to six players, out of the box.
Everyone wears the sample character and starts in their own base, one of six
on a ring round the placeholder arena. A conveyor runs through the middle and
brings out a brainrot every 8 seconds. Walk into one to take it home. Every
brainrot in your base pays a coin every 10 seconds. Stand in someone else's
base for 3 seconds and you take their newest one. Q spends 10 coins on a
20-second shield nobody steals through; R, once you hold 100 coins, gives up
your coins and brainrots for a rebirth: every payout after is worth half as
much again.

Your progress is saved: `{ coins, owned, shieldUntil, rebirths }` is your
document in the room's store. Leave and come back, and you are paid for the
time away, up to 8 hours.

```sh
npm install
npm run build:guest          # Play Solo's authority is the built wasm guest
npm run dev                  # http://localhost:5193: Play Solo, a room of one
npm test                     # the heist, as the authority over a memory store
```

## Play it with friends

In a second terminal, beside `npm run dev`:

```sh
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5193/?room=new&rooms=http://localhost:8790`. The
corner shows a four-letter code and **Copy link**; open the link in a second
tab. `--direct` reads `src/game.ts` once: restart it after an edit. The room
list shows the room as `open`. Without `GAMEABLE_PG_URL` the server keeps documents
in memory while it runs; with it, in Postgres. See the `play-with-friends`
recipe.

## What to change first

Every number worth changing is in the `rules` block of `src/game.ts`. The
three that change the game most:

```ts
rules: {
  conveyorSeconds: 8,  // a brainrot on the belt every this many seconds
  stealSeconds: 3,     // how long a thief stands in your base to take one
  incomePerItem: 1,    // coins per brainrot per payout (every incomeSeconds, 10)
  ...
},
```

- **`conveyorSeconds`** (and `beltSpeed`, 1.2 m/s): how fast new brainrots
  come. Fewer on the belt makes stealing the way to grow.
- **`stealSeconds`** (and `baseRadius`, 1.6 m): how hard a base is to rob. A
  short steal makes defending (standing in the way, the shield) matter.
- **`incomePerItem`** (and `incomeSeconds`, `rebirthCost`, `rebirthBonus`):
  the economy. `offlineCapHours` (8) caps the pay for time away.

After a change, run `npm test`, then `npm run build:guest` (Play Solo) and
restart `npx gameable serve --direct` (rooms). The other rules are
`grabRadius`, `shieldSeconds`, `shieldCost`, `walkSpeed`, `runSpeed`,
`cameraDistance` and `cameraHeight`.

## What is here

```
src/
  game.ts             THE FILE YOU EDIT: features, player, layout, rules, system order
  wallet.ts           the saved document, and its pure rules: payout, offline income
  bank.ts             walletOf and keep: reading and saving a seated player's wallet
  heist.ts            the authority's lanes: who stands where, pending steals, the belt, the clock
  prefabs.ts          Thief, Pad, Belt, Brainrot
  ring.ts             the bases on the ring, the conveyor
  messages.ts         shield and rebirth, with their checks
  hud.ts              what each player's HUD says
  systems/
    seats.ts          a join loads the wallet, pays for the time away; the phase is open
    belt.ts           a brainrot every conveyorSeconds; walk into one to grab it
    steal.ts          stand in another base; one exchange per steal
    income.ts         the payout every incomeSeconds
    actions.ts        the shield and the rebirth
    move.ts           the third-person controller, per player
    controls.ts       the client: Q and R, and this player's sounds
  main.ts, session.ts, solo.ts, hostAssets.ts, testHooks.ts   the page (host code)
tests/game.test.ts    the heist, through simulatePlayers and a RoomData over a memory store
```

Every system but `controls` runs on the room's **authority**: it owns the
bodies, the brainrots and every wallet, so a page can ask for a shield but
never pay itself. `controls` runs on each player's **client**.

## The document and the steal

A player's document is a `Wallet` (`src/wallet.ts`). The room loads it at join
(`ctx.players.get(id).data`, with `savedAt`, when the store last wrote it, and
`joinedAt`, the server's clock at the load). `ctx.data.save` writes it back,
at most once per 6 s per player, and always when the player leaves.

A steal is one `ctx.data.exchange(thief, victim, {}, { owned: [id] })`: the
store moves the id out of one document and into the other together, or not at
all. The result arrives a tick or more later in `ctx.data.results()`; on
success both players' `data` already show it, and everyone gets `stolen`.

## Messages

Up, from a page: `shield` and `rebirth`, both `null` (`src/messages.ts`).
Down, from the authority: `grabbed` `{ player, id }`, `stolen`
`{ thief, victim, id }` and `shielded` `{ player }` to everyone; `away`
`{ coins }` to the one player paid for their time away.

## Gotchas

- **A document is per player per game, keyed by who they are.** The live room
  server resolves an identity (portal account, else this device); `serve
--direct` and Play Solo resolve none and key by seat (`seat-0`), so in a
  local room whoever takes seat 0 gets seat 0's wallet.
- **The guest has no clock.** `heist.now(ctx)` is the server's, from the last
  join. Without a store (a bare test guest) it is room time from 0.
- **The newest brainrot goes first.** A steal takes the last id in `owned`.
- **Play Solo's authority is the built guest.** Under `npm run dev` the page
  warns when `build/guest/` is older than `src/`; run `npm run build:guest`.
- **The bases and the belt collide with nothing.** Grabbing and standing in a
  base are distance checks on the authority, not contacts.
