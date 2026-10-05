# AGENTS.md

## What this repository is

**Gameable Engine** (npm package `gameable`, scaffolder `create-gameable`, CLI
`gameable`) is a browser game engine. Worlds are **gaussian splats** rendered by
three.js r186's native `GaussianSplat` on a `WebGPURenderer`. **All game logic**
is TypeScript compiled to a QuickJS **WebAssembly component**; bitecs 0.4 is the
ECS and it lives inside that guest. The host owns rendering, Jolt physics,
input, audio, assets and characters.

### Two names for every package

One npm workspace: the engine is split into private workspace packages under
`packages/*`, named `@gameable/<name>` (`@gameable/core`, `@gameable/sdk`), and
they are published together as one package, `gameable` (`packages/gameable`),
whose subpaths re-export them (`gameable/core`, and `gameable` itself for the
SDK). `packages/gameable/entries.mjs` is the table.

- **Code inside `packages/*/src`** imports its siblings by workspace name:
  `import { createEngine } from '@gameable/core'`.
- **Everything a user sees or copies** — templates, examples, fixtures, docs,
  READMEs, doc comments, `llms*.txt` — uses the public subpath:
  `import { createEngine } from 'gameable/core'`, and game code imports only
  from `gameable`.
- A new export in a workspace package needs a row in `entries.mjs`;
  `npm run gen -w packages/gameable` writes the rest, and the test suite fails
  until it is there.

## Read this before writing a game

If you are building a game, do **not** read the whole repository. Read one
bundle:

- `llms-fps.txt` — first-person shooter.
- `llms-third-person.txt` — third-person adventure.
- `llms-visit.txt` — a character's page.
- `llms-multiplayer.txt` — rooms and Play Solo.
- `llms-character.txt` — splat characters in a game.

They are generated, committed and size-budgeted. `llms.txt` is the index and
`llms-full.txt` is the core corpus (360 KB cap) if you genuinely need it: everything
except the topic bundles' pages (rooms, splat characters), which it points to.

Then: copy a template, edit `src/game.ts`, run `npm run dev`, follow one recipe.
That is the whole path.

## Commands

| Command                 | Does                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `npm install`           | The only build step. Packages resolve to `src/` via the `gameable-source` condition |
| `npm run dev`           | Points you at an example; there is no root dev server                               |
| `npm run build`         | `tsdown` build of every package                                                     |
| `npm run typecheck`     | `tsc -b --noEmit`, then `tools/typecheck-apps.mjs` for templates and examples       |
| `npm run lint`          | ESLint flat config, type-aware                                                      |
| `npm run format`        | Prettier write; `npm run format:check` to verify                                    |
| `npm test`              | vitest across `packages/**`, `templates/**` and `tests/**`                          |
| `npm run test:boundary` | The real component in node: jco componentize + transpile, smoke and parity          |
| `npm run test:e2e`      | Playwright: splat-viewer goldens and the FPS template, direct mode                  |
| `npm run test:e2e:wasm` | The same e2e suite against the compiled wasm guest                                  |
| `npm run test:llm-eval` | Score a small model on ~20 prompts against the docs bundles                         |
| `npm run docs:api`      | TypeDoc markdown into `docs/api/` (generated, gitignored)                           |
| `npm run docs:dev`      | VitePress dev server, port 5173. Needs `docs:api` first                             |
| `npm run docs:build`    | VitePress production build. Needs `docs:api` first                                  |
| `npm run docs:games`    | Build the playable examples into `docs/public/play/` for the docs site              |
| `npm run docs:llms`     | Regenerate `llms.txt`, `llms-full.txt` and the task bundles                         |
| `npm run docs:lint`     | Dead links, templates, recipe file paths, snippets, llms freshness, size budgets    |
| `npm run check`         | lint + typecheck + test + docs:lint. **Run this before every commit.**              |

Scripts must work in Git Bash and in `cmd`. Never put PowerShell-only syntax in
a package script. Build helpers are node `.mjs` files taking array arguments
with forward-slashed paths, because Windows paths break shell-string pipelines.

## Hard rules

1. **Import `three/webgpu`, `three/tsl` or `three/addons/...` — never bare
   `three`.** The bare entry point pulls in the WebGL renderer and can create a
   second three singleton. `gameable/no-bare-three-import` fails the build.
2. **No allocation in `fixedUpdate`, `update`, or any guest system.** These run
   60+ times a second. Preallocate typed arrays, memoise subarrays, pool command
   objects, use dirty flags.
3. **Assets are addressed by string id only.** Never a path, never a URL, in
   game code or across the wasm boundary. Add a manifest entry instead.
4. **When the task is "make a game", never edit `packages/*`.** Edit the game's
   own `src/`. If a game genuinely cannot be written without an engine change,
   say so and stop — that is a missing feature, not a workaround.
5. **Never edit generated files.** `llms*.txt`, `docs/api/`, `docs/wit/`,
   `packages/*/src/generated/` and `package-lock.json` are outputs. Change the
   generator and rerun it.
6. **Run `npm run check` before committing.** A red `check` is not a commit.
7. **Nothing calls `navigator.gpu.requestAdapter()`.** The renderer owns the
   `GPUDevice`; everything else borrows `renderer.backend.device`. Bootstrap
   order is `initWebGPUPatches()` -> `renderer.init()` -> ORT device -> lift
   pipelines.
8. **Private three internals live in exactly one file.** All
   `renderer.backend.*` access goes through `packages/splat/src/backendBuffers.ts`.
   Do not reach into the backend anywhere else.
9. **Seed randomness inside `init()` from `env.seed()`.** Wizer snapshots the
   QuickJS heap at build time, so module-level state is frozen into the binary
   and every run would be identical.
10. **The guest gets one export per frame.** `tick(frame-input) -> frame-output`.
    Continuous data is packed `list<f32>`; structural changes are commands.
    Physics queries are the only synchronous host imports. Do not add a
    per-entity call.
11. **Keep direct mode and wasm mode identical.** They share the guest runtime
    on purpose, and a parity test hashes both. If they diverge, that is a bug in
    the engine, not a configuration difference.
12. **Every exported symbol gets TSDoc with a runnable `@example`.** ESLint
    enforces it on `packages/*/src/index.ts`, and the docs bundles are built
    from it.
13. **Dependencies are pinned exactly** (`save-exact=true`), and `three` is
    additionally pinned in root `overrides`. Do not widen a range. The one
    exception is what the published packages ask of an app: their `three` peer
    dependency is `>=0.186.0 <0.187.0`, so an app on a later 0.186 patch installs
    (an exact peer pin failed `npm install` the day three shipped 0.186.1). The
    repository itself still develops and tests against the exact pin.
14. **Placeholder assets are CC0 only** and capped at 12 MB. Anything with
    attribution requirements does not go in `gameable/placeholder`.

## Repository map

| Path                                                      | What                                                      |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `packages/core`                                           | Engine, loop, module registry, cameras, asset registry    |
| `packages/sdk`                                            | The only import game code needs; owns the key table       |
| `packages/wasm-host`                                      | Component loading, host bindings, direct mode             |
| `packages/splat`                                          | Splat loading plus the `AnimatedGaussianSplat` fork       |
| `packages/character`, `animation`                         | Splat avatars (ORL and GNM rigs) and the layered animator |
| `packages/assets-aosrig`                                  | The `aosrig_v0` sample character GLB (MHR body, GNM head) |
| `packages/physics-jolt`, `input`, `audio`, `assets*`      | Host modules                                              |
| `packages/cli`, `create-gameable`, `vite-plugin-gameable` | Tooling                                                   |
| `packages/test-harness`                                   | Mock host, record/replay, determinism helpers             |
| `templates/fps`, `templates/third-person`                 | The two shipped scaffolds                                 |
| `templates/visit`                                         | A character's page: the studio exporter's inputs in       |
| `examples/`, `fixtures/`                                  | Viewers, a Rust guest, and smoke content                  |
| `tests/boundary`, `tests/e2e`                             | The real component in node; Playwright in a browser       |
| `wit/`                                                    | The `gameable:engine` WIT world                           |
| `docs/`                                                   | VitePress source: how to use the engine, nothing else     |
| `adr/`                                                    | Decision records: why the engine is the way it is         |
| `STYLE.md`                                                | The Gameable look: tokens, type, components, rules        |
| `tools/docs/`                                             | `gen-llms.mjs`, `lint.mjs`, `bundles.json`                |
| `tools/eslint/`                                           | Local hard-rule plugin                                    |
| `tools/llm-eval/`                                         | The small-model scoreboard (M6)                           |

## Conventions

- TypeScript everywhere, ESM only, `type: "module"`.
- Package READMEs use six fixed headings: What, When to use, Install, Minimal
  example, API, Gotchas. `docs:lint` enforces this.
- Recipes use five fixed headings: Goal, Files you will edit, Steps, Verify, See
  also — and edit at most two files. `tools/docs/recipe-template.md` is the shape.
- ADRs are immutable once accepted; supersede, do not rewrite.
- Commit messages: `type: summary`, imperative, lowercase type.
- **Anything with a look follows `STYLE.md`** — the Gameable
  tokens (dark canvas, mint accent, pink for errors, Plus Jakarta Sans, pills
  and 16px cards) copied from the `aos-gameable-cc` frontend. Docs theme,
  template shells, the HUD, overlays and error banners all use them. Do not
  invent a colour, radius or font.

## When you are stuck

`docs/troubleshooting.md` is symptom-first. `docs/glossary.md` decodes the
jargon. `adr/` explains why something is the way it is — read the ADR
before proposing to change a decision.
