# Gameable Engine mystery kit

A multiplayer hidden-role round for three to six players, out of the box:
everyone wears the sample character in the placeholder arena; in the lobby
each player presses R when ready; when everyone connected is ready (or the
host presses G), the authority secretly picks who is "it" with the seeded
`ctx.rng` and tells only them, through their own HUD. After three seconds of
grace, "it" touching another player tags them out, and a vote follows: the
players still in press 1-6 for the seat they think is "it", and a majority
puts that player out. The crew wins by voting every "it" out, or by lasting
until the clock runs out; "it" wins when no crew is left. Enter opens a chat
line; while a round runs, a ghost (a player who is out, or watching) is
heard only by the other ghosts, as in Among Us.

```sh
npm install
npm run build:guest          # Play Solo's authority is the built wasm guest
npm run dev                  # http://localhost:5192: Play Solo, a walk around the arena
npm test                     # the round, driven headlessly as the authority
```

## Play it with friends

One player cannot tag anyone, so the game is two tabs or more. In a second
terminal, beside `npm run dev`:

```sh
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5192/?room=new&rooms=http://localhost:8790`. The
corner shows a four-letter code and **Copy link**; open the link in a second
and a third tab, press R in each, and the round starts. `--direct` reads
`src/game.ts` once: restart it after an edit. `?room=CODE` joins a room,
`?room=new` makes one and `?room=quick` joins any open one. See the
`play-with-friends` recipe.

## What to change first

Every number worth changing is in the `rules` block of `src/game.ts`. The
three that change the game most:

```ts
rules: {
  roundSeconds: 180, // how long a round lasts, votes included; the crew wins when it runs out
  its: 1,            // how many players are "it"; two or more know each other
  tagRadius: 0.9,    // how close "it" has to get, centre to centre, in metres
  ...
},
```

- **`roundSeconds`**: shorter is tenser for "it", longer gives "it" time to
  pick the crew off one by one. The clock is the `time` line on every HUD.
- **`its`**: with 2, both "it"s see each other in their HUD (`with`), cannot
  tag each other, and the crew must vote both out. A room always keeps at
  least one crew member, so three players never get more than two "it"s.
- **`tagRadius`**: two capsules touch at 0.7 m. Over about 1.5 m, "it" tags
  through a near miss; under 0.7 m, nobody can be tagged.

After a change, run `npm test` (the tests pin the shipped values in
`SHIPPED_RULES`, `tests/room.ts`, and `tests/rules.test.ts` checks what each
rule does), then `npm run build:guest` (Play Solo) and
restart `npx gameable serve --direct` (rooms). The other rules are
`minPlayers` (3), `graceSeconds` (3), `voteSeconds` (30), `walkSpeed`,
`runSpeed`, `cameraDistance` and `cameraHeight`.

Beyond that, in rough order of effort: an emergency meeting any player can
call (the `add-a-vote` recipe), a new message (`send-a-message`), and a
bigger room (`maxPlayers` in `src/game.ts` and `MAX_PLAYERS` in
`src/round.ts`; past six, the vote keys 1-6 in `src/systems/controls.ts` run
out).

## How it works

The game's whole shape is in `src/game.ts`:

```ts
export default defineGame({
  features: { characters: true, multiplayer: { maxPlayers: 6 } },
  player: { prefab: Crew, spawn: [0, 1, 0], camera: 'thirdPerson' },
  systems: [
    { run: readyUp, on: 'authority' }, // the lobby: R from everyone, or the host's G
    { run: move, on: 'authority' }, // every player's body and camera
    { run: leavers, on: 'authority' }, // a player gone mid-round is out
    { run: tag, on: 'authority' }, // an overlap-sphere around each "it"; a tag-out opens a vote
    { run: vote, on: 'authority' }, // a majority puts that player out
    { run: chat, on: 'authority' }, // echoed with the sender's name; ghosts only to ghosts
    { run: roundHud, on: 'authority' }, // each player's HUD: role, alive, time, votes, chat
    { run: listing, on: 'authority' }, // the room list's phase: lobby, playing or voting
    { run: controls, on: 'client' }, // R, G and 1-6 become messages; a tag plays a sound
  ],
});
```

It is the smallest game that needs each part of the SDK's room API:
`features.multiplayer` and systems that say where they run; `ctx.players`
and `ctx.playerEntity(id)`; a player's own HUD (`players.get(id).hud.set`)
for what only they may see; `defineMessage` for what players send up;
`ctx.net.send` and `ctx.net.messages`; and `ctx.rng` for the deal, so the
same seed deals the same round. With no `?room=` the page plays solo: the
authority runs in the page too (`gameable/net/solo`), and the page is its
client, exactly as it would be a room server's.

## What is here

| File                      | What it holds                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/game.ts`             | The definition: features, the player block, rules, the system order.                                                          |
| `src/round.ts`            | The round's state on the authority: who is ready, who is "it", who is in, who is out.                                         |
| `src/ballot.ts`           | The open vote: one pick per voter, and the count of refused votes.                                                            |
| `src/messages.ts`         | The `ready`, `start`, `vote` and `chat` definitions and their checks.                                                         |
| `src/chat.ts`             | The chat cap (120 characters), the cleaning, and the last three lines.                                                        |
| `src/systems/ready.ts`    | The lobby: the ready set and the start rule; the host's early start.                                                          |
| `src/systems/pickIt.ts`   | Dealing a round: `rules.its` "it"s from `ctx.rng`, everyone onto a ring.                                                      |
| `src/systems/tag.ts`      | Tagging; a tag-out opens a vote, no crew left or the clock ends the round.                                                    |
| `src/systems/vote.ts`     | The vote: refused votes, the majority, the timeout.                                                                           |
| `src/systems/listing.ts`  | The room list's phase (`ctx.net.setPhase`): `lobby`, `playing` or `voting`.                                                   |
| `src/systems/end.ts`      | The end of the round, and players who leave it.                                                                               |
| `src/systems/chat.ts`     | Chat on the authority: clean, cap, echo with the name; a ghost's line reaches only ghosts.                                    |
| `src/systems/move.ts`     | Camera-relative walking for every seat (solo: for `ctx.player`).                                                              |
| `src/hud.ts`              | When each player's HUD redraws; `src/hudModel.ts` is what it says.                                                            |
| `src/systems/controls.ts` | The client half: R, G and 1-6.                                                                                                |
| `src/chatPrompt.ts`       | Page code: Enter opens the chat line and sends it.                                                                            |
| `src/physicsOptions.ts`   | The physics options the page uses. `src/game.ts` re-exports them, so a room server finds them in the module it already loads. |

Messages the authority sends to everyone: `round` `{ players, its }` (how
many "it"s, never who), `tagged`
`{ player, alive }`, `vote-open` `{ alive }`, `vote-over` `{ out, alive }` (`out` is
-1 when nobody was), `chat` `{ player, name, text }` (a ghost's line goes `to`
each ghost instead) and `round-over`
`{ its, winner }`, where `its` lists every "it"'s seat and `winner` is `'it'`
or `'crew'`.

Clients send `ready` (`null`, toggles), `start` (`null`, the host only),
`vote` (`{ for: seat }`) and `chat` (`{ text }`). A vote from a player not
still in the round, or for one, is refused and counted in
`round.ballot.rejected`: that is the game's rule, so the game counts it.
`ctx.net.stats.dropped` counts only payloads that fail a message's check.

Keys: R ready, G start now (host, three or more), 1-6 vote for that seat,
Enter chat.

## Gotchas

- **The secret lives in one HUD.** Who is "it" is never broadcast. A client
  only learns it if it is "it", or when the round is over. Do not add it to a
  `send`; `vote-over` names who was voted out, never whether they were
  "it" (voting the last "it" out ends the round instead).
- **Chat is plain text.** The authority strips control and direction
  characters and caps the line; the HUD draws it with `textContent`. Never put
  a line into `innerHTML` in a custom HUD.
- **Names are not unique.** Every page joins as "You" for now, so the HUD
  shows the seat beside a name (`#2 You`), and the vote keys are the seats.
- **Everyone spawns on the same point.** `definition.player` has one spawn
  point. The deal teleports everyone onto a ring, and the grace period covers
  the tick before the teleport lands.
- **`ctx.players` is read by id, never iterated.** A `Map` iterator is an
  allocation every tick. The systems loop over the seat ids with `get`.
- **Play Solo needs the wasm guest, even under `npm run dev`.** The page's
  own client guest is direct in dev, and two direct guests in one realm share
  the SDK's component arrays, so the in-page authority always runs the built
  guest. Rebuild it (`npm run build:guest`) after every change to the game:
  otherwise the authority runs the old rules while the page runs the new
  ones. The dev page checks and says so, in the console and in a banner at
  the top ("the authority is running STALE rules"). Without any built guest
  the page also says "Play Solo could not start its authority".
- **A failed join says why** in the corner: `full`, `no-room`, `origin`,
  `capacity` and so on (`net.closeReason`).
- **A seat is not a player.** Seats are reused, sometimes in the frame they are
  freed. The round reads `player-left` events, not empty seats, so a newcomer
  never inherits a leaver's place in the round.
- **The catalog name is your package's name** without its scope
  (`src/session.ts`): `npx gameable serve` registers the game under it, and
  the page joins under it.
- **Physics options come from one module.** Change gravity in
  `src/physicsOptions.ts`. Play Solo's authority (`src/solo.ts`) and the room
  server read the same module; the page itself runs no physics.
