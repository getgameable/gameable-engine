# Send a message

## Goal

A player presses `V` to wave. The page sends a `wave` message up to the
room's authority, the authority answers everyone with `waved` and the seat
that waved, and every page plays a sound: a little louder for your own wave.
It is the whole round trip a multiplayer game uses for anything a player asks
for: declare the message once, read it on the authority, answer it.

This builds on [Play with friends](./play-with-friends.md): the game already
declares `multiplayer`.

## Files you will edit

- `src/game.ts`

## Steps

1. **Declare both messages**, at module scope in `src/game.ts`, below the
   imports. Add `defineMessage` and `hasKeys` to the file's `gameable`
   import, which already brings `defineGame` and `type GameContext`. Each
   message names its payload and checks it; a payload that fails the check
   never reaches a system, and `ctx.net.stats.dropped` counts it.

   ```ts
   /** Up: this player waves. The sender is the message's `player`, never the payload. */
   const Wave = defineMessage('wave', (p): p is null => p === null, { maxBytes: 8 });

   const hasPlayer = hasKeys('player');
   /** Down: who waved. */
   const Waved = defineMessage(
     'waved',
     (p): p is { player: number } => hasPlayer(p) && Number.isInteger(p.player),
     { maxBytes: 32 },
   );
   ```

   Make `hasKeys` guards once, at module scope, as here: the guard allocates
   nothing per call, but making one does.

2. **Send it from the page's guest.** A system that runs on the client reads
   this player's keys and sends up. On a client `ctx.net.send` always goes to
   the authority.

   ```ts
   /** Client: V asks to wave. */
   function askToWave(ctx: GameContext): void {
     if (ctx.input.pressed('KeyV')) ctx.net.send(Wave, null);
   }
   ```

3. **Read it on the authority and answer.** `ctx.net.messages(Wave)` is this
   tick's checked waves, in arrival order, each with the seat that sent it.
   The answer goes to everyone; pass `{ to: player }` to answer one player
   only. The payload object is reused: `send` serialises it at once.

   ```ts
   /** The answer's payload, reused for every wave. */
   const waved = { player: -1 };

   /** Authority: tell everyone who waved. */
   function answerWaves(ctx: GameContext): void {
     const waves = ctx.net.messages(Wave);
     for (let i = 0; i < waves.length; i += 1) {
       waved.player = waves[i].player;
       ctx.net.send(Waved, waved);
     }
   }
   ```

4. **Hear the answer on every page.**

   ```ts
   /** Client: a wave plays a sound; your own, louder. */
   function hearWaves(ctx: GameContext): void {
     const heard = ctx.net.messages(Waved);
     for (let i = 0; i < heard.length; i += 1) {
       const mine = heard[i].payload.player === ctx.net.localPlayer;
       ctx.audio.play('sfx.talk', { volume: mine ? 1 : 0.5 });
     }
   }
   ```

5. **Say where each one runs.** In `defineGame`, add the three to `systems`,
   each with its side:

   ```ts
   systems: [
     paintPlayers,
     locomotionSystem,
     interactSystem,
     dialogueSystem,
     updateHud,
     { run: askToWave, on: 'client' },
     { run: answerWaves, on: 'authority' },
     { run: hearWaves, on: 'client' },
   ],
   ```

## Verify

```sh
npm test
npm run dev
```

Open a room in two tabs, as in [Play with friends](./play-with-friends.md).
Press `V` in one: both tabs play the sound, the one that waved louder. A
message whose payload fails its check, or is over `maxBytes`, is dropped
before `answerWaves` sees it. Alone (no `?room=`) you hear your own wave:
Play Solo is a room of one, with its authority in the page.

## See also

- [Add a lobby](./add-a-lobby.md): a message that changes what the room does
- [Multiplayer](../concepts/multiplayer.md#messages): the message rules in full
- `templates/mystery/src/messages.ts`: `ready`, `start`, `vote` and `chat` in a real game
