# Trade with another player

## Goal

Two players in a room trade, all or nothing: one sells a gem, the other pays
coins, and either both happen or neither does. What each player owns lives in
their player document, which the room's store keeps between visits, so a gem
bought today is still yours tomorrow.

A trade is two steps. `G` offers your gem to the next player for `gemPrice`
coins; `H` accepts the offer made to you. The accept becomes one
`ctx.data.exchange`, and both players hear how it ended. An offer the
documents no longer match (the buyer spent the coins, the seller sold the gem)
is stale and does nothing.

This builds on [Play with friends](./play-with-friends.md): the game already
declares `multiplayer`. The collect kit (`templates/collect`) trades pets the
same way, with `offer` and `accept` messages.

## Files you will edit

- `src/game.ts`

## Steps

1. **Add the price to `rules`**, beside the others.

   ```ts
   rules: {
     // ...the rules already there
     gemPrice: 5,
   },
   ```

2. **Keep the open offer at module scope**, below the imports. Add
   `applyTransfer` and `type TransferDoc` to the file's `gameable`
   import. The offer is one object, made once; `init` resets it (step 4).

   ```ts
   /** A player's document: what the room's store keeps for them. */
   interface Purse {
     coins: number;
     gems: string[];
   }

   /** The one open offer: `from` gives `give` and takes `take` from `to`. */
   const offer = { open: false, from: 0, to: 0, give: {} as TransferDoc, take: {} as TransferDoc };
   ```

3. **Trade on the authority.** It reads each player's own keys from their
   handle, so nothing a page sends can make an offer for someone else.
   `applyTransfer` is the rule the store runs: number fields move amounts,
   list fields move items, and it returns `null` when a side is short.

   ```ts
   /** Authority: new purses, offers, accepts, and how each trade ended. */
   function trading(ctx: GameContext): void {
     for (let i = 0; i < ctx.events.length; i += 1) {
       const e = ctx.events[i];
       // A first-time player starts with 10 coins and a gem of their own.
       if (e.tag === 'player-joined' && ctx.players.get(e.val.player)?.data === null) {
         ctx.data.save(e.val.player, { coins: 10, gems: [`gem-${e.val.name}`] });
       }
     }
     const list = ctx.players.list;
     for (let i = 0; i < list.length; i += 1) {
       const p = list[i];
       const purse = p.data as Purse | null;
       // G: offer my first gem to the next player, for gemPrice coins.
       if (p.input.pressed('G') && purse !== null && purse.gems.length > 0 && list.length > 1) {
         const buyer = list[(i + 1) % list.length].id;
         const price = Number(ctx.rules.gemPrice);
         Object.assign(offer, {
           open: true,
           from: p.id,
           to: buyer,
           give: { gems: [purse.gems[0]] },
           take: { coins: price },
         });
         ctx.net.send('offered', { from: p.id, price }, { to: buyer });
       }
       // H: accept the offer made to me, if the documents still match it.
       if (p.input.pressed('H') && offer.open && offer.to === p.id) {
         offer.open = false;
         const seller = ctx.players.get(offer.from)?.data;
         if (applyTransfer(seller, purse, offer.give, offer.take) === null) continue; // stale
         ctx.data.exchange(offer.from, offer.to, offer.give, offer.take);
       }
     }
     const results = ctx.data.results();
     for (let i = 0; i < results.length; i += 1) {
       ctx.net.send('traded', { ok: results[i].ok, reason: results[i].reason });
     }
   }
   ```

   On success both documents already show the trade when the result
   arrives, and the room has written both. On a failure (`stale`, when the
   store's copy moved on; `refused`, when a side is short there) neither
   document changed.

4. **Reset the offer in `init`**, beside the resets already there.

   ```ts
   init: (ctx) => {
     offer.open = false;
     // ...the resets already there
   },
   ```

5. **Wire it in `systems`**, on the authority.

   ```ts
   systems: [
     // ...the systems already there
     { run: trading, on: 'authority' },
   ],
   ```

## Verify

```sh
npm test
npx gameable serve --direct
npm run dev
```

Open a room in two tabs, as in [Play with friends](./play-with-friends.md).
Press `G` in the first: the second is sent `offered`. Press `H` in the
second: both are sent `traded` with `ok: true`, and the gem has changed
hands (log `ctx.players.get(id).data` on the authority to see it). Press `H`
again: nothing, the offer is gone. Close both tabs and open the same room in
the same two browsers again: the gem is still where the trade left it, because
the store keys a document by the player, not the seat. A room server started
without `GAMEABLE_PG_URL` keeps documents in memory until it stops; Play Solo is a
room of one, so it has nobody to trade with.

## See also

- [Send a message](./send-a-message.md): `offered` and `traded` are plain messages down
- [Multiplayer](../concepts/multiplayer.md): roles, and what only the authority may do
- `templates/collect/src/systems/trade.ts`: pets for pets or bucks, offer by message, with every refusal named
