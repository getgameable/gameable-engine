# Install

## What you need

| Requirement      | Version        | Why                                                                 |
| ---------------- | -------------- | ------------------------------------------------------------------- |
| Node.js          | >= 24          | Pinned in `.nvmrc`; `engine-strict=true` will refuse older versions |
| npm              | >= 11          | Workspaces and `overrides`                                          |
| A modern browser | WebGPU enabled | The renderer. WebGL is a fallback for splat worlds only             |
| Git              | any recent     | `create-gameable` runs `git init` for you                           |

Git LFS is **not** required to run a generated game, and not required to run
this repository's tests. It is only needed if you add real binary content of
your own.

Nothing else needs installing by hand. `jco`, `componentize-qjs` and its native
binding arrive with the game's own `npm install`, and `gameable doctor` tells
you if one of them did not.

## Start a game

```sh
npm create gameable my-game -- --template fps
cd my-game
npm run dev
```

That is a playable game: walk, shoot, kill three capsules, win. Open
`http://localhost:5173`, then edit `src/game.ts` and save.

`--template third-person` gives you the other scaffold, and
`--third-person` is a shorthand for it.

### Options

| Flag                | Does                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `--template <name>` | `fps` (default) or `third-person`                                  |
| `--third-person`    | shorthand for `--template third-person`                            |
| `--title "<text>"`  | human title for the page and the README; defaults to the directory |
| `--no-install`      | skip `npm install`                                                 |
| `--no-git`          | skip `git init`                                                    |
| `--aam`             | add the AvatarOS Asset Manager keys to `.env.example`              |
| `--force`           | write into a directory that already has files in it                |

With no arguments at all, and an interactive terminal, it asks for the directory
and the template. In CI — or when an agent runs it — it takes the defaults and
never blocks on a question nobody can answer.

The `--` before the flags is npm's, not ours: without it npm eats them.

## What you get

```
my-game/
├─ AGENTS.md            the rules, scoped to this game
├─ .env.example         copy to .env.local; VITE_-prefixed keys only
├─ index.html
├─ package.json         dev / build / preview / test
├─ public/              served at the site root
├─ src/
│  ├─ game.ts           the one defineGame call. Start here
│  ├─ assets.json       asset ids to files. The ids are the contract
│  ├─ prefabs.ts        entity templates
│  ├─ hud.ts
│  └─ systems/          one file per behaviour
├─ tests/
└─ vite.config.ts
```

`.gameable/` and `dist/` appear when you build, and both are gitignored.

## The commands

The template's npm scripts wrap [`gameable/cli`](../api/@gameable.cli.md):

| Command                     | Does                                                     |
| --------------------------- | -------------------------------------------------------- |
| `npm run dev`               | Vite in direct mode; edit `src/game.ts` and save         |
| `npm run dev -- --wasm`     | build the component first and serve it, to check parity  |
| `npm run build`             | componentize the guest, then `vite build`                |
| `npm run build -- --report` | the same, plus size and timing numbers, with budgets     |
| `npm test`                  | the smoke spec, headless                                 |
| `npx gameable doctor`       | check the toolchain; exit code is the number of failures |
| `npx gameable docs`         | where the `llms*.txt` bundles are on this machine        |

Direct mode is the default because a `jco componentize` run is about thirty
seconds and that is not a dev loop. The two modes share the same guest runtime
on purpose, and a parity test hashes both — if they diverge, that is an engine
bug, not a configuration difference.

## Verify

```sh
node --version          # v24.x
npx gameable doctor    # 0 failures
npm run dev             # http://localhost:5173
```

`doctor` checks node, npm, a single `three` instance, `src/assets.json` and the
files it references, the `gameable:engine` WIT package, jco, `componentize-qjs` and
its native binding for your platform. Every failure prints a copy-pasteable
fix. It cannot probe WebGPU from node, so it always prints the Chrome flags and
leaves that one to you.

If something is red, [Debug with doctor](../recipes/debug-with-doctor.md) walks
through the failures one at a time.

## Run from a checkout

To work on the engine and a game together, run the scaffolder from a clone of
the engine; the game it makes links back to that clone:

```sh
git clone https://github.com/getgameable/gameable-engine.git gameable
cd gameable
npm install
node packages/create-gameable/bin/create-gameable.mjs ../my-game --template fps
```

`npm install` is the only build step: every package declares a `gameable-source`
export condition, so the game resolves the engine straight from `packages/*/src`
with `file:` dependencies, and an engine change shows up in the game without a
publish.

The two templates also run in place, with no scaffolding at all:

```sh
npm run dev -w templates/fps            # http://localhost:5179
npm run dev -w templates/third-person   # http://localhost:5181
```

## Next

- [Hello world with your Gameable character](./01-hello-world.md)
- [Build your first FPS](./02-first-fps.md)
- [Ship it](./04-deploy.md)
- [The engine loop](../concepts/engine-loop.md)
- [Troubleshooting](../troubleshooting.md)

## Test a standalone consumer before publishing

Use Node 24 or newer. Build the engine and create ordinary npm tarballs:

```sh
npm install
npm run build
node tools/pack-consumer.mjs ../gameable-packages
```

Run the packed scaffolder outside the workspace (replace the version when it changes):

```sh
npm exec --package ../gameable-packages/create-gameable-0.0.0.tgz -- create-gameable ../my-adventure --template third-person --packages-dir ../gameable-packages
```

The generated project depends on the `gameable` tarball by an exact file path. It selects built package exports, including the packaged WIT and component entry, and carries its own lockfile and test runner. Keep the tarballs at the recorded relative paths or move them into the game's own `vendor` directory before installation. No workspace links or aliases to engine sources are needed. Add optional voice/conversation packages explicitly; scaffolding does not activate them.
