# Make a multiplayer game

From nothing to two tabs on one street, with a kit: a multiplayer game that
already works, for you to change. This page walks the **hangout** kit; every
other kit works the same way.

## 1. Pick a kit

```sh
npm create gameable -- --list
```

prints every template, one line each, with the multiplayer kits marked:

| Kit       | Players | What it is                                                       |
| --------- | ------- | ---------------------------------------------------------------- |
| `hangout` | 1-12    | a street of six houses: chat, colours, benches, doors and cars   |
| `brawl`   | 2-4     | punch, dash and ground slam; first to three knockouts            |
| `survive` | 4-6     | gather and build by day, hold the camp against creatures by night |
| `mystery` | 3-6     | one hidden "it", tag-outs and votes; a round needs three players |

Every kit is also hosted on the [Play](../play.md) page. **Play together**
there opens a room on the hosted room server; copy the link the corner shows
into a second tab and you are two players, with nothing installed.

## 2. Scaffold

```sh
npm create gameable my-street -- --template hangout
cd my-street
npm run build:guest   # Play Solo's authority runs the wasm guest
npm run dev           # http://localhost:5196
```

The page plays solo: a room of one, the authority in the page. Walk with WASD,
`E` opens a door or gets in a car, `F` sits on a bench, `1`-`6` change your
colour, Enter chats.

## 3. Start a room server

In a second terminal, in the same directory:

```sh
npx gameable serve --direct   # the room server, ws://localhost:8790
```

`--direct` runs `src/game.ts` as it is, with no build. It reads the file once,
so restart it after an edit. It takes pages from `http://localhost:*` and
`http://127.0.0.1:*`.

## 4. Two tabs

Open `http://localhost:5196/?room=new&rooms=http://localhost:8790`. Once it
joins, the corner shows a four-letter code and **Copy link**. Open the link in
a second tab: two residents on one street, each moving in their own tab and
seen in the other. Chat in one tab, read it in both.

The address picks the room: `?room=new` makes one, `?room=CODE` joins it,
`?room=quick` joins any open one, and no `?room=` plays solo. `?rooms=` works
only on a local page; a deployed game talks to its own site's room server.

Press `3` for a colour, close the tab and open the link again: the colour comes
back. The kit keeps it in your player document (`ctx.data`). Without a database
(`GAMEABLE_PG_URL`), `serve` keeps documents in memory until it stops.

## 5. Change something

Every number worth changing is in the `rules` block of `src/game.ts`. Set
`runSpeed: 8`, restart `serve --direct`, reload both tabs, and hold Shift.
Then run the kit's tests, which drive the authority headlessly with twelve
players and no browser:

```sh
npm test
```

## See also

- [Multiplayer](../concepts/multiplayer.md): rooms, the authority, players
- [Play with friends](../recipes/play-with-friends.md): the third-person
  template in rooms, with one edit
- [Play](../play.md): every kit, hosted
- [Ship it](./04-deploy.md): the page is static files; the room server runs
  `gameable serve` on built games
