# AGENTS.md

## What this is

A character's page built on Gameable Engine: the character stands in its place,
greets whoever visits, and talks. It already works for any character the
studio exports. You are here to give it jobs — a quest, a shop counter, a quiz,
a dance on request — not to finish it.

## The one rule

**Edit `src/game.ts`.** It holds the rules (`rules`: views, distances, the show
routine, the life clips) and everything the character does and when. The page
tells it what happens as short status lines on the character's conversation
channel (the table at the top of the file) and it answers with the camera,
clips, gaze, facing, `character.say` and `conversation.command`.

| File              | What lives there                                                  |
| ----------------- | ----------------------------------------------------------------- |
| `src/game.ts`     | The rules and the behaviour. Start here.                          |
| `src/visit.ts`    | The input contract: the exporter's parameters. Add a field here.  |
| `src/main.ts`     | The host: boot, the phone load, status lines to the game. Rarely. |
| `src/stage.ts`    | The place or the white world. Rarely.                             |
| `src/thing.ts`    | A thing's page (no character, no talk). Rarely.                   |
| `src/talk.ts`     | The conversation relay, microphone and lip-sync. Rarely.          |
| `src/controls.ts` | Touch gestures as the input the game reads. Rarely.               |
| `src/ui.ts`       | Words on the page.                                                |

**Never edit anything under `packages/`.** If the page cannot be written
without an engine change, say so and stop.

## Hard rules

1. **`src/game.ts` runs inside the wasm guest.** No DOM, no `fetch`, no clock,
   no `Math.random()`. The only way out is a command; the facades build them.
2. **No allocation per step.** Parse status lines only when they arrive; reuse
   the module-level vectors.
3. **Reset every module-level variable in `init`.** The wasm build freezes
   module state into the binary.
4. **A new thing the page must tell the game is a new status line.** Send it
   with `talk.tell('<key>:<value>')` in `src/main.ts` and read it in
   `status()` in `src/game.ts`. Document it in the table at the top.
5. **A new input from the studio is a new field in `src/visit.ts`**, with a
   query parameter and a JSON field, same-origin addresses only, and a test in
   `tests/visit.test.ts`.
6. **Never show a vendor or pipeline name on the page.**

## Recipes

- **A reaction to a word** (dance when someone says "dance"): in `update`, on
  an `input` event whose text matches, `play('ual_dance', 6)`. Only clips the
  rig carries play; the rest are skipped.
- **Another start view**: add an entry to `rules.views` (shares of the head
  height) and its name to `VIEW_ALIASES` in `src/visit.ts`.
- **A routine for the show**: edit `rules.show`, `[clip, seconds]` in order.
- **Talking only in one spot**: in `attend`, set `near` from the visitor's
  distance to that spot instead of to the character.

## Commands

| Command         | Does                                                    |
| --------------- | ------------------------------------------------------- |
| `npm run dev`   | Dev server on port 5188, the game run as TypeScript     |
| `npm test`      | The contract and the rules, headless                    |
| `npm run build` | The game compiled to a wasm component + the page bundle |
