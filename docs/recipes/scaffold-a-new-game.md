# Scaffold a new game

## Goal

A playable game in its own directory, wired to the engine, with your name on it
and nothing to configure.

## Files you will edit

- `src/game.ts`
- `src/assets.json`

## Steps

1. Create it. The `--` is npm's: without it, npm eats the flags.

   ```sh
   npm create gameable my-fps -- --template fps
   cd my-fps
   npm run dev
   ```

   That is already a playable game. `--template third-person` gives you the
   other scaffold; `--title "Capsule Hunt"` sets the page title and the README
   heading; `--no-install` and `--no-git` skip those steps; `--aam` adds the
   AvatarOS Asset Manager keys to `.env.example`.

   With no arguments at all, and an interactive terminal, it asks. In CI, or
   under an agent, it takes the defaults and never blocks.

2. Make it yours. Everything is in `src/game.ts`:

   ```diff
    // src/game.ts
    export default defineGame({
      assets: './assets.json',
      world: 'arena',
   -  player: { spawn: [0, 1.7, 0], speed: 5, jump: 4.5, health: 100 },
   +  player: { spawn: [0, 1.7, 0], speed: 8, jump: 6, health: 150 },
      spawns: [
        { prefab: 'enemy', at: [6, 0, -4] },
   +    { prefab: 'enemy', at: [0, 0, -20] },
      ],
      rules: { win: (ctx) => ctx.count('enemy') === 0 },
      systems: [weapon, enemyAI, pickups],
    });
   ```

   New content is a manifest entry, never a path in code. Drop the file into
   `public/` and give it an id:

   ```diff
    // src/assets.json
      "assets": [
   +    { "id": "gallery", "type": "splat", "src": "gallery.spz" },
        { "id": "arena", "type": "splat", "src": "arena.spz" }
      ]
   ```

   Then `world: 'gallery'`. The ids are the contract across the wasm boundary;
   renaming one is a breaking change.

## Verify

```sh
npx gameable doctor    # 0 failures
npm run dev             # http://localhost:5173 — walk, shoot, win
```

Vite reloads on save. If the game behaves differently under `npm run build`,
that is a parity bug in the engine, not a configuration difference — the two
modes share the same guest runtime and a test hashes both.

## See also

- [Install](../start/01-install.md)
- [Build your first FPS](../start/02-first-fps.md)
- [Debug with doctor](./debug-with-doctor.md)
- `packages/create-gameable/README.md` — create-gameable
