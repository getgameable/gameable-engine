# The LLM evaluation harness

Every other test in this repository asks whether the engine works. This one
asks whether the **documentation** works.

The premise of `llms-fps.txt` is that a model which has never seen this
repository can read one file, copy a template, and write a working game. That
is a claim, and a claim that nobody measures rots. `tools/llm-eval/` measures
it, on about twenty realistic change requests, and reports a percentage.

## What is measured

One prompt is one experiment:

1. **Scaffold.** `create-gameable <tmp> --template fps --no-install --no-git`,
   a fresh directory every time. No state survives between prompts.
2. **Ask.** The model gets a `system` message containing the docs bundle
   (`llms-fps.txt`) followed by the complete current contents of the files it
   is likely to change, and a `user` message containing the task and an output
   contract. It gets nothing else — no repository, no search, no follow-up.
3. **Apply.** The answer is one or more fenced blocks introduced by
   `// file: <relative path>`, each holding a whole new file. Paths outside
   `src/` are refused and recorded.
4. **Score.** Five stages, in order, each a different question:

| Stage       | How                                | The question                          |
| ----------- | ---------------------------------- | ------------------------------------- |
| `typecheck` | `tsc -p tsconfig.json --noEmit`    | did it use APIs that exist?           |
| `unit`      | the template's own vitest suite    | did it break the game's own rules?    |
| `build`     | `gameable build --no-wasm`         | would a player get a playable bundle? |
| `e2e`       | `vite preview` + headless Chromium | does it boot and draw?                |
| `checks`    | grep assertions from the prompt    | did it do the thing that was asked?   |

A prompt **passes when every stage that ran, passed**. A stage that could not
run on this machine — no GPU, no browser — is neither a pass nor a failure; the
scoreboard lists it separately rather than quietly inflating the number.

`checks` is the stage that stops the metric being a compiler test. "Add a
shotgun that fires 5 pellets" can typecheck, pass the unit tests and build
while changing nothing at all, so each prompt carries a handful of grep-style
assertions — the produced files must mention pellets, must still raycast, must
have a spread angle. They are deliberately loose: they assert that the change
happened, not that it was written the way a particular person would write it.

## Why whole files and not diffs

The output contract asks for complete files. Small models get hunk headers and
line numbers wrong far more often than they get code wrong, and a malformed
diff is indistinguishable from a wrong answer — which would make the eval
measure patch formatting instead of comprehension. Whole files cost output
tokens; that is the trade, and it is why the docs bundle is prompt-cached and
why `build` skips the componentize step by default.

## The failure buckets

A pass rate is not actionable. The cause of each failure is, so every failure
is attributed to the _first_ stage that went wrong:

| Bucket      | Means                                                   |
| ----------- | ------------------------------------------------------- |
| `typecheck` | used an API that does not exist, or got the types wrong |
| `unit`      | compiled, but broke the game's own rules                |
| `build`     | typechecked, but produced nothing playable              |
| `e2e`       | built, but did not boot                                 |
| `checks`    | built and ran, but did not do what was asked            |
| `refusal`   | the model declined the task                             |
| `truncated` | the model hit its output ceiling mid-answer             |

`tools/llm-eval/src/triage.ts` takes those and produces two kinds of commit:

- **doc fix** — the API exists and works and the bundle never showed it. The
  model could not have known. Fix the documentation.
- **API simplification** — several prompts independently reached for the same
  symbol that does not exist. That is the shape the API should have had. Fix
  the engine, not the prose.

The signal is a diff: every identifier the model imported from
`gameable`, and every symbol `tsc` said was missing, against what
`packages/sdk/src/index.ts` actually exports and what the bundle actually
mentions.

## Thresholds

The bars the suite is held to:

| Model                                   | Bar       |
| --------------------------------------- | --------- |
| hosted small model (`claude-haiku-4-5`) | **≥ 80%** |
| local 7–8B (via Ollama)                 | **≥ 50%** |

Two models, because they fail differently and each tells you something the
other does not. A hosted small model failing means the documentation is
genuinely ambiguous. A local 7–8B model failing where the hosted one succeeds
usually means the documentation is _long_ rather than wrong — the answer is in
there, but not where a small context finds it.

## How to run it

```sh
# Offline, free, no API key. Validates the whole pipeline end to end.
node tools/llm-eval/src/run.ts --dry-run

# The headline number.
GAMEABLE_LLM_EVAL_LIVE=1 node tools/llm-eval/src/run.ts --model claude-haiku-4-5 --prompts all

# The local half of the bar.
node tools/llm-eval/src/run.ts --model qwen2.5-coder:7b --provider ollama --prompts all

# What to change next.
node tools/llm-eval/src/triage.ts
```

`GAMEABLE_LLM_EVAL_LIVE=1` is not a convention — no paid call can be made without
it, because the guard is in the client constructor.

A run writes `tools/llm-eval/results/<timestamp>-<model>.json` and a markdown
scoreboard at `results/latest.md`.

## What it costs

The docs bundle is ~59 KB and identical for every prompt in a run, so it goes
in `system` behind one `cache_control` breakpoint: written to the cache once,
read back nineteen times at a tenth of the price. Measured from the dry run's
token counts, at `claude-haiku-4-5` rates of $1 / $5 per MTok:

|                                                   | Tokens                            | Cost        |
| ------------------------------------------------- | --------------------------------- | ----------- |
| System prompt (bundle + `game.ts` + `prefabs.ts`) | ~17.3k                            | —           |
| First call (cache **write**, ×1.25)               | 17.3k + ~200 in, ~1.1k out        | **$0.0275** |
| Every later call (cache **read**, ×0.1)           | 17.3k cached + ~200 in, ~1.1k out | **$0.0076** |
| **Full 20-prompt run**                            |                                   | **≈ $0.17** |

Prompts that rewrite three files rather than one push output to ~3k tokens,
which takes a full run to roughly **$0.35**. Either way a weekly scoreboard
costs less than ten dollars a year, which is the argument for running it
weekly rather than arguing about it.

A local model costs nothing per token; there the number to watch is wall clock.

## The baseline, and when a run is invalid

Before any model is asked anything, the harness scores the **untouched**
scaffold on `typecheck`, `unit` and `build`. It takes about four seconds and it
is the difference between "the model failed" and "the repository is mid-rewrite".

Anything already red there is red for reasons that have nothing to do with a
model, so it is skipped for every prompt and named at the top of the
scoreboard. Two cases in particular:

- **A red `typecheck` invalidates the whole run.** A scaffolded game links the
  engine packages with `file:`, so it typechecks the engine's **live source** —
  a red `packages/` makes a red eval, and 0% would be a lie about the model.
  The harness says _"this run is not valid"_, names the compiler errors, and
  exits 2.
- **A red `unit` or `build` disqualifies only that stage.** A template's own
  test suite can be halfway through a rewrite; the remaining stages are still a
  fair measurement, and the pass rate is computed without the disqualified one.

The same probe covers the other direction: when the pristine scaffold needs
packages the template does not declare, the harness adds them to its shared
install and lists them at the top of the scoreboard, so a template gap is never
read as a model failure.

## Troubleshooting

### `refusing to make a paid API call`

By design. Nothing in the harness may spend money unless `GAMEABLE_LLM_EVAL_LIVE=1`
is set, and the guard is in the client constructor rather than the CLI, so it
catches a test that builds a client by accident as well as a mistyped command.

```sh
GAMEABLE_LLM_EVAL_LIVE=1 node tools/llm-eval/src/run.ts --model claude-haiku-4-5 --prompts all
```

To try the plumbing without spending anything, use `--dry-run`, which is
offline and needs no key.

### The scoreboard says "this run is not valid"

The untouched scaffold did not typecheck, so nothing downstream of it means
anything. A generated game links the engine packages with `file:`, which means
it typechecks the engine's **live source** — a red `packages/` is a red eval.
Run `npm run typecheck` at the repository root, fix what it reports, and run
the eval again. The harness exits 2 for this rather than reporting 0%.

### The scoreboard says the untouched scaffold already fails `unit` or `build`

Same probe, milder verdict. The harness scores the pristine scaffold on
`typecheck`, `unit` and `build` before asking a model anything; a stage that is
already failing measures the repository rather than the model, so it is skipped
for every prompt and the pass rate is computed without it. Usually it means a
template's own test suite is mid-rewrite. Fix it and run the eval again for a
complete score.

### The eval is scoring an old copy of a template

It should not: the shared install records the template's newest mtime and
re-scaffolds over itself when the template is newer, keeping `node_modules`. If
you have edited something the mtime walk skips (`node_modules`, `dist`,
`build`, or a dotfile), pass `--fresh` to rebuild the cache from nothing.

### Every prompt fails `typecheck` with `TS2688: Cannot find type definition file`

The scaffolded game is missing packages the template does not declare. Inside
this monorepo `@types/node`, `@webgpu/types`, `@types/three` and
`gameable/assets` are hoisted root devDependencies, so `templates/fps`
typechecks in CI and fails the moment it is scaffolded anywhere else.

The harness detects this, adds them to its shared install, and lists them at
the top of the scoreboard — so a template gap is never read as a model failure.
The real fix is to add the four to `templates/fps/package.json`. When that
happens the repair list goes empty on its own.

### A prompt is reported under "Not attempted"

Its template is not finished. The harness wants both `package.json` and
`src/game.ts` before it will scaffold from a template directory, because a
half-written template would fail every stage and blame the model. Prompts in
that state are excluded from the denominator, not counted as failures.

### `npm install` runs on every prompt, and a run takes forever

The shared install cache was not reused. It lives at
`%TEMP%/gameable-llm-eval/<template>` (override with `GAMEABLE_LLM_EVAL_CACHE`) and
every game directory gets a directory junction to its `node_modules` — 0.16 s
instead of 18.6 s. If junctions are refused by policy or by the filesystem, the
harness falls back to copying and says `linkMode: "copy"` in the result file.
On Windows a junction needs no elevation; a _symlink_ does, which is why the
harness asks for a junction specifically.

### The `e2e` stage is always skipped

It is off unless `GAMEABLE_LLM_EVAL_E2E=1`, and it needs a browser:

```sh
npx playwright install chromium
GAMEABLE_LLM_EVAL_E2E=1 GAMEABLE_LLM_EVAL_LIVE=1 node tools/llm-eval/src/run.ts --prompts all
```

Playwright is resolved from the engine checkout, not from the scaffolded game —
a starter project deliberately does not depend on it.

### The model answered, but nothing was applied

Look at `results/transcripts/<run>/<prompt>/response.md`. Either it wrote prose
instead of fenced blocks, or it asked for a path outside `src/`, which the
harness refuses and records in `rejectedPaths`. A `truncated` bucket means it
ran out of output tokens mid-file; raise `--max-tokens`.

### The Ollama client cannot connect

It talks to Ollama's **native** API at `POST /api/chat`, not the
OpenAI-compatible shim, because the shim normalises away the errors the eval
exists to collect. Check the daemon is up, and pass `--ollama-url` if it is not
on `http://localhost:11434`.

### The harness's own tests are not collected by `npm test`

The root `vitest.config.ts` includes `packages/**`, `templates/**`,
`examples/**` and `tests/**`. Run them with their own config:

```sh
npx vitest run -c tools/llm-eval/vitest.config.ts
```

## See also

- [README.md](./README.md) — the flags, the modules and the measured numbers
- [The wasm boundary](../../docs/concepts/wasm-boundary.md)
