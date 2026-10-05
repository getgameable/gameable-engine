# Add a kick

## Goal

The brawl kit's fighters get a fourth move: `I` kicks. A kick reaches farther
than a punch and knocks harder, but has a longer cooldown. Like every
ability, the page only asks; the authority checks the cooldown, the reach and
the facing, and confirms a hit to the attacker and the victim.

## Files you will edit

- `src/systems/abilities.ts`
- `src/systems/controls.ts`

## Steps

1. **Declare the message and its cooldown** in `src/systems/abilities.ts`,
   below the imports. Add `defineMessage` to the file's `gameable`
   import. The cooldown is one lane per seat, made once.

   ```ts
   /** I: kick whoever is in front of me. */
   export const Kick = defineMessage('kick', (p): p is null => p === null, { maxBytes: 8 });

   /** The kick's number in `hit` and `refused`: after punch 0, dash 1, slam 2. */
   const KICK = 3;
   /** Seconds until each seat may kick again. */
   const kickReady = new Float32Array(MAX_PLAYERS);
   ```

2. **Check it and land it** at the end of `abilities(ctx)`, after the slams.
   `allowed` refuses a kick inside its cooldown, from a knocked-out fighter or
   between rounds, and starts the cooldown otherwise; `strike` finds the
   nearest fighter in reach and in front, and lands the hit or refuses with
   `range` or `facing`.

   ```ts
   for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
     kickReady[seat] = Math.max(0, kickReady[seat] - ctx.dt);
   }
   const kicks = ctx.net.messages(Kick);
   for (let i = 0; i < kicks.length; i += 1) {
     const player = ctx.players.get(kicks[i].player);
     if (allowed(ctx, player, KICK, kickReady, 1.2)) {
       strike(ctx, player, KICK, 2.2, 90, 16, 11);
     }
   }
   ```

   The numbers are the cooldown (1.2 s), then the reach (2.2 m), the arc in
   front (90 degrees), the damage and the knockback (m/s). Move them into
   `rules` in `src/game.ts` when you want them beside the others.

3. **Send it from the page** in `src/systems/controls.ts`: import `Kick` from
   `./abilities`, and add one line beside the other keys in `controls(ctx)`.

   ```ts
   if (ctx.input.pressed('I')) ctx.net.send(Kick, null);
   ```

4. **Rebuild the guest**, because Play Solo's authority runs it:

   ```sh
   npm run build:guest
   ```

## Verify

```sh
npm test
```

passes as before. Then `npm run dev`, open `http://localhost:5199`, open
**Play with friends** in a second tab, and walk the two fighters to two metres
apart, facing each other. `I` lands (the other fighter flashes red and slides
back); `J` from the same spot is refused, out of the punch's reach.

## See also

- [Send a message](./send-a-message.md): the round trip every ability uses.
- [Play with friends](./play-with-friends.md): two tabs in one room.
- [Multiplayer](../concepts/multiplayer.md): prediction, and why a knockback
  reaches your own page as a correction.
