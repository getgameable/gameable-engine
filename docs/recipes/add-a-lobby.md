# Add a lobby

## Goal

Nothing starts until the room is ready. Each player presses `R` when they are
ready (again to take it back); once every connected player is ready, the
round starts and the chests unlock. The host (`ctx.players.host`) can press
`G` to start at once. Until then players can walk the arena, but `E` does
nothing: no chest, no door, no talk. Everyone hears the start.

This builds on [Play with friends](./play-with-friends.md): the game already
declares `multiplayer`.

## Files you will edit

- `src/game.ts`
- `tests/roomHarness.ts`

## Steps

1. **Declare the messages and the lobby's state**, at module scope in
   `src/game.ts`, below the imports. Add `defineMessage` to the file's
   `gameable` import, which already brings `defineGame` and
   `type GameContext`. The ready set is one byte per seat, sized once, so the
   systems below allocate nothing.

   ```ts
   const isNull = (p: unknown): p is null => p === null;
   /** Up: R toggles this player's ready. */
   const Ready = defineMessage('ready', isNull, { maxBytes: 8 });
   /** Up: G, from the host, starts now. */
   const Start = defineMessage('start', isNull, { maxBytes: 8 });
   /** Down: the round started. */
   const Started = defineMessage('started', isNull, { maxBytes: 8 });

   /**
    * The fewest players a round starts with. One, so Play Solo (a room of
    * one, its authority in the page) can start; a game that needs company
    * raises it.
    */
   const MIN_PLAYERS = 1;
   /** Seats: `features.multiplayer.maxPlayers`. */
   const SEATS = 6;
   /** 1 for a ready seat. */
   const ready = new Uint8Array(SEATS);
   /** The lobby is over. */
   const lobby = { started: false };
   ```

2. **Send `R` and `G` from the page.**

   ```ts
   /** Client: R toggles ready; G asks to start now. */
   function readyKey(ctx: GameContext): void {
     if (ctx.input.pressed('KeyR')) ctx.net.send(Ready, null);
     if (ctx.input.pressed('KeyG')) ctx.net.send(Start, null);
   }
   ```

3. **Keep the ready set and the start rule on the authority.** A seat that is
   left or taken is not ready: whoever sits there next says so themselves, so
   read the `player-joined` and `player-left` events, not the seat. Only the
   host's `start` counts. A guest with the `solo` role (the headless tests,
   `npm test`) has nobody to wait for.

   ```ts
   /** Authority: the ready set, and the start once everyone is ready. */
   function lobbySystem(ctx: GameContext): void {
     if (lobby.started) return;
     if (ctx.net.role === 'solo') {
       lobby.started = true;
       return;
     }
     const events = ctx.events;
     for (let i = 0; i < events.length; i += 1) {
       const e = events[i];
       if (e.tag === 'player-joined' || e.tag === 'player-left') ready[e.val.player] = 0;
     }
     const readies = ctx.net.messages(Ready);
     for (let i = 0; i < readies.length; i += 1) {
       const id = readies[i].player;
       if (id >= 0 && id < SEATS) ready[id] = ready[id] === 1 ? 0 : 1;
     }
     let forced = false;
     const starts = ctx.net.messages(Start);
     for (let i = 0; i < starts.length; i += 1) {
       if (starts[i].player === ctx.players.host) forced = true;
     }
     let seated = 0;
     let all = true;
     for (let id = 0; id < SEATS; id += 1) {
       if (ctx.players.get(id)?.connected !== true) continue;
       seated += 1;
       if (ready[id] !== 1) all = false;
     }
     if (seated < MIN_PLAYERS || !(all || forced)) return;
     lobby.started = true;
     ctx.net.send(Started, null);
   }
   ```

   `ctx.players` is read by id with `get`, never iterated: a `Map` iterator is
   an allocation every tick. The host is the first player to join, until they
   leave or their link drops; then it moves to the lowest seat whose link is up.

4. **Hold back what waits for the start, and hear it.** A wrapper made once at
   module scope runs a system only after the lobby; locomotion keeps working,
   so players can walk around while they wait.

   ```ts
   /**
    * @param system A system that waits for the lobby.
    * @returns The same system, idle until the round starts.
    */
   function afterLobby(system: (ctx: GameContext) => void): (ctx: GameContext) => void {
     return (ctx) => {
       if (lobby.started) system(ctx);
     };
   }

   /** Client: the start plays a sound. */
   function hearStart(ctx: GameContext): void {
     if (ctx.net.messages(Started).length > 0) ctx.audio.play('sfx.door');
   }
   ```

5. **Wire it in `defineGame`.** Reset the lobby in `init`, and put the systems
   in order: the lobby first, so a start takes effect in the same tick.

   ```ts
   init: (ctx) => {
     ready.fill(0);
     lobby.started = false;
     // ...the resets already there
   },

   systems: [
     lobbySystem,
     paintPlayers,
     locomotionSystem,
     afterLobby(interactSystem),
     afterLobby(dialogueSystem),
     updateHud,
     { run: readyKey, on: 'client' },
     { run: hearStart, on: 'client' },
   ],
   ```

   With `multiplayer` declared, a bare function runs on the authority, so
   `lobbySystem` and the wrapped `interactSystem` and `dialogueSystem` run
   there. Both are wrapped because both read `E`: one opens chests and doors,
   the other starts a talk.

6. **Ready everyone in the room tests.** `tests/room.test.ts` plays the
   adventure on a room's authority, where nobody presses `R`, so the lobby
   would hold every chest shut. In `tests/roomHarness.ts`, have every seat
   send `ready` on the step after the joins:

   ```ts
   // The lobby (docs/recipes/add-a-lobby.md): every seat is ready on the second step.
   const readies: GameEvent[] = inputs.map((_, player) => ({
     tag: 'message',
     val: { player, name: 'ready', payload: 'null' },
   }));
   ```

   Put it below `joins` in `bootRoom`, and change the step's events to
   `events: frame === 0 ? joins : frame === 1 ? readies : []`.

## Verify

```sh
npm test
npm run dev
```

Open a room in two tabs, as in [Play with friends](./play-with-friends.md).
`E` does nothing, at a chest or beside the guide. Press `R` in one tab: still
nothing. Press `R` in the other: both tabs play the start sound, and the
chests open. Or close the tab that was not ready instead: the room holds a
closed tab's seat in case it comes back, so the round starts once the seat is
freed, about 30 s after the tab closes, or at once if the host starts it with
`G`. Alone (no `?room=`) it is a room of one: `R` starts it. The template's
other tests are unchanged, because a `solo` guest skips the lobby.

## See also

- [Send a message](./send-a-message.md): the round trip on its own
- [Multiplayer](../concepts/multiplayer.md): roles, `ctx.players`, and what a client may do
- `templates/mystery/src/systems/ready.ts`: the same rule with a host who can start early, and a HUD line for every player
