# Add NPC dialogue

## Goal

A third person in the arena with a script of their own: two lines and a yes/no
question, their own name above the box, and their own expression per line. No
change to the dialogue system.

## Files you will edit

- `src/dialogue.json`
- `src/prefabs.ts`

## Steps

1. **Write the script.** `src/dialogue.json` is a record of conversations keyed
   by name. Each has a `speaker`, a list of `lines`, and an optional `question`
   with a `yes` and a `no`. `face` names a preset in `FACES`, in
   `src/systems/dialogue.ts` — `neutral` or `smile` ship with the template.

   ```json
   {
     "smith": {
       "speaker": "Smith",
       "lines": [
         { "text": "You will want the key before you try that door.", "face": "neutral" },
         { "text": "I would fetch it myself, but I am busy.", "face": "smile" }
       ],
       "question": {
         "text": "Want me to point at the chest?",
         "face": "smile",
         "yes": { "text": "That one. The obvious one.", "face": "smile" },
         "no": { "text": "Brave. Good luck.", "face": "neutral" }
       }
     }
   }
   ```

2. **Tag an NPC with it.** Which script an NPC runs is a tag, so the level stays
   declarative and nothing is patched up after the spawn. In `src/prefabs.ts`:

   ```ts
   /** Tag: this NPC runs the `smith` conversation in `src/dialogue.json`. */
   export const Smith: Record<string, never> = {};

   /** The smith: a third person to talk to. */
   export const SmithPrefab = prefab({
     name: 'smith',
     body: NPC_BODY,
     character: 'char.guide',
     components: [Interactable, Npc, Smith],
   });
   ```

3. **Point `scriptOf` at the tag.** One line in `src/systems/dialogue.ts`
   chooses the key:

   ```ts
   export function scriptOf(ctx: GameContext, npc: number): string {
     if (hasComponent(ctx.world, npc, Smith)) return 'smith';
     return hasComponent(ctx.world, npc, Guide) ? 'guide' : 'wanderer';
   }
   ```

4. **Put them in the level.** A point in `src/arena.ts` and an entry in the
   `spawns` list in `src/game.ts`, lifted by `NPC_CENTRE` like the others.

That is the whole recipe. Everything else is already done for you:
`character.setExpression` and `character.lookAt` go out for every line, and
`dialogueState.active` freezes the hero while anyone is talking. Both are the
dialogue system's job, not the script's.

Whether any of it is _drawn_ is the host's decision, not the script's. Out of
the box the NPC is a capsule and the expression and the gaze are recorded on
`adapter.animationOf(entity)` with one warning. Give the template a character
bridge — [Give an NPC a face](./give-an-npc-a-face.md) — and the same commands
move a real splat head, with nothing in `src/` changing.

## Verify

```sh
npm test -w templates/third-person
npm run dev -w templates/third-person
```

Walk up to the smith. The HUD shows `speaker  Smith` and the first line, `E`
advances, and the question offers `1  yes` and `2  no`. In the headless tests,
`scripts.smith.lines` is readable straight out of the import and
`dialogueState.script` is `'smith'` once the conversation starts.

## See also

- [Build your first adventure](../start/03-first-adventure.md) — the whole loop
- [Add an interactable](./add-an-interactable.md) — the other thing `E` can start
- [Add a locomotion state](./add-a-locomotion-state.md) — what the hero does meanwhile
- [Characters](../concepts/characters.md) — what expressions and gaze will drive
