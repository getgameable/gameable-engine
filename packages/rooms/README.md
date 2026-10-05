# gameable/rooms

## What

Multiplayer rooms on [Colyseus](https://colyseus.io): one Colyseus room class, `GameableColyseusRoom`, hosts any game's authoritative `RoomGame` (from `gameable/net/server`, usually `createEngineRoomGame`). Colyseus does matchmaking, seat reservation, the WebSocket and reconnection tokens; every byte of replication is ours: the same welcome, `cmd`, `msg`, `players`, rows and INPUT frames `gameable/net` defines, each behind one Colyseus byte.

Everything in the repository that touches `@colyseus/*` lives in this package.

- `gameable/rooms`: the wire channels both sides share. Imports nothing.
- `gameable/rooms/server`: `createRoomServer` (the room server: catalog, codes, origins, room cap, lobby, `/health`), `GameableColyseusRoom`, `GameableSerializer`, `GameableWire`, `SeatMap`, `RoomIntake`, and the room's parts `RoomReplication`, `RoomSeating` and `RoomInbound`.
- `gameable/rooms/client`: the page side. `multiplayer()` (the `multiplayer` feature with a `ColyseusConnection` as its default), `ColyseusConnection` (a `RoomConnection` on `@colyseus/sdk`), `GameableClientSerializer`, `roomsEndpoint`, the seat's token and lock (`SeatClaim`, `SeatTokens`, `SeatLocks`), and `listRooms`, a game's public rooms, live.

## When to use

You are hosting multiplayer games in Node (`/server`), or a page joins them (`/client`, which `gameable/host/features` loads for a game that declares `multiplayer`). A game never imports this package: it uses `ctx.players` and `ctx.net` from `gameable`, and the same game runs single-player, Play Solo (our own `Room` over a loopback, no Colyseus) or in a Colyseus room.

## Install

```sh
npm install --save-exact gameable
```

## Minimal example

```ts
import { createRoomServer, engineGame } from 'gameable/rooms/server';

import game from './game.js'; // defineGame({ features: { multiplayer: { maxPlayers: 8 } }, ... })
import { guest } from './guest.js'; // the same game built to wasm: { guestModuleUrl, getCoreModule }

const server = createRoomServer({
  port: 8790,
  host: '0.0.0.0',
  origins: ['https://play.example', 'http://localhost:*'],
  games: { party: engineGame({ definition: game, guest, manifest: './assets.json', seed: 7 }) },
});
const port = await server.listen();
// GET /health -> { ok: true, rooms: 0, players: 0, uptime: 0.01, games: ['party'] }
// A page: new Client(url).create('party', { name: 'Ana' }); a friend: client.joinById(code, { name: 'Ben' })
```

The page side, which `clientFeatures()` loads by itself for a game that declares `multiplayer`:

```ts
import { multiplayer } from 'gameable/rooms/client';

// https://play.example/party/?room=KQTX joins KQTX; ?room=new makes a room; ?room=quick (or no ?room=) is a quick match.
const feature = await multiplayer({ game: 'party', name: 'Ana', maxPlayers: 8 });
// feature.modules: the `net` module. The page's client loop starts the join once it is attached
// (net/client's attachRoomClient); after the welcome, engine.get('net').room is the code to share.
```

Without the server, one game on a bare Colyseus `Server` is `server.define('party', GameableColyseusRoom, { entry })`, with an `GameableRoomEntry` (below): no codes, origin checks, cap or health.

## API

`gameable/rooms` exports the channels: `ROOM_STATE` (14, the byte before our welcome), `ROOM_STATE_PATCH` (15, before every other server frame), `TEXT_FIRST_BYTE` (`{`, tells a text frame from a rows frame), `SERIALIZER_ID` (`'aos'`), the client's `sendBytes` types `INPUT_TYPE` (`'i'`) and `TEXT_TYPE` (`'t'`), and `IDENTITY_TYPE` (`'id'`), the Colyseus message that hands a page a fresh device token.

`gameable/rooms/server`:

- `createRoomServer({ port, host?, origins, games, maxRooms?, leaveAfterMs?, presence?, limits?, trustProxy?: hops, identities? })` returns a `RoomServer`: `listen()` resolves to the bound port, `close()` closes every room and stops listening, `health()` returns `{ ok, rooms, players, uptime, games }` (players counts held seats; uptime is in seconds; games is the catalog, by name), the same JSON `GET /health` serves. Defaults: `host` `127.0.0.1`, `maxRooms` 8, `leaveAfterMs` 30,000, Colyseus's local presence. Each game is defined once as `GameableColyseusRoom`, `filterBy(['code'])`, with realtime listing, and `lobby` is Colyseus's `LobbyRoom`, capped at one live instance (a second `create('lobby')` gets 409; `joinOrCreate('lobby')` joins it). `listen()` rejects with the bind's error (`EADDRINUSE`...) and leaves nothing installed; once bound it installs process handlers that log an unhandled rejection or uncaught exception and keep running, and `close()` removes them. `ok` is false after `close()`, and from the first room that fails to build because the process's physics is broken (`Aborted(`, `module "physics" failed to init`): the orchestrator should replace the process. `GET /health` answers 200 while `ok` and 503 when not, with the same body, because the container's `HEALTHCHECK` and the reverse proxy in front read the status, not the body. With a prebuilt `RoomCatalog` as `games`, `leaveAfterMs` still sets the hold of every game that set no `reconnectSeconds` of its own.
  - **Codes.** Every room gets four letters from `ROOM_CODE_ALPHABET` (`ABCDEFGHJKMNPQRSTUVWXYZ`), unique among the live rooms, and the code is also its room id. So `joinById(code)` joins any room, private ones included, and `join(name, { code })` joins a public one. A new room is `create(name, options)`; quick matching is `joinOrCreate(name)` with no code. A create that names a code is refused (404, "no room has the code ..."), so a `joinOrCreate` with a dead code fails instead of making a room. The listing's metadata is `{ game, code, players, maxPlayers, phase? }`, re-set on every join and leave, and on the tick after the game's `RoomGame.phase` changes (an engine game's guest says it with `ctx.net.setPhase('playing')`, a `RoomGame` subclass with `setPhase`; a phase over 32 characters is left out). Held seats count as players.
  - **Private.** The create option `private: true` keeps the room out of the lobby and out of quick matching; its code still joins it.
  - **Origins.** `OriginPolicy` takes origins (`https://play.example`) and any-port entries (`http://localhost:*`). A request with another Origin, or none, gets 403 at both doors before any room is found or made: every matchmaking POST (`RequestGate` wraps Colyseus's `controller.invokeMethod`, so `joinById` and `reconnect` too, and a live code and a dead one get the same 403) and the WebSocket upgrade (`beforeUpgrade`). `/health` is not checked.
  - **Limits** (`RequestGate`, `AddressLimits`, `limits: GateLimits`). The limit key is the client address, an IPv4-mapped address folded to IPv4 and an IPv6 address to its /64 (`addressKey`). Per key: failed lookups (`joinById`, `reconnect`, a join naming a `code`, an upgrade naming no seat this process holds) 10, then 1 per 2 s; creates 4, then 1 per 15 s; at most 2 live rooms it created (`roomsPerAddress`); at most 4 lobby sockets (`lobbySocketsPerAddress`); at most 4 live seats across every room, held seats included (`seatsPerAddress`; the 5th join gets 429, and a leave or an expired hold gives one back). Across every key, a backstop of 300 failed lookups, then 5 a second (`globalMisses`). Past any of them, 429. An upgrade to a reserved seat always passes, and so does an HTTP `reconnect` whose token holds a seat in that room (it is not charged either), so someone else's guesses never lock a player out; a wrong token is still a guess. A `joinById` whose `game` is not that room's game gets Colyseus's own "not found" (522) and is charged as a miss: in a process that hosts several games, another game's code is a wrong code. The upgrade's room path is read from the raw request line, not from `Request.url`, which is built from the client's Host header. Buckets are swept at most every 5 s, and at most 50,000 keys are held: past that, new keys share one bucket. The address is the socket's peer; behind proxies set `trustProxy` to their count (nginx alone 1, Traefik then nginx 2): the client is the entry that many places from the right of `X-Forwarded-For`. With `trustProxy` 0 and forwarding headers arriving, a warning is logged once. With `trustProxy` set, the server's port must be reachable only through those proxies: a client that reaches it directly writes its own `X-Forwarded-For`, and so chooses its own limit key on every request (the leftmost entry is used when there are fewer entries than hops). Publish the port on the proxy's network only, never with `docker run -p` on a public interface.
  - **Unclaimed creates.** A fresh room's creator has 5 s to connect (later joiners 15 s); a create nobody connects to frees its room and slot then.
  - **Cap.** A room takes a slot first thing in `onCreate`, before its game is built, and frees it when it goes. Past `maxRooms` the create is refused with `ServerError` `ROOM_CAPACITY_CODE` (503), "room server at capacity: 8 rooms (maxRooms)". A quick match still seats into a room with a free seat.
  - **Crashes.** A throw in the game's tick, a message handler, a welcome, a join or a leave (a consented one, or a held seat expiring) closes that room only: its players get `error: ended` / `crashed`, the error is logged, the game is never called again, the slot and code are freed, and every other room keeps running. Colyseus's `onUncaughtException` catches the tick and the handlers; the hooks and the welcome catch their own throws (`RoomCrash`, `RoomLifecycle`), because Colyseus calls some of them outside any try. A throwing `game.dispose` is logged and still frees the slot.
  - **Direct games.** A game without a wasm guest runs in this JS realm, and two direct rooms in one process share the SDK's state, so `createRoomServer` throws for a direct game with `maxRooms` above 1. Production rooms use the wasm guest; `maxRooms: 1` with a direct game is the dev server (`gameable serve --direct`).
- `RoomCatalog` registers each game once under a room name (`[a-zA-Z0-9_-]+`, not `lobby`). It is the one place that sets a game's seats: `CatalogGame.maxPlayers` becomes both the entry's `maxPlayers` (Colyseus's `maxClients`) and the `GameSetup` its `create({ maxPlayers })` is always given. A game that knows its own seats (`RoomGame.maxPlayers`) and disagrees is refused when the room is built.
- `engineGame({ definition, guest?, manifest, seed, ... })` is a `CatalogGame` on `createEngineRoomGame`. Pass the wasm `guest`: each room gets its own sandbox. Its seats are `roomSeats(definition)` from `gameable` (8 for `multiplayer: true`), passed explicitly, as a wasm guest requires; with a `guest` the definition is read for its features only (a host holding just `game.json` passes `{ features }`). Its rows rate is `roomSendHz(definition)` (20 unless the game declares `sendHz`; the `sendHz` option overrides it). `seed` is a number for every room, or a function called once per room. Without a `guest` the game is `direct` (see above). The engine's body table is the guest's `maxBodies` (ids 1 to `maxBodies`): an id past it is refused with one warning, never grown into; the manifest's static colliders take the ids above it. The SDK reuses freed body ids, so the live body count is what must fit.

`gameable/rooms/client`:

- `multiplayer(options)` is `gameable/net/client`'s loader with a default connection: a `ColyseusConnection` to `url`, else `roomsEndpoint(location.href)`. `game` is the catalog name (default `'game'`), `name` the player's. The page's `?room=CODE` (or `room`) joins that room, `?room=new` (or `newRoom`, with `private` to stay unlisted) makes one, and `?room=quick` or neither is a quick match; the address is read with `gameable/net/page`'s `roomMode`, the page's own parser, so a code is trimmed and upper-cased the same way everywhere. Given a `connection` (Play Solo's loopback one) it uses that and touches no Colyseus; `clientFeatures` then loads `gameable/net/client` instead, so the SDK is not downloaded.
- `roomsEndpoint(href)` is `<page origin>/services/rooms/` with https mapped to wss (http to ws). On a page served from exactly `localhost`, `127.0.0.1` or `[::1]` (not `*.localhost`), `?rooms=<url>` points elsewhere, for local development against `gameable serve`. On any other host `?rooms=` is ignored, so a shared link cannot send a player's input to a server the game did not choose.
- `createColyseusConnection({ url, game, create?, private?, storage?, deviceStorage?, portalToken?, locks?, minUptimeMs?, headers? })`:
  - **Joining.** A code is `joinById(code)`; none is `joinOrCreate(game)`; `create` is `create(game, { private })`. `room` is the code the welcome names (the server writes it right after `t`), or the room id until then.
  - **Refusals** close it with a reason (`refusalReason`): `origin` (403), `full`, `no-room` (the server has no room with that code, or the room is another game's), `no-server` (any other 404: nothing serves the room server's address), `busy` (429), `capacity` (503), `version` (426: the page and the server speak different protocol versions; reload), `expired`, else `refused` (the game's `admit` said no, among others). Every join sends `{ name, game, v: PROTOCOL_VERSION }`, plus `device` and `portal` when it has them (see Identity).
  - **Flood.** A page the room drops for going over its input or text budget gets an `error: budget` frame, then a 4002 close: the connection closes with `budget` (the last error frame's code), not the bare `error` a 4002 alone maps to.
  - **Idle.** A page the room dropped for sending no frame for its `idleSeconds` (120 by default) closes with `idle` (close code `IDLE_CLOSE_CODE`, 4100, which the SDK does not resume by itself). Its seat is held as after any drop, so a reload inside the hold gets it back by its token.
  - **Reconnecting.** A dropped link is the SDK's own resume with its reconnection token: `reconnecting`, then `open` again when the fresh welcome arrives (never at the SDK's `onReconnect`, which comes first), with the same seat and entity. `minUptimeMs` defaults to 0, so every drop resumes, with the SDK's capped backoff (15 tries, 100 ms doubling to 5 s); a page that passes a larger value closes with `lost` on a drop sooner than that after joining. `reconnect(reason)` starts the same resume on purpose, by closing the socket with `MAY_TRY_RECONNECT` (4010): the client calls it after 2 s of fixed steps with no server frame (a half-open link the browser still calls `OPEN`) and when its queues overflowed in a background tab, for a fresh welcome. The token is saved at each welcome, the first and every resume: the SDK fires `onReconnect` before it stores the token the server just issued.
  - **Tokens** (`SeatTokens`) live in `sessionStorage` under `gameable.rooms|<url>|<game>|<code>`, as `<sessionId> <token>`, never `localStorage`: a reload of the same tab joining the same code resumes its held seat, and a second tab is a second player. A consented leave forgets the token; a failed resume (expired, gone, refused) forgets it and falls back to a fresh join.
  - **Seat locks** (`SeatLocks`, default `navigator.locks`; `locks` injects them, `MemorySeatLocks` for tests). A browser copies `sessionStorage` into a duplicated tab, token included. A connection holds a Web Lock named `<token key>|<sessionId>` for as long as it sits in the seat, and tries it before a resume: if another live tab holds it, the copied token is forgotten and the tab joins as a new player. A reload frees the lock when the old document goes. Without Web Locks the server still refuses: `GameableColyseusRoom.checkReconnectionToken` never hands a connected client's seat to a second holder of its token (Colyseus's own version kicks the live client with 4002).
  - **Sends** are dropped unless the state is `open`, and the SDK's offline queue is off (`maxEnqueuedMessages = 0`), so nothing sent before a welcome is replayed after it. INPUT bytes are passed as they are: `sendBytes` copies them into the SDK's own buffer.
  - `headers` is for Node (a test's `origin`); a browser sends its own Origin. `colyseusRoom` is the SDK's room while joined, for diagnostics.
- `listRooms(game, { url?, location?, headers?, timeoutMs? })` joins the lobby with the filter `{ name: game }` and resolves, once the lobby's first list has arrived, to a `RoomList`: `rooms` (`{ code, players, maxPlayers, phase }`, a fresh array on every change), `state` (`open`, or `closed` after `close()` or a lost link), `onChange(fn)` and `close()`. Every entry is checked (`publicRoom`): another game's, a private one, or one without our metadata is dropped, and a code or phase over 32 characters is not a code or phase. Each open list holds one of the address's 4 lobby sockets: close it when the panel closes. It rejects when the lobby refuses (403, 429) or sends nothing in `timeoutMs` (5 s). A page's "Browse rooms" panel (`gameable/net/page`) opens it through `gameable/host/features`' `listPublicRooms`, which imports this entry only when called.
- `GameableClientSerializer` is the SDK serializer, registered under `SERIALIZER_ID` when the module loads; frames that arrive before a connection attaches wait, and rows are handed over as copies.

`gameable/rooms/server`, the room:

- `GameableColyseusRoom` is the room for every game. `define(name, GameableColyseusRoom, { entry })` takes an `GameableRoomEntry`: `maxPlayers` (Colyseus's `maxClients`; a held seat counts), `sendHz` (rows per second, default 20), `reconnectSeconds` (default 30), `idleSeconds` (default 120), `budgets`, and `create()`, which returns the `RoomGame`. The define options win over a client's join options, so a client cannot name its own entry. The join option `name` (a string, cut to 32 characters, `displayName`) is the player's name.
  - **Admission** (`onAuth`, `admitJoin`), before a seat is reserved: the join's `v` must be `PROTOCOL_VERSION` (else 426, `VERSION_REFUSED_CODE`), its `game` must be this room's name (else Colyseus's "not found", 522), and the game's `admit(name, token)` hook, if it has one, must return null (a refusal is `ADMIT_REFUSED_CODE`, 525, with the game's words; a hook that throws is logged and refused `admission failed`). This is the same hook our own `Room` (Play Solo) asks, so a game gated in one is gated in both.
  - **Seats per address** (`SeatQuota`, with `createRoomServer`'s limits): `onJoin` charges the seat to the address the gate stamped (`PEER_OPTION`) and refuses 429 past `seatsPerAddress`; `onLeave` gives it back.
  - Seats are 0 upward, the lowest free first; `onJoin` calls `game.join`.
  - Each 60 Hz tick: coalesced input to `game.input`, `game.tick`, then each seat's view. A seat with no INPUT frame for 250 ms has its held input let go once (`RoomPlayer.neutralIfIdle`: each held key and button released, nothing down, unfocused), so a hidden tab or a stalled link does not keep running; our own `Room` does the same.
  - A connected client that sends no frame at all (INPUT or text) for `idleSeconds` is dropped with `IDLE_CLOSE_CODE` (`IdleSeats`, looked at every 250 ms); its seat is then held like any dropped seat. A connected player gets a `cmd` every tick (with `ack` and `entity`), the view's messages, and rows every `1000 / sendHz` ms. A held seat's view is taken and thrown away.
  - A dropped connection holds the seat for `reconnectSeconds` through `allowReconnection`, and the game hears `game.hold(id)` (then `game.resume(id)` when the player is back): `EngineRoomGame` leaves a held seat out of the guest's players list, so `ctx.players.host` passes to the lowest connected seat and does not come back on the resume. With the SDK's reconnection token the player gets the same seat and entity and a fresh welcome. If the hold expires, `game.leave(id, 'timeout')` runs and the guest despawns the entity. A consented leave is `game.leave(id, 'left')`.
  - A game that ends itself (`RoomGame.ended`, a crashed guest) sends everyone `error: ended` with the reason and the room disconnects.
  - `room.game`, `room.seats` and `room.intake.counts` are public, for tests and the host's health numbers.
- `GameableColyseusRoom` is wiring; its parts are classes of their own:
  - `RoomReplication` sends each player only their own welcome (`snapshotFor(thatPlayer)`) and their own `cmd`, messages and rows;
  - `RoomSeating` handles join, drop, reconnect and leave;
  - `RoomInbound` handles the two client channels.
- `GameableSerializer` is the Colyseus `Serializer`: `getFullState(client)` is that player's welcome (on a first join and on every reconnect), and `applyPatches` is one tick of everyone's frames.
- `GameableWire` builds each frame as a fresh `Buffer` behind its Colyseus byte.
- `SeatMap` maps a Colyseus `sessionId` to its seat: our `RoomPlayer` (id, name, coalesced input, acks, and its `TextLimit` as `text`) plus an input budget.
- `RoomIntake` checks a frame against the seat's budget, then `InboundParser`. An INPUT frame is coalesced into the seat. A text frame must be `msg` or `ping`. Anything else, including a `hello`, an unknown `t` or bad JSON, is refused and counted, room-wide in `intake.counts` and per player in `seat.text.counts` (`spent`, `oversize`, `bad`, `overBudget`).
- Message limits, the same rule in this room and in `gameable/net/server`'s own `Room` (`TextLimit`, one per seat):
  - A `msg` whose payload is over `MAX_PAYLOAD_BYTES` (2,048, from `gameable/sdk/wire`), or any text frame over 2,560 bytes, is dropped before the game sees it and counted as that player's `oversize`. The player is not told: a page that builds its frames with `encodeClientText` never sends one.
  - Out of text budget, the player is told `error: budget` once and its text frames are dropped; the seat stays and INPUT keeps flowing. A frame that passes ends the run, so a player who runs out again is told again.
  - Only sustained abuse closes: `closeAfter` (100) text frames refused in a row, with none passing between, close the client with 4002 (`error: budget` is not sent twice) and free the seat at once; `game.leave` hears `budget`.
  - INPUT is stricter: one frame over its budget is a flood, `error: budget` and 4002 at once. A client sends INPUT at a steady 60 Hz, so a burst past twice that is never a real player.
- What a player is sent is only theirs, proven end to end with a real guest (`GameableColyseusRoom.filters.test.ts`, and `Room.filters.test.ts` on our own `Room`): a `ctx.net.send(..., { to: 2 })` reaches player 2 alone; anything inside `ctx.net.local(...)`, a spawn included, reaches nobody, in a `cmd` or in a welcome; `player.hud.set` for player 1 reaches player 1 and never appears in another player's `cmd` frames or welcome.

### Identity: who joins

A seat is a place in one room; an identity is the player behind it, the same in every room and after every reload. Task 5.2's saved data is keyed on it. `gameable/net/server` has the providers, `gameable/rooms` asks them in `onAuth`.

- **Device tokens** (`deviceIdentity(secret)`). The first time a page joins without one, the room mints `device.<random>.<hmac>` (16 random bytes, HMAC-SHA256 of `device.<random>` with `ROOMS_SECRET`, both base64url) and sends it on `IDENTITY_TYPE`, right after the welcome. The page keeps it in `localStorage` under `aos.identity.<the room server's origin>` (`DeviceTokens`) and sends it as the `device` join option on every join. The id is `device:<random>`. A token whose HMAC does not match (forged, one character flipped, another server's secret) is refused in constant time: that join is a new device, with a fresh token, never the id the forgery names. Seat tokens are separate and stay in `sessionStorage`, so two tabs of one browser are one device id in two seats.
- **Gameable sign-in** (`portalIdentity({ authUrl, fetch })`). `GET {authUrl}/auth/me` on the Gameable auth service answers `{ id, email, org_id, org_slug, org_name, org_created_at, roles }` for a valid session and 401 otherwise. It reads only the `avataros_session` cookie, never an `Authorization` header. The room forwards that one cookie, from either of two places: the upgrade request's own `Cookie` (a page under the auth service's cookie domain), or the `portal` join option, a session token the page passes with `portalToken: () => token` (a page on any other domain: the browser never sends that cookie to the room server). The id is the user's id; the name is the email's local part, capped to 32 characters. A 401, a 5xx, junk, or no answer in 3 s falls through to the device token.
- **The order** (`createIdentities({ device, portal? })`, `identify`): the portal first, then the device token; a missing or bad device token is replaced, signed in or not, so a player who signs out later is still the same device. `chain(providers)` is the general first-that-knows-wins.
- **Names.** A signed-in player's seat name is the portal's name, whatever the page typed: a client-sent name never wins over it. A guest keeps the typed name, cut to 32 characters (`displayName`). The game's `admit(name, token)` hook hears the seat's name, not the typed one.
- **The game** gets the identity as the fourth argument of `RoomGame.join(player, name, data, identity)`; the seat keeps it as `seat.identity` (`room.seats.get(sessionId).identity`).
- **Configuration** (`identitiesFromEnv(process.env)`, `createRoomServer`'s default `identities`): `ROOMS_SECRET` signs the tokens. With `NODE_ENV=production` (the container's) a secret under 32 bytes, or none, stops the server at start. Elsewhere a missing secret is a random one for that process, with a warning: device ids then last until a restart. `GAMEABLE_AUTH_URL` (the auth service's origin) turns sign-in on; a value that is not an http(s) URL stops the server. `identities: null` resolves nothing, and a bare `Server` defined without `identities` does the same.

### Hosting: `gameable serve` and the container

`gameable serve` (`gameable/cli`) runs `createRoomServer` for a game directory:

- `gameable serve --direct` loads `src/game.ts` through the game's own Vite (and the room server through the same Vite, so they share one SDK) and holds one room: the dev loop. `--max-rooms` above 1 is refused.
- `gameable serve` serves the built game: `dist/guest/` (the wasm guest) and `dist/server/` from `gameable build`, up to 8 rooms. `--games <dir>` serves every `<dir>/<name>/dist` from one process.
- Flags, with the environment variable each falls back to: `--port` (`PORT`, default 8790), `--host` (`HOST`, default `127.0.0.1`), `--origins` (`ORIGINS`, comma-separated, default `http://localhost:*,http://127.0.0.1:*`), `--trust-proxy <hops>` (`TRUST_PROXY`, default 0; nginx alone 1, Traefik then nginx 2), `--max-rooms`, and `--seed` (one seed for every room; by default each room rolls its own).
- Each game is served under its `package.json` name without the npm scope (`@gameable/example-mystery` is `example-mystery`): the name a page passes to `joinOrCreate`.
- A port already in use exits 1 with one line: `port <n> is already in use on <host>: stop what holds it, or pass --port`.
- `--direct` loads `src/game.ts` once: after an edit, restart it, or the page's client and the room run different rules.
- In this repository `npx gameable` runs the CLI's `dist/` and built mode imports the engine packages' `dist/`: run `npm run build` once first.

`gameable build` writes `dist/server/` for a game that declares `features.multiplayer`: `game.json` (`{ name, features, world, physics, maxPlayers, sendHz }`), `assets.json` (the manifest, each collider `src` pointed at its copy) and `colliders/<id>.bin`. `physics` is the game's `src/physicsOptions.ts` export `PHYSICS_OPTIONS`, the module the page passes to `physics()` too (without it, `world.gravity`); a room server never restates the numbers.

`deploy/rooms/Dockerfile` is the room server image (`docker build -f deploy/rooms/Dockerfile -t aos-rooms .` from the repository root): node:24-slim, multi-stage, user `node`, `HEALTHCHECK` on `/health`, `PORT`, `HOST` (0.0.0.0), `TRUST_PROXY` and `ORIGINS` from the environment. The runtime stage holds `main.mjs` (the server bundled by `packages/cli/scripts/bundle-server.mjs`: no node_modules, no three.js), Jolt's wasm beside it (passed by path), and `/games`, with `example-mystery` baked in; mount built games over `/games` to serve others. `packages/rooms/src/server/host/container.smoke.test.ts` checks a running one (`GAMEABLE_ROOMS_URL=http://127.0.0.1:8790`).

## Gotchas

- The room ticks with `setFixedTimestep`, never `setSimulationInterval`, which measured 44 Hz on Windows. It sets the loop **before** `patchRate = null`: the other order runs zero steps.
- `ws` writes a server frame to the socket by reference, so every frame is a fresh buffer. Never reuse a send buffer here.
- The SDK's `sendBytes` copies what it is given into its own reused buffer before it returns, so the caller's buffer is free at once and `ColyseusConnection` passes INPUT bytes without a copy. The SDK's offline queue keeps views of that shared buffer, so a copy before `sendBytes` would not help; `ColyseusConnection` turns the queue off (`maxEnqueuedMessages = 0`) and sends only while open.
- `leave()` while `reconnecting` has no socket to send the leave on: the SDK closes locally, the token is forgotten, and the server holds the seat until its hold runs out (30 s).
- `@colyseus/sdk` adds about 51.8 KB gzip (168.7 KB minified) to a page over `gameable/net/client` alone, measured by `bundleSize.test.ts`; most of it is `@colyseus/schema`, which the SDK's `Room` imports statically though our serializer never uses it.
- The SDK refuses automatic reconnection within its `minUptime` (5 s by default) of joining; `ColyseusConnection` sets it to 0 unless the page passes `minUptimeMs`. The seat is still held on the server either way, so a reload in that tab resumes it by its token.
- The welcome's `secret` is empty, because Colyseus's reconnection token (reissued on every reconnect) is the secret.
- The welcome on a first join says `entity: 0`: the guest spawns the player's entity on its next step, and the `cmd` frames carry it from then on.
- Budgets: text frames get 40, refilled 20 per 5 s, and close after 100 refused in a row (`budgets.text.closeAfter`); INPUT frames get 120, refilled 120 per second (twice the 60 Hz a client sends). A refused frame still costs a token.
- Colyseus's own frame types (PING and the rest) never reach those budgets, so the room also sets Colyseus's `maxMessagesPerSecond` to 200 for every frame. A client over it is closed with 4002. Any 4002 close (that cap, an unknown message type, our budget) frees the seat at once, and `game.leave` hears `flood` or `budget`. At the default text limits ours closes first: 140 text frames (40 spent, 100 refused) is under the 200 a second.
- `error: budget` does not end the connection; the close, if it comes, is the 4002 that follows. The page sees it as a warning (`net.lastWarning` is `budget`, `net.stats.warnings` counts it), never as `closeReason`; after a 4002 close `closeReason` is the close's own word, `error`.
- A dropped seat lets go of everything: each held key and button gets its `released` edge, the modifiers are cleared and the player is unfocused, on the next tick.
- Colyseus's matchmaker is process-wide: one `Server` per process.
- Identity is only as good as `ROOMS_SECRET`: whoever has it can mint any device id. Rotating it turns every device into a new one (each page is handed a fresh token on its next join), and with it any data saved under the old ids.
- Two tabs that open at the same moment, before either has a device token, are minted two; the one written last wins, and the other tab's first session was under a device id nobody keeps.
- A signed-in player's name is their email's local part, shown to every player in the room: the auth service has no display name yet.
- The join options carry the tokens in the matchmaking POST's body. Colyseus's own `client.auth.token` would put a bearer token in the WebSocket URL (`_authToken`), where proxies log it, so `ColyseusConnection` never sets it.
- A reconnect (the seat's token) does not run `onAuth` again: the seat keeps the identity it joined with.
- Origins: a browser always sends `Origin` on a WebSocket upgrade and on the matchmaking POST, so a request without one is a script and is refused. A Node client sets it: `new Client(url, { headers: { origin } })`. This stops other sites' pages, not scripts, which can claim any origin; against a script, the codes rest on the per-address lookup limit.
- Colyseus's CORS answer still echoes any origin on a preflight; the refusal comes on the POST itself.
- `RequestGate` replaces `matchMaker.controller.invokeMethod`, which is process-wide, like the matchmaker: one room server per process.
- Codes are unique per process. Across processes (Redis presence, phase 6) the code is the room id, and Colyseus refuses to record a second room with an id it already has.
- The server is created with Colyseus's `gracefullyShutdown: false`: its `uncaughtException` handler would end every room for one room's throw. Signals are the caller's: `gameable serve` closes the server on SIGINT and SIGTERM.
