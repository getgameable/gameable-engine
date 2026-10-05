# Add a HUD element

## Goal

The HUD shows a new value — a score that goes up when you kill something — next
to the ammunition and the enemy count, and it is only sent across the wasm
boundary on the frames it actually changed.

## Files you will edit

- `src/hud.ts`
- `src/systems/weapon.ts`

## Steps

1. Count the kills. The weapon already knows when a hit lands; give it a
   counter and reset it where every other piece of module state is reset.

   ```diff
   // src/systems/weapon.ts
    export const weaponState = {
      ammo: 0,
      cooldown: 0,
      reloading: 0,
      hits: 0,
   +  /** Points, for the HUD. */
   +  score: 0,
    };

    export function resetWeapon(ctx: GameContext): void {
      weaponState.ammo = Number(ctx.rules.magazine ?? 12);
      weaponState.cooldown = 0;
      weaponState.reloading = 0;
      weaponState.hits = 0;
   +  weaponState.score = 0;
    }
   ```

   ```diff
      Health.current[target] = (Health.current[target] ?? 0) - damage;
      weaponState.hits += 1;
   +  if ((Health.current[target] ?? 0) <= 0) {
   +    weaponState.score += Number(ctx.rules.killScore ?? 100);
   +  }
      ctx.audio.play('sfx.hit', { entity: target, volume: 0.8 });
   ```

2. Draw it, and add it to the change check. This is the part that matters:
   `hud.set` compares the model **one level deep** with `Object.is`, so a
   nested object mutated in place looks unchanged and is never sent. The
   template keeps a flat mirror of the values it draws and rebuilds the nested
   model only when one of them moved.

   ```diff
   // src/hud.ts
   -const mirror: { health: number; ammo: number; enemies: number; message: string | null } = {
   +const mirror: {
   +  health: number;
   +  ammo: number;
   +  enemies: number;
   +  score: number;
   +  message: string | null;
   +} = {
      health: -1,
      ammo: -1,
      enemies: -1,
   +  score: -1,
      message: null,
    };

    export function resetHud(): void {
      mirror.health = -1;
      mirror.ammo = -1;
      mirror.enemies = -1;
   +  mirror.score = -1;
      mirror.message = null;
    }
   ```

   ```diff
      const enemies = enemiesLeft(ctx);
   +  const score = weaponState.score;

      if (
        health === mirror.health &&
        ammo === mirror.ammo &&
        enemies === mirror.enemies &&
   +    score === mirror.score &&
        message === mirror.message
      ) {
        return;
      }
      mirror.health = health;
      mirror.ammo = ammo;
      mirror.enemies = enemies;
   +  mirror.score = score;
      mirror.message = message;

      ctx.hud.set({
        text: {
          ammo: ammo < 0 ? 'reloading' : String(ammo),
          enemies: String(enemies),
   +      score: String(score),
        },
        bars: { health: { value: health, max: maximum } },
        crosshair: health > 0,
        message,
      });
   ```

   The default renderer understands four keys: `text` (label/value rows),
   `bars` (`{ value, max }` meters), `crosshair` and `message`. Anything else
   is ignored, so a game that wants its own look passes its own renderer to
   `createEngineAdapter({ hud })` in `src/main.ts`.

## Verify

```sh
npm test
```

Add a test that the score reaches the HUD, and — just as important — that an
unchanged frame sends nothing:

```ts
it('puts the score on the HUD, and only when it changed', () => {
  const harness = boot();
  const target = livingEnemies(harness.guest)[0];
  scriptedHit = {
    body: RigidBody.handle[target] ?? 0,
    entity: target,
    point: { x: 0, y: 1, z: -5 },
    normal: { x: 0, y: 0, z: 1 },
    distance: 5,
  };
  pressMouse(harness.input, 1);
  harness.step(60);
  releaseMouse(harness.input, 1);

  const payloads: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const out = harness.guest.tick(
      createFrameInput({ frame: 900 + i, input: harness.input, bodies: new Float32Array(0) }),
    );
    if (out.hud !== undefined) payloads.push(out.hud);
  }
  expect(payloads).toHaveLength(0); // nothing changed, nothing crossed
  expect(weaponState.score).toBeGreaterThan(0);
});
```

Then `npm run dev`: `score 100` should appear top-left when the first enemy
dies, and the frame counter in the debug overlay (F3) should not move when you
stand still.

## See also

- [Write a game system](./write-a-game-system.md)
- [Add a weapon](./add-a-weapon.md)
- [The wasm boundary](../concepts/wasm-boundary.md)
- `packages/wasm-host/README.md` — gameable/host
