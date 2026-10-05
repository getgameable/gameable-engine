# @gameable/llm-eval

## What

The headline metric for milestone M6: **can a small model, given only the repo
docs, make a working game change?**

One prompt is one experiment. The harness scaffolds a fresh game with
`create-gameable`, hands a model `llms-fps.txt` and the game's current source
and nothing else, applies whatever comes back, and then asks five questions in
order: does it typecheck, do the game's own tests still pass, does it build,
does it boot, and did it actually do the thing that was asked. A run writes a
machine-readable result file and a markdown scoreboard, and `triage.ts` turns
the failures into two kinds of commit — a **doc fix** or an **API
simplification**.

Three model backends, one interface: a hosted Anthropic model, a local Ollama
model over its native REST API, and a deterministic fake used by every test and
by `--dry-run`.

[HARNESS.md](./HARNESS.md) explains what is measured, the failure buckets and
the thresholds; this file is the package reference.

## When to use

- After changing documentation, a recipe, or the SDK surface, to find out
  whether the change helped a model that has never seen this repository.
- Before closing M6: the bar is **≥ 80%** for a hosted small model and
  **≥ 50%** for a local 7–8B one.
- Weekly, in CI, as a regression signal. See `ci/llm-eval.yml`.

Do not use it as a general test suite. It is slow, it spends money, and its
answer is a percentage, not a pass.

## Install

`tools/*` is deliberately outside the root `workspaces` glob, so this directory
carries its own install and its own lockfile:

```sh
npm install --prefix tools/llm-eval
```

That is only needed for a live Anthropic run — `@anthropic-ai/sdk` is its one
dependency and it is imported lazily. `--dry-run`, the Ollama client and the
whole test suite need nothing but the root install.

There is no build step. The harness is TypeScript that node 24 runs directly
through its built-in type stripping, which is why every relative import carries
its `.ts` extension.

## Minimal example

```sh
# Offline, free, no API key. This is what CI runs.
node tools/llm-eval/src/run.ts --dry-run

# The real thing. Needs GAMEABLE_LLM_EVAL_LIVE=1; nothing else can spend money.
GAMEABLE_LLM_EVAL_LIVE=1 node tools/llm-eval/src/run.ts --model claude-haiku-4-5 --prompts all

# A local 7–8B model, over Ollama's native API.
node tools/llm-eval/src/run.ts --model qwen2.5-coder:7b --provider ollama --prompts all

# What to change next.
node tools/llm-eval/src/triage.ts
```

```text
Gameable Engine llm-eval — claude-haiku-4-5 (anthropic)
  20 prompt(s), results -> tools/llm-eval/results
  add-shotgun                    pass  31.2s
  double-player-move-speed       pass  12.7s
  enemies-flee-at-low-health     FAIL (typecheck)  18.4s
  …
  17/20 passed (85%), bar is 80% for a hosted small model
    typecheck    2
    checks       1
  $0.19 · 7m 41s
```

## API

Command line — `node tools/llm-eval/src/run.ts`:

| Flag               | Does                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `--model <id>`     | `claude-haiku-4-5` (default), `claude-sonnet-5`, `claude-opus-5`, or an Ollama tag |
| `--provider <n>`   | `anthropic`, `ollama` or `fake`. Inferred from the model id                        |
| `--prompts <what>` | `all`, `fps`, `third-person`, or a comma-separated list of ids                     |
| `--effort <level>` | `low`/`medium`/`high`. Ignored on Haiku, which rejects it. Default `medium`        |
| `--template-dir`   | scaffold from here instead of `templates/<name>`                                   |
| `--dry-run`        | one prompt, fake client, canned correct answer. Offline and free                   |
| `--list`           | print the task set                                                                 |
| `--keep`           | keep the scaffolded games instead of deleting them                                 |
| `--fresh`          | reinstall the shared npm cache first                                               |

Environment:

| Variable                   | Does                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `GAMEABLE_LLM_EVAL_LIVE=1` | **required before any paid API call**                         |
| `GAMEABLE_LLM_EVAL_WASM=1` | score the full `jco componentize` path instead of `--no-wasm` |
| `GAMEABLE_LLM_EVAL_E2E=1`  | also boot the built game in headless Chromium                 |
| `GAMEABLE_LLM_EVAL_SLOW=1` | run the scaffold-and-score test in the vitest suite           |
| `GAMEABLE_LLM_EVAL_CACHE`  | where the one shared npm install lives                        |

Modules:

- `src/model.ts` — `ModelClient`, `createAnthropicClient`, `createOllamaClient`,
  `createFakeClient`, `estimateCost`, `PRICING`.
- `src/prompts/*.json` — the task set, as data. `src/prompts.ts` loads,
  validates, selects and runs the grep assertions.
- `src/request.ts` — the bundle and the game's source into one cacheable
  `system`; the task and the output contract into `user`.
- `src/fences.ts` — the only module that trusts a model: parses
  `// file: <path>` blocks and refuses anything outside `src/`.
- `src/workspace.ts` — scaffold, one shared `npm install`, junctioned
  `node_modules`, and the baseline probe.
- `src/stages.ts` — `typecheck`, `unit`, `build`, `e2e`.
- `src/score.ts`, `src/scoreboard.ts` — the verdict and the markdown.
- `src/triage.ts` — doc fix versus API simplification.

Tests: `npx vitest run -c tools/llm-eval/vitest.config.ts`.

## Gotchas

- **`node_modules` is one install, junctioned twenty times.** A scaffolded FPS
  is 401 MB; installing per prompt is 18.6 s each and 8 GB, copying is 11.4 s
  each, and a directory junction is 0.16 s and 401 MB total. Measured, not
  guessed — the table is at the top of `src/workspace.ts`. `--install-links`
  was rejected because it makes npm _copy_ the `file:` engine packages, which
  is both the slow column and a frozen snapshot of the engine. Prompts are
  scored **sequentially** because they share that one directory.
- **The untouched scaffold is scored first.** `typecheck`, `unit` and `build`
  run on the pristine game before a model sees anything — about four seconds,
  once per run. Any stage already red measures the repository, not the model,
  so it is skipped for every prompt and called out at the top of the
  scoreboard. A red `typecheck` additionally stamps the run "not valid" and
  exits 2: a generated game links the engine with `file:` and therefore
  typechecks the engine's live source, so a red `packages/` is a red eval.
- **The shared install refreshes itself when a template changes.** The cache
  records the template's newest mtime and re-scaffolds over itself when the
  template is newer, keeping `node_modules`. Without that, a cache built an
  hour ago silently evaluates an hour-old template.
- **Known template gaps are declared, not hidden.** `templates/fps` does not
  declare `@types/node`, `@webgpu/types`, `@types/three` or `gameable/assets`
  — inside the monorepo they are hoisted root devDependencies, so it typechecks
  in CI and fails the moment it is scaffolded. The harness adds them to the
  shared install _only when the pristine scaffold genuinely fails without them_
  and lists them at the top of the scoreboard. When the template is fixed, the
  list goes empty on its own.
- **A half-written template is skipped, not failed.** `resolveTemplate` wants
  `package.json` **and** `src/game.ts`. Prompts whose template is not ready are
  reported under "Not attempted" and excluded from the denominator.
- **The output contract is whole files, not diffs.** Small models get line
  numbers and hunk headers wrong far more often than they get code wrong, and a
  wrong diff is indistinguishable from a wrong answer. The cost is output
  tokens, which is why `build` runs `--no-wasm` and the bundle is cached.
- **Nothing spends money without `GAMEABLE_LLM_EVAL_LIVE=1`.** The guard is in
  `createAnthropicClient`, not in the CLI, so a test that constructs a client
  by accident throws instead of billing.
- **`results/` is gitignored.** A scoreboard is evidence of one run on one
  machine. CI uploads it as an artifact; it is not source.
