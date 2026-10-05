# Play with friends

## Goal

The third-person game in rooms: two tabs (or two people) in one arena, each
with their own character, the authority on a room server. The page shows the
room code with a copy-link button, and a game opened with no room still plays
solo.

## Files you will edit

- `src/game.ts`

## Steps

1. **Declare the feature.** In `src/game.ts`, add `multiplayer` beside
   `characters`:

   ```ts
   features: { characters: true, multiplayer: { maxPlayers: 6 } },
   ```

   That is the only edit. The page (`src/main.ts`) sees it and becomes a room's
   client: no physics on the page, the authority's world drawn instead, and
   `?room=` picks the room.

2. **Start the room server beside the dev server**, in two terminals:

   ```sh
   npm run dev                 # the page, http://localhost:5181
   npx gameable serve --direct  # the room server, ws://localhost:8790
   ```

   `--direct` runs `src/game.ts` as-is, one room at a time; it accepts pages
   from `http://localhost:*` and `http://127.0.0.1:*`. It reads `src/game.ts`
   once, so restart it after an edit. Inside the engine repository, run
   `npm run build` once first: `npx gameable` runs the CLI's built `dist/`.

3. **Open a room** in the first tab:
   `http://localhost:5181/?room=new&rooms=http://localhost:8790`.
   Once it joins, the corner shows a four-letter code and the address becomes
   `?room=CODE`, so a reload keeps your seat. **Copy link** and open it in a
   second tab.

The address picks the room: no `?room=` plays solo, `?room=CODE` joins,
`?room=new` makes a room and `?room=quick` joins any open one. `?rooms=`
works only on a local page; a deployed game uses its own server.

## Verify

```sh
npm test
```

In both tabs the corner says **Joined** with the same code; walk in one and the
other character moves in the other tab. A failed join says why: `full`,
`no-room`, `origin` or `capacity`. With no `?room=`, run `npm run build:guest`
first: Play Solo's authority is the built guest.

## See also

- [Turn on a feature](./turn-on-a-feature.md) — how `features` reach the page
- [Build the wasm guest](./build-the-wasm-guest.md) — what Play Solo's authority runs
- [Build your first adventure](../start/03-first-adventure.md) — the template this extends
