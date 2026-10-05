# Play a sound

## Goal

A pickup makes a noise from where it sits in the world, at a volume that falls
off with distance, and your game reacts when the sound finishes.

## Files you will edit

- `assets.json`
- `src/systems/pickups.ts`

## Steps

1. Declare the sound in `assets.json`. The id is the contract; the path is the
   host's business and never appears in game code.

   ```json
   {
     "version": 1,
     "assets": [
       { "id": "arena", "type": "splat", "src": "arena.spz" },
       { "id": "pickup-chime", "type": "audio", "src": "sfx/chime.ogg", "tags": ["sfx"] }
     ]
   }
   ```

2. Play it from the system that handles the pickup. Passing `entity` makes the
   voice positional: the host tracks that entity and pans the sound as you move
   around it. `play` returns the guest-minted handle.

   ```ts
   import type { GameContext } from 'gameable';

   // Module scope is fine for a handle: it is set in a system, not at import
   // time, so the Wizer snapshot does not freeze a value into the binary.
   let chime = 0;

   export function pickups(ctx: GameContext): void {
     for (const e of touched(ctx)) {
       // Positional: the host follows the entity until the sound ends.
       chime = ctx.audio.play('pickup-chime', { entity: e, volume: 0.8, bus: 'sfx' });
       ctx.despawn(e);
     }
   }
   ```

3. React when it finishes, in the same file. The host emits `sound-ended` with
   the handle you were given, and it arrives in the next tick's `ctx.events`.

   ```ts
   export function pickupAudio(ctx: GameContext): void {
     for (const ev of ctx.events) {
       if (ev.tag === 'sound-ended' && ev.val.sound === chime) chime = 0;
     }
   }
   ```

## Verify

```sh
npm run dev
```

Walk into the pickup. The chime comes from the pickup's direction — turn around
and it swaps ears — and the object disappears. Then assert it headlessly:

```sh
npm test
```

```ts
expect(harness.commands('play-sound')).toContainEqual(
  expect.objectContaining({ asset: 'pickup-chime', bus: 'sfx' }),
);
```

## See also

- [Assets and the manifest](../concepts/assets.md)
- [Engine modules](../concepts/modules.md)
- `packages/audio/README.md` — gameable/audio
