# Add a night cycle

## Goal

The adventure gets a clock: two minutes of day, thirty seconds of night, over
and over. At dusk and at dawn every player hears it, the room list shows the
room as `day` or `night`, and while it is dark the chests and the door stay
shut. The lengths are rules, so tuning them is a number in `src/game.ts`.

This is the survive kit's clock (`templates/survive/src/systems/clock.ts`)
without the creatures. It works alone and in a room; with
[Play with friends](./play-with-friends.md) done, the room's authority keeps
the time for everyone.

## Files you will edit

- `src/game.ts`

## Steps

1. **Add the two lengths to `rules`** in `defineGame`, beside the others.

   ```ts
   rules: {
     // ...the rules already there
     daySeconds: 120,
     nightSeconds: 30,
   },
   ```

2. **Keep the clock at module scope**, below the imports. It is two fields,
   made once, so the system below allocates nothing. Module state is frozen
   into the wasm guest at build time, so `init` resets it (step 4).

   ```ts
   /** Day or night, and `ctx.elapsed` when this one began. */
   const sky = { night: false, since: 0 };
   ```

3. **Turn the clock on the authority.** A guest with no room (the `solo`
   role) runs it too, so the adventure alone has nights as well.
   `ctx.net.setPhase` sends only when the word changes, so saying it every
   step costs nothing; a guest with no room ignores it.

   ```ts
   /** Authority: day to night and back, said to every player and the room list. */
   function nightCycle(ctx: GameContext): void {
     const length = Number(sky.night ? ctx.rules.nightSeconds : ctx.rules.daySeconds);
     if (ctx.elapsed - sky.since >= length) {
       sky.night = !sky.night;
       sky.since = ctx.elapsed;
       ctx.net.send(sky.night ? 'dusk' : 'dawn', null);
     }
     ctx.net.setPhase(sky.night ? 'night' : 'day');
   }

   /** Client: hear dusk and dawn. Alone, the authority is this page. */
   function hearTheSky(ctx: GameContext): void {
     if (ctx.net.role === 'solo') return;
     if (ctx.net.messages('dusk').length > 0) ctx.audio.play('sfx.door');
     if (ctx.net.messages('dawn').length > 0) ctx.audio.play('sfx.key');
   }

   /** The interact system, by day only: nothing opens in the dark. */
   function byDay(ctx: GameContext): void {
     if (!sky.night) interactSystem(ctx);
   }
   ```

4. **Reset it in `init`**, beside the resets already there.

   ```ts
   init: (ctx) => {
     sky.night = false;
     sky.since = 0;
     // ...the resets already there
   },
   ```

5. **Wire it in `systems`.** The clock first, so dusk takes effect in the
   same step; `byDay` in place of `interactSystem`; the sound on each page.

   ```ts
   systems: [
     nightCycle,
     paintPlayers,
     locomotionSystem,
     byDay,
     dialogueSystem,
     updateHud,
     { run: hearTheSky, on: 'client' },
   ],
   ```

   With `multiplayer` declared, a bare function runs on the authority, so
   `nightCycle` and `byDay` decide for the whole room; without it, the one
   page runs everything.

## Verify

```sh
npm test
npm run dev
```

The tests still pass: each one plays well under two minutes, so it never gets
dark. In the page, open a chest within the first two minutes: it opens. Wait
for dusk (the door sound in a room), and `E` at the other chest does nothing
until dawn, thirty seconds later. In a room, the Browse rooms list shows the
room as `day` or `night`. For a quick look, set `daySeconds: 10` and restart.

## See also

- [Add a lobby](./add-a-lobby.md): the same wrapper idea, holding systems back until the start
- [Send a message](./send-a-message.md): `send` and `messages` on their own
- [Multiplayer](../concepts/multiplayer.md): roles, `ctx.net.setPhase`, and what a client may do
- `templates/survive/src/systems/clock.ts`: the same clock, with creatures at dusk and a night count at dawn
