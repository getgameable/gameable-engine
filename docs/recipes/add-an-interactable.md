# Add an interactable

## Goal

A new kind of thing in the world that the hero can walk up to and press `E` at:
a lever that unlocks the door without a key. When it is in reach the HUD says
`E: pull lever`, and pulling it opens the door.

## Files you will edit

- `src/prefabs.ts`
- `src/systems/interact.ts`

## Steps

1. **Declare what it is.** Tags are the vocabulary: `Interactable` means "`E`
   does something here" and a second tag says what. Add both the tag and the
   prefab to `src/prefabs.ts`:

   ```ts
   /** Tag: a lever. Pull it. */
   export const Lever: Record<string, never> = {};

   /** A lever: a thin post you pull once. */
   export const LeverPrefab = prefab({
     name: 'lever',
     body: {
       shape: 'box',
       dims: [0.12, 0.6, 0.12],
       kind: 'fixed',
       layer: { defaultLayer: true },
       mask: { player: true, character: true },
     },
     components: [Interactable, Lever],
   });

   /** Lever brass. */
   export const LEVER_COLOUR: readonly [number, number, number] = [0.7, 0.55, 0.2];
   ```

2. **Give the kind a number.** The interact system reads one integer per
   candidate rather than asking bitecs four questions a frame, so every kind has
   a constant. Add it next to the others in `src/prefabs.ts`:

   ```ts
   /** A lever. */
   export const KIND_LEVER = 5;
   ```

3. **Classify it.** In `src/systems/interact.ts`, add one branch to
   `classifyInteractables`, which runs once during `init`:

   ```ts
   interactables.kind[e] = hasComponent(ctx.world, e, Lever)
     ? KIND_LEVER
     : hasComponent(ctx.world, e, Chest)
       ? KIND_CHEST
       : /* …the existing chain… */ KIND_NONE;
   ```

4. **Give it a prompt.** Still in `src/systems/interact.ts`, one line in
   `promptFor`:

   ```ts
   if (kind === KIND_LEVER) return used ? '' : 'E: pull lever';
   ```

5. **Say what `E` does.** One branch in `activate`, which already has the door
   entity to hand:

   ```ts
   if (kind === KIND_LEVER) {
     interactables.used[entity] = 1;
     ctx.audio.play('sfx.door', { entity, volume: 0.8 });
     // The door's own `used` lane is what `slideDoor` watches.
     if (interactState.door !== 0) interactables.used[interactState.door] = 1;
     notify(ctx, 'Somewhere, something heavy moves.');
     return;
   }
   ```

6. **Put one in the level.** Add a point to `src/arena.ts` and an entry to the
   `spawns` list in `src/game.ts` — the same two lines every other prop uses.
   Paint it in `init` with `tint(entity, LEVER_COLOUR)`.

## Verify

```sh
npm test -w templates/third-person
npm run dev -w templates/third-person
```

Walk up to the lever. The HUD's top-left rows gain `prompt  E: pull lever`, and
pressing `E` starts the door sliding with no key in your pocket. Add the case to
`tests/game.test.ts` the way `refuses the door without the key` is written —
place the hero, assert the prompt, tap `E`, assert `questState.escaped` after a
hundred steps.

## See also

- [Build your first adventure](../start/03-first-adventure.md) — where the
  interact cone and the tags come from
- [Add NPC dialogue](./add-npc-dialogue.md) — the other thing `E` can start
- [ECS and game code](../concepts/ecs.md) — what a tag is in this ECS
- [Write a game system](./write-a-game-system.md) — if the behaviour outgrows one branch
