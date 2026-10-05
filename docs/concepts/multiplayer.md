# Multiplayer

A game turns multiplayer on in `src/game.ts`:
`features: { multiplayer: { maxPlayers: 6 } }`. The same game then runs as a
room on a server or as Play Solo in one page; without the feature it is
single-player, as before.

## The model

One guest runs the game: the **authority**. On the room server it is the
game's wasm guest (or, with `gameable serve --direct`, `src/game.ts` as-is, in
one room) on a headless engine with its own Jolt world and the level's
static colliders. It ticks at 60 Hz and is the only place the simulation runs.
Players' pages send input and messages up; they never send a transform.

[Colyseus](https://colyseus.io) hosts the rooms. `gameable serve` runs
`createRoomServer` from `gameable/rooms/server`, with one Colyseus room class
that hosts the engine room. Colyseus does the matchmaking, seat reservation,
the WebSocket and the reconnection token; the room server adds four-letter room
codes, origin checks and at most 8 rooms per process. Every byte of
replication is the engine's own (`gameable/net`). A page reaches the server
at `<page origin>/services/rooms/`.

Each player gets their own **view**:

- a `welcome` when they join or reconnect: the whole world as it is now;
- a `cmd` frame every tick: the commands that changed their world, the
  messages sent to them, and `entity`, the entity they control;
- transform rows `sendHz` times a second (20 by default), which the page blends
  one send interval behind the newest.

Commands queued inside `ctx.net.local(fn)` never leave the authority.
`ctx.net.send(name, payload, { to })` reaches one player, or everyone without
`to`. The authority can also set one player's own camera and HUD.

Seats are ids from 0, the lowest free first. The first player to join is
`ctx.players.host` until they leave. A host whose link drops counts as gone for
this alone: while the room holds their seat, the lowest seat that is connected
and not held is host, and it stays host when they come back. A held seat's
input reads as neutral (no key down, no press, no mouse) until it is back. `definition.player` spawns one entity per
joining player, and `ctx.players.get(id).possess(entity)` hands a player
another one.

## Messages

A message is a small JSON payload a player sends up, or the authority sends to
one player or all of them. Declare each one once, at module scope, with the
game's own type guard:

```ts
import { defineMessage, hasKeys } from 'gameable';

const hasFor = hasKeys('for');
export const Vote = defineMessage(
  'vote',
  (p): p is { for: number } => hasFor(p) && Number.isInteger(p.for),
  { maxBytes: 64 },
);

function countVotes(ctx: GameContext): void {
  const votes = ctx.net.messages(Vote);
  for (let i = 0; i < votes.length; i += 1) {
    tally(votes[i].player, votes[i].payload.for); // payload is { for: number }
  }
}
```

`ctx.net.messages(def)` returns this tick's messages with that name, in
arrival order, as `{ player, payload }`. On the authority `player` is the
sender's seat; on a client it is `AUTHORITY_SENDER`. A payload is dropped,
never handed to a system, when its JSON is over `maxBytes` (default 2,048, the
wire cap), does not parse, or fails the check (a check that throws fails).
`ctx.net.stats.dropped` counts what the guest refused and
`ctx.net.stats.received` the deliveries, from `init`. A payload over 2,048
bytes never reaches the guest: the room drops it and counts it per player, so
`dropped` sees only payloads over a smaller `maxBytes`, or failing the check. The list and its entries are pooled and refilled
each tick, so read them inside the tick and never keep them.

`ctx.net.send(def, payload, { to, reliable })` checks the payload with the
same guard and cap before it leaves. A payload that fails is not sent: it
counts in `ctx.net.stats.unsent` and is logged once, never thrown, because a
throwing system fails the tick and enough failed ticks stop the game.

- **The check must be pure.** No clock, no `Math.random`, no game state: the
  authority and every replay must drop the same messages.
- **One definition per name.** A second `defineMessage` with the same name
  throws; `init` starts the names afresh, so a reloaded module can define them
  again.
- **`aos:` is the engine's.** `defineMessage` throws on a name starting with
  `aos:`, `send` refuses one, and a room drops one a client sends.
- **Make `hasKeys` guards once**, at module scope as above: the guard it
  returns allocates nothing, but making one does.
- **Bare names are deprecated.** `ctx.net.messages<T>('vote')` and
  `ctx.net.send('vote', payload)` still work, unchecked and capped at 2,048
  bytes. Once a name's definition has been read, the bare read of that name
  is checked too.

## Roles

`ctx.net.role` says where a guest runs:

| Role        | Where                                      | Systems that run               |
| ----------- | ------------------------------------------ | ------------------------------ |
| `solo`      | a game without `multiplayer`               | all of them                    |
| `authority` | the room's engine                          | `on: 'authority'` and `'both'` |
| `client`    | each player's page, beside the client loop | `on: 'client'` and `'both'`    |

A system is a function or `{ run, on }`. With `multiplayer` declared, a bare
function is `'authority'`; without it, `'both'`.

## What a client system may do

A client system is for presentation. It may read its player's `ctx.input` and
`ctx.localPlayer`, read `ctx.net.messages(def)` from the authority, call
`ctx.net.send` (it always goes up to the authority), and set the HUD and camera,
play sounds and spawn entities of its own, all on its page only.

It may not change the shared world. A client runs no level `spawns`, its
physics commands are dropped (except its own predicted body, below), and a
camera or HUD the authority sets for this player wins over its own. Its ECS
holds only its own entities, so it cannot read the replicated world's
`Transform`.

## Prediction

By default a player's own character moves when the authority's rows come
back: a round trip after the key goes down. With
`features: { multiplayer: { maxPlayers: 6, predict: true } }` the page moves
it on the same step instead. Everyone else is still drawn one send interval
behind, as before.

How it works:

- The page registers `physics()` again, holding only the level's static
  colliders and one character body.
- The client guest runs the game's movement for its own player only, on a
  character body it spawns for itself. That body (the first `kind: 'character'`
  body the client guest adds) is the only physics the page takes from it;
  every other physics command is still the authority's and is dropped.
- Each fixed step the page keeps the move and where the body ended up, by
  input `seq`, for the last 64 steps, and draws this player's entity there.
- Each rows frame ends with this player's body as the authority had it
  (position, velocity, grounded) and the input `seq` it had applied. When the
  page's position for that `seq` is more than 2 cm away, the page puts the body
  where the authority says and replays the later steps. F3's `net` line counts
  these as `corrections`.
- A teleport (a respawn) moves the body without counting a correction, and a
  reconnect starts the record again.

The movement system is one system with `on: 'both'`. On the authority it walks
every player's entity; on the client it walks only `ctx.localPlayer`, on the
body the client spawned:

```ts
let own = 0; // reset it in init

function movement(ctx: GameContext): void {
  if (ctx.net.role === 'client') {
    const me = ctx.localPlayer;
    if (me === null) return;
    if (own === 0) own = ctx.spawn(HeroBody, start); // this page's own, never shared
    walk(ctx, own, me.input);
    return;
  }
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].entity !== 0) walk(ctx, list[i].entity, list[i].input);
  }
}

export default defineGame({
  features: { multiplayer: { maxPlayers: 6, predict: true } },
  systems: [{ on: 'both', run: movement }],
});
```

Limits. Only the body's position is predicted: its facing and animation still
come from the authority's rows. Both sides must move the body the same way:
the same body shape, the same speeds and the same physics options, or every
step is a correction. Only `move-character` is predicted; a push, an impulse
or another body is the authority's and arrives as a correction.

## Play Solo

A multiplayer game opened with no room plays solo: the authority runs in the
page too (`gameable/net/solo`), as the built wasm guest on its own headless
engine, over our own room on a loopback. Colyseus is not loaded. Run
`npm run build:guest` first, and again after each change to the game's rules:
the page's own client systems run your sources as they are, the authority runs
the build. Under `npm run dev` the page warns when the build is older than the
sources.

## When the page stops

A page joins only once it has loaded (its level, characters and sandbox), and
gives its seat up at once if the boot fails. When the tab is hidden or loses
focus it lets go of its keys straight away, so its player stops instead of
running on. A tab left in the background keeps a few seconds of frames and asks
for a fresh world when it comes back. Two seconds with nothing from the room
means a dead link: the page shows "Reconnecting" and resumes its seat.

## The URL modes

| Address       | What happens                                 |
| ------------- | -------------------------------------------- |
| no `?room=`   | Play Solo                                    |
| `?room=CODE`  | join that room                               |
| `?room=new`   | make a room, then show its code              |
| `?room=quick` | join any open room of this game, or make one |

After a new room or a quick match, the address becomes `?room=CODE`, so a
reload keeps the seat. On a local page `?rooms=<url>` points at another room
server, such as `gameable serve`'s. The game's name on the server is its
`package.json` name without the npm scope (`catalogName`).

## Browsing rooms

The room badge has a "Browse rooms" button, shown when the page can reach a
room server (on a solo page, with "Play with friends"). It lists this game's
public rooms with their code, players and phase, and a Join for each (a full
room's is off), plus New room and Quick join. Private rooms are never listed;
their code still joins them. The list is live while the panel is open, and the
room server client loads only when it opens. The authority says the phase
with `ctx.net.setPhase('playing')`: 1 to 32 letters, digits or dashes, sent
only when it changes, so calling it every tick is free. It travels as the
reserved message `aos:phase`, which the room server lists and never forwards
to a player. On a client, and in a game without `multiplayer`, it does
nothing.

With `debug` on, F3's overlay shows a `net` line: the state, the room code,
players, rtt, rows per second, stale rows, corrections and your entity.

## See also

- [Play with friends](../recipes/play-with-friends.md): the recipe
- [The wasm boundary](./wasm-boundary.md): what the guest is
- `packages/sdk/README.md` — `ctx.players` and `ctx.net`
