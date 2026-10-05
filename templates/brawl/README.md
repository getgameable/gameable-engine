# Gameable Engine brawl kit

Two to four players in an arena with a punch, a dash and a ground slam. A
fighter at 0 health is knocked out and comes back; the first to three
knockouts wins the round.

```sh
npm create gameable my-brawl -- --template brawl
cd my-brawl
npm run build:guest   # Play Solo's authority runs the wasm guest
npm run dev           # http://localhost:5199
```

Keys: WASD move, J punch, K dash, L ground slam.

## What to change first

Every number is in `rules` in `src/game.ts`. The three to try first:

| What      | Rules                                                     | Default             |
| --------- | --------------------------------------------------------- | ------------------- |
| Damage    | `punchDamage`, `slamDamage`, `maxHp`                      | 12, 20, 100         |
| Cooldowns | `punchCooldown`, `dashCooldown`, `slamCooldown` (seconds) | 0.4, 1.5, 3         |
| Knockback | `punchKnockback`, `slamKnockback` (m/s), `knockbackDecay` | 7, 10, 6 per second |

Then reach and the round: `punchRange`, `punchArcDegrees`, `slamRadius`,
`kosToWin`, `respawnSeconds`. Run `npm run build:guest` after a change: Play
Solo's authority runs the built guest.

## How it works

- **Abilities are messages.** J, K and L send `punch`, `dash` and `slam`
  (`src/messages.ts`) up to the authority, which checks them in
  `src/systems/abilities.ts`: the cooldown, the reach and, for a punch, that
  the target is in front. A refusal comes back as `refused` `{ why }`. A hit
  takes health, knocks the victim back, flashes them red, and is confirmed
  with a `hit` to the attacker and to the victim, whose pages play the hit
  sound.
- **The authority decides where a hit lands.** It uses its own positions,
  never the page's.
- **Your own fighter moves on key-down.** The game declares
  `features.multiplayer.predict`, and `src/systems/move.ts` runs on both sides
  (`on: 'both'`): the page walks an invisible body of its own (`OwnBody`) and
  draws you there; the authority's position corrects it. Only walking is
  predicted. A dash and a knockback are the authority's and reach your page as
  corrections.
- **Knockouts and the round** are in `src/systems/round.ts`: `ko`, `respawn`
  and `round` go to everyone, and the room's phase (`ctx.net.setPhase`) is
  `fighting` or `round-over`, which the public room list shows.
- **Knockback is a velocity, not an impulse.** A fighter is a `character` body,
  and the physics ignores `applyImpulse` on those, so the knockback is a
  velocity that `move` adds to the walk and fades out.

## Play with a friend

```sh
npm run dev                   # the page
npx gameable serve --direct  # the room server, ws://localhost:8790
```

Open `http://localhost:5199/?room=new&rooms=http://localhost:8790`, then the
corner's **Copy link** in a second tab. Without `?room=` the page plays solo.

## Tests

`npm test` runs:

- `tests/abilities.test.ts`: the fight on the authority through
  `simulatePlayers`: a cooldown refused, out of range and behind refused, the
  knockback, a knockout, the respawn and the round.
- `tests/latency.test.ts`: our room with two pages over 150 ms each way
  (`latencyPair`). Your own fighter moves on the step the key goes down, and a
  punch lands where the authority says on both pages.
