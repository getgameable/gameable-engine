# Tune the follow camera

## Goal

A camera that sits where you want it: a longer or shorter boom, a different
pivot height, a pitch range that suits your level, and smooth body turning when
the camera moves behind the character.

## Files you will edit

- `src/game.ts`
- `src/systems/locomotion.ts`

## Steps

1. **Know who owns what.** The guest states an intent; the host owns the arm.
   `ctx.camera.follow(hero, { yaw, pitch, distance, height })` writes one
   `camera-state` record — the orbit pivot, the direction the player is looking,
   the boom length — and the engine builds a spring arm from it, probes from the
   pivot towards where the camera wants to sit, and pulls the boom in when a wall
   is in the way. You never write the collision.

2. **Change the numbers.** Everything is a rule in `src/game.ts`, and the
   declarative `player` block has to agree with it, because the engine re-states
   the rig after every user system:

   ```ts
   player: {
     prefab: HeroPrefab,
     spawn: HERO_SPAWN,
     camera: 'thirdPerson',
     distance: 3,      // a tighter, more claustrophobic boom
     height: 0.25,     // above the body centre: chest height on the 1.73 m rig
     sensitivity: 0.0018,
   },
   rules: {
     cameraDistance: 3,
     cameraHeight: 0.25,
     cameraPitch: -0.3,      // resting: a little above, looking down
     cameraMinPitch: -1.0,   // how far the camera may rise
     cameraMaxPitch: 0.45,   // how far it may drop and look up
   },
   ```

   Keep `distance`/`height` and `cameraDistance`/`cameraHeight` the same number.
   They are the same boom stated twice, and `tests/game.test.ts` asserts the
   result.

3. **Tune body turning.** The shared SDK controller follows these rules in
   `src/game.ts`:

   ```ts
   idleTurnThreshold: Math.PI / 2,
   idleTurnRate: 4.5,
   moveTurnRate: 10,
   acceleration: 10,
   deceleration: 14,
   ```

   Small stationary orbits leave the body facing alone. Once the camera passes
   the threshold, the body completes its turn smoothly. While moving, it faces
   its camera-relative travel direction. The `aosrig_v0` model faces +Z, so its
   initial visual yaw is pi when the camera starts on +Z.

4. **Keep the shared controller.** `src/systems/locomotion.ts` constructs
   `createThirdPersonController()` from the SDK. It clamps the camera look
   accumulator in place and reuses a follow-options object every frame.
   Keep `controller.reset(ctx)` in game init so restart restores the camera,
   facing, acceleration and jump state together.

## Verify

```sh
npm test -w templates/third-person
npm run dev -w templates/third-person
```

Walk the hero into a corner and hold the mouse so the camera swings into the
wall: the boom shortens instead of the wall filling the screen. The headless
test `rides a spring arm behind the hero` asserts `armLength` and `offset.y`
straight out of `output.camera`, so a mismatched pair fails before you look at
it.

## See also

- [Build your first adventure](../start/03-first-adventure.md) — the template this tunes
- [Add a locomotion state](./add-a-locomotion-state.md) — the other half of the same system
- [Read player input](./read-player-input.md) — where the mouse delta comes from
- [The engine loop](../concepts/engine-loop.md) — why the camera is interpolated, not snapped
