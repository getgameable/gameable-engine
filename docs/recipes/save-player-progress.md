# Save player progress

## Goal

The steal kit gets a daily bonus: a player who joins and has had no bonus for
a day is paid 50 coins, and the wallet remembers when (`bonusAt`), so leaving
and coming back the same day pays nothing more. The amount is a rule.

It is the whole player-data pattern in one system: read the document the room
loaded at join (`ctx.players.get(id).data`), change a copy, hand it to
`ctx.data.save`. The room writes it to its store, at most once per 6 s per
player and always when the player leaves, so the next session starts from it.

## Files you will edit

- `src/game.ts`

## Steps

1. **Add the amount to `rules`** in `defineGame`, beside the others.

   ```ts
   rules: {
     // ...the rules already there
     dailyBonus: 50,
   },
   ```

2. **Import the wallet helpers**, beside the other imports. `walletOf` reads a
   seated player's wallet; `keep` saves a new one.

   ```ts
   import { keep, walletOf } from './bank';
   ```

3. **Write the system**, below the imports. It reads only this step's joins.
   `heist.now(ctx)` is the server's clock in ms: the room stamps it on every
   join (`PlayerHandle.joinedAt`), because the guest has no clock of its own.
   `bonusAt` is a field of your own: the wallet keeps any field it does not
   know.

   ```ts
   /** A day, in ms: the server's clock counts in ms. */
   const DAY_MS = 24 * 60 * 60 * 1000;

   /** Authority: a player who joins and has had no bonus for a day gets one, remembered in their wallet. */
   function dailyBonus(ctx: GameContext): void {
     const events = ctx.events;
     for (let i = 0; i < events.length; i += 1) {
       const event = events[i];
       if (event.tag !== 'player-joined') continue;
       const player = event.val.player;
       const wallet = walletOf(ctx, player);
       if (wallet === undefined) continue;
       const now = heist.now(ctx);
       const last = typeof wallet.bonusAt === 'number' ? wallet.bonusAt : 0;
       if (now - last < DAY_MS) continue;
       const coins = wallet.coins + Number(ctx.rules.dailyBonus);
       keep(ctx, player, { ...wallet, coins, bonusAt: now });
     }
   }
   ```

   Never change the wallet `walletOf` returned in place: that object is what
   the room last saved, and a save is a new document.

4. **Wire it in `systems`, right after `seats`**, which loads each joining
   wallet and pays for the time away first.

   ```ts
   systems: [
     { run: seats, on: 'authority' },
     { run: dailyBonus, on: 'authority' },
     // ...the systems already there
   ],
   ```

## Verify

```sh
npm test
npx gameable serve --direct
```

`npm test` now fails where it counts coins exactly: each test player gets the
bonus on their first join. That is the change working; set `dailyBonus: 0`
there, or add 50 to the expected coins. In a room
(`http://localhost:5193/?room=new&rooms=http://localhost:8790`), the HUD shows
50 coins on your first join. Close the tab and open the same address again: still 50,
not 100. `serve --direct` resolves no identities, so it keys a document by
seat (`seat-0`): alone, you are seat 0 again. It keeps the documents in memory
for as long as it runs; with `GAMEABLE_PG_URL` set, in Postgres across restarts.

## See also

- [Play with friends](./play-with-friends.md): a room server beside the dev server, and two tabs in one room
- [Send a message](./send-a-message.md): what a page may ask the authority for, such as the shield
- [Multiplayer](../concepts/multiplayer.md): roles, and why only the authority writes
- `templates/steal/src/systems/seats.ts`: the same pattern for offline income, from `savedAt` to `joinedAt`
