# Add a vote

## Goal

In the mystery kit a vote opens only after a tag-out. Add an emergency
meeting, as in Among Us: any player still in the round presses `M` to call a
vote at once, once a round each. The vote that opens is the kit's own, with
its majority and its timeout; only what opens it is new.

This builds on the mystery kit (`npm create gameable my-game -- --template mystery`).

## Files you will edit

- `src/systems/vote.ts`
- `src/systems/controls.ts`

## Steps

1. **Declare the message and who has called one**, in `src/systems/vote.ts`.
   Replace its `gameable` import with one that also brings
   `defineMessage`, add `MAX_SEATS` to its `../round` import, and put this
   below the imports. The lane is one byte per seat, sized once, and it is
   cleared whenever a new round is dealt (`round.dealtAt` changes).

   ```ts
   import { defineMessage, type GameContext } from 'gameable';

   /** Up: M calls an emergency meeting. */
   export const Meeting = defineMessage('meeting', (p: unknown): p is null => p === null, {
     maxBytes: 8,
   });

   /** 1 for a player who has called their meeting this round. */
   const called = new Uint8Array(MAX_SEATS);
   /** The deal `called` belongs to. */
   let calledFor = -1;

   /**
    * Open a vote for the first player still in who has not called one yet.
    *
    * @param ctx The frame context.
    */
   function meetings(ctx: GameContext): void {
     if (calledFor !== round.dealtAt) {
       called.fill(0);
       calledFor = round.dealtAt;
     }
     const calls = ctx.net.messages(Meeting);
     for (let i = 0; i < calls.length; i += 1) {
       const player = calls[i].player;
       if (!round.alive(player) || called[player] === 1) continue;
       called[player] = 1;
       openVote(ctx);
       return;
     }
   }
   ```

2. **Take the calls while the round is live**, at the top of the `vote`
   system in the same file, before its phase check:

   ```ts
   export function vote(ctx: GameContext): void {
     if (round.phase === PHASE_LIVE) meetings(ctx);
     if (round.phase !== PHASE_VOTE) return;
     // ... the rest of the system as it was
   }
   ```

   The vote system already runs on the authority, so the meeting does too:
   a page cannot open a vote by itself, only ask.

3. **Send `M` from the page**, in `src/systems/controls.ts`. Import the
   message and add one line beside `R` and `G`:

   ```ts
   import { Meeting } from './vote';

   // inside controls(ctx), after the KeyG line:
   if (ctx.input.pressed('KeyM')) ctx.net.send(Meeting, null);
   ```

## Verify

```sh
npm test
npm run build:guest
npx gameable serve --direct
```

Open a room in three tabs, as in [Play with friends](./play-with-friends.md),
and start a round. Press `M` in one tab: every HUD shows the vote at once,
with nobody tagged. Press `M` again in that tab next time the round is live:
nothing, it was their one meeting. A player who is out, or watching, cannot
call one.

## See also

- [Add a lobby](./add-a-lobby.md): the `R` and `G` messages this sits beside
- [Send a message](./send-a-message.md): declaring a message and its check
- `src/systems/vote.ts` in the mystery kit: the vote the meeting opens
