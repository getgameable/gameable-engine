# Add a locomotion state

## Goal

Play authored rise, fall and landing clips using the shared third-person controller.
The character bundle must already contain the six named clips below. Ground contact
comes from physics, so reaching the jump apex cannot trigger a landing animation.

## Files you will edit

- `src/systems/locomotion.ts`
- `src/game.ts`

## Steps

1. **Select the clips.** Replace the existing controller construction in
   `src/systems/locomotion.ts`, keeping its reset/update exports and dialogue gate:

   ```ts
   const controller = createThirdPersonController({
     idle: 'idle',
     walk: 'walk',
     run: 'run',
     rise: 'jump-rise',
     fall: 'jump-fall',
     land: 'jump-land',
   });
   ```

   Names refer to clips in the character's loaded bundle, not asset paths.
   Configure jump clips as non-looping in the bundle. Explicit clip weights select
   the performance; a `character.setState` label alone does not select a clip.

2. **Tune launch and landing.** Add these values to `rules` in `src/game.ts`:

   ```ts
   jumpSpeed: 6,
   jumpLockFrames: 3,
   landingSeconds: 0.18,
   acceleration: 10,
   deceleration: 14,
   ```

   Gravity remains a world/host physics setting. Set both consistently when changing
   it. The host drives the capsule trajectory; prepared clips should have stationary
   horizontal root motion. The controller preallocates its weights and never adds
   frame allocations.

3. **Understand the transitions.** The controller reads `ctx.physics.isGrounded(hero)`
   from the preceding physics step. Launch selects rise, negative vertical speed
   selects fall, and walkable ground contact selects landing for `landingSeconds`.
   Jumping again during landing starts rise immediately. Without a clip mapping the
   controller still sends semantic states and uses the default locomotion blend.

## Verify

```sh
npm test -w templates/third-person
npm run dev -w templates/third-person
```

Jump twice, walk off a ledge, and press jump at the apex. The apex must remain
airborne, the second grounded jump must replay, and walking/running must resume
after landing. Check both direct and compiled WASM builds after changing packages.

## See also

- [Build your first adventure](../start/03-first-adventure.md)
- [Tune the follow camera](./tune-the-follow-camera.md)
- [Play an animation on a character](./play-an-animation.md)
- [Animation](../concepts/animation.md)
