# Turn on a feature

## Goal

Your game declares the `characters` feature, and the page loads the character
bridge (the rig stack behind `spawn-character`) only because it did.

## Files you will edit

- `src/game.ts`

## Steps

1. Declare the feature in the game definition. A feature set to `true` loads
   with its default options; a feature that is absent or `false` is never
   loaded and never downloaded.

   ```ts
   import { defineGame } from 'gameable';

   export default defineGame({
     // Optional engine features this game opts into; the page resolves each by name.
     features: { characters: true },
     assets: ['char.enemy'],
   });
   ```

2. Run the game. The page reads `features` from your definition, looks each
   name up in its table (`clientFeatures()` from `gameable/host/features`)
   and imports only those.

   ```sh
   npm run dev
   ```

3. Take the line out again, reload, and watch the network tab. With
   `features: { characters: true }` removed the page makes no request for the
   `characters` module, because its loader, a dynamic `import()` inside the
   table, is never called.

   ```ts
   import { defineGame } from 'gameable';

   export default defineGame({
     assets: ['char.enemy'],
   });
   ```

## Verify

The templates assert their declaration in `tests/game.test.ts`:

```sh
npx vitest run tests/game.test.ts
```

The `declares the characters feature` test passes when
`featuresOf(game)` equals `{ characters: {} }`. If you removed the line in step
3, put it back first, or that test fails.

## See also

- [Features: what a game declares](../concepts/modules.md#features-what-a-game-declares)
- `packages/sdk/README.md` — `featuresOf`
- [Use the sample character](./use-the-sample-character.md)
