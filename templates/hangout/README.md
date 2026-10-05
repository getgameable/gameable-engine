# Gameable Engine hangout kit

Up to twelve friends on a street of six houses. No round, no score, no win: a
place to be together, and the starting point for a social game.

```sh
npm create gameable my-street -- --template hangout
cd my-street
npm run build:guest   # Play Solo's authority runs the wasm guest
npm run dev           # http://localhost:5196
```

## What is here

- **The street** (`src/street.ts`): six placeholder houses, three on each side,
  each with a front door; two parked cars; two benches. Every player spawns in
  front of their own house: player `n` lives in house `n % 6`, two to a house.
- **Moving in**: when a player joins, the authority sends them alone a
  `house` message `{ house }`, and their HUD shows their house number and how
  many people are on the street.
- **Doors**: E near a front door opens it for everyone (it slides aside); E
  again shuts it.
- **Cars**: E near a free car gets in. The car is a kinematic body the
  authority moves from the driver's own keys: W accelerates, S brakes and then
  reverses, A and D steer while it rolls. E gets out on the driver's side. One
  driver per car.
- **Benches**: F near a bench sends `sit`; the authority sets that player's
  character state to `sit` and holds them still. F again, or any movement key,
  stands them up.
- **Colours**: 1-6 send `cosmetic` `{ color }` with a colour from the palette
  in `src/systems/controls.ts`. The authority paints that player's character
  with one `set-material-param`, which every page sees and which the room hands
  to anyone who joins later.
- **Chat**: Enter opens a line; the authority cleans it, caps it and echoes it
  to everyone with the sender's name. The last three lines are in every HUD.

Keys: WASD walk (Shift runs), mouse orbits the camera, E door or car, F sit,
1-6 colour, Enter chat.

## Change something

The three rules to change first, all in `rules` in `src/game.ts`:

| Rule        | Default | Does                                  |
| ----------- | ------- | ------------------------------------- |
| `carSpeed`  | 9       | A car's top speed, metres per second  |
| `sitRange`  | 1.5     | How close to a bench F works, metres  |
| `walkSpeed` | 1.6     | Walking speed (`runSpeed` is Shift's) |

Then the street itself: `LOTS`, `CAR_SPOTS` and `BENCH_SPOTS` in
`src/street.ts`. A colour a player picks lives in the room for as long as they
stay; saving it to their player document is the next step (the marked line in
`src/systems/cosmetic.ts`).

## Who runs what

The authority (Play Solo's in the page, or the room server's) runs every
system but one: it owns the bodies, the doors and the cars, and reads each
player's own keys. `controls` is the only client system: it turns F and 1-6
into messages. The messages are in `src/messages.ts`.

## Play with a friend

```sh
npm run dev                   # the page
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5196/?room=new&rooms=http://localhost:8790`, then the
corner's **Copy link** in a second tab. Without `?room=` the page plays solo.

## Tests

`npm test` runs the street headlessly as a room's authority with
`simulatePlayers` from `gameable/test`: twelve players moving in,
chat, colours, benches, doors and cars, plus the client's keys and the page's
room choice. No browser, no room server, no physics.
