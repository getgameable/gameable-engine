# Play an animation on a character

## Goal

An NPC in your scene idles when it is standing still, walks when it moves, and
waves once when the player gets close — driven entirely from the character state
your game logic already produces.

## Files you will edit

- `assets.json`
- `src/game.ts`

## Steps

1. Ship the clips inside the rig. A `skinned` character is one GLB whose glTF
   animations carry `extras.aos = { speed, loop, locomotion }`; the animator
   builds its locomotion index from the ones tagged `locomotion` and registers
   every clip by name, so `assets.json` needs only the character entry:

   ```json
   {
     "assets": [
       {
         "id": "char.npc",
         "type": "character",
         "src": "@aosrig/aosrig_v0.glb",
         "rig": { "backend": "skinned" }
       }
     ]
   }
   ```

   Clips retargeted by `packages/animation/tools/retarget_locomotion.mjs` arrive
   as one GLB each plus a `locomotion.json`; hand that index to `createAnimator`
   as `locomotion` and `addClip` each GLB's clip, as the next steps do.

2. In `src/game.ts`, give the NPC an animator when it spawns. `locomotion` is
   the parsed `locomotion.json`; the animator sorts it once, here, not per
   frame.

   ```ts
   import { createAnimator } from 'gameable/animation';

   const animator = createAnimator({
     root: npc.rigRoot,
     expressionSpace: npc.bundle.expressionSpace,
     locomotion: assets.get('npc.locomotion'),
   });
   ```

3. Register the gesture clip as ADDITIVE, so the base layer's per-frame weight
   pass does not stop it while the envelope is running.

   ```ts
   animator.addClip('wave', assets.get('npc.wave'), { additive: true });
   ```

4. Drive it from the character state each frame. Preallocate the state object
   outside the system: this runs sixty times a second.

   ```ts
   const npcState = { velocity: [0, 0, 0], grounded: true, lookAt: null };

   function animateNpc(dt: number): void {
     npcState.velocity[0] = npc.velocity.x;
     npcState.velocity[1] = npc.velocity.y;
     npcState.velocity[2] = npc.velocity.z;
     npcState.lookAt = playerIsNear ? playerPosition : null;

     animator.setState(npcState);
     animator.update(dt, { camera });

     npc.setBodyPose(animator.bodyPose);
     npc.setExpression(animator.expression);
   }
   ```

5. Fire the wave once, from whatever decides the player is close. The gesture
   channel is one slot: a second `play` replaces whatever was in flight.

   ```ts
   if (playerJustArrived) animator.gesture.play('wave', { durationMs: 1500 });
   ```

## Verify

Run `npm run dev` and walk up to the NPC. It should be idling, blend into a walk
as it moves, turn its head to follow you without the neck exceeding about
45 degrees, and wave once as you arrive.

Asserting it in a test: with a velocity of `[0, 0, 0]` the animator's pose
matches the idle clip, and at the locomotion index's top speed it matches the
run clip, so

```ts
animator.setState({ velocity: [0, 0, 0], grounded: true, lookAt: null });
animator.update(1 / 60);
const standing = animator.bodyPose.bones.slice();

animator.setState({ velocity: [4, 0, 0], grounded: true, lookAt: null });
animator.update(1 / 60);
expect(animator.bodyPose.bones).not.toEqual(standing);
```

## See also

- [Animation](../concepts/animation.md)
- [Characters](../concepts/characters.md)
- `packages/animation/README.md` — gameable/animation
- [Assets and the manifest](../concepts/assets.md)
