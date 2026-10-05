# ADR 0008: Docs are markdown once: VitePress, TypeDoc markdown, generated llms bundles

- **Status**: Accepted — shipped in M0, extended in M6
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 8

## Context

Two audiences read these docs: humans browsing a site, and small language models
that must build a working game from a context window. Maintaining two corpora
guarantees they diverge.

## Decision

Author everything as markdown once.

- **VitePress** renders the site from `docs/`. Its sidebar is **built from the
  filesystem** by `docs/.vitepress/config.ts`, with each entry's text taken from
  the page's first level-1 heading, so a recipe or an ADR appears the moment its
  file lands. `ignoreDeadLinks` stays `false`.
- **TypeDoc with `typedoc-plugin-markdown`** emits one markdown page per package
  into `docs/api/`, driven by `npm run docs:api`. The directory is generated and
  gitignored; `docs:api` runs before `docs:build` in CI, and `docs:lint`
  generates it when it is missing.
- **`tools/docs/gen-llms.mjs`** concatenates a fixed file order into
  `llms-full.txt` (hard cap 300 KB), writes a spec-style `llms.txt` index (under
  4 KB) and the two task bundles, `llms-fps.txt` and `llms-third-person.txt`
  (64 KB each), from `tools/docs/bundles.json`. All four are committed.
- Every bundle opens with the same **"How to use these files"** preamble: read
  `AGENTS.md`, copy a template, edit `src/game.ts` and `src/prefabs.ts`, run
  `npm run dev`, and ask for a recipe by name. A bundle handed to a model with no
  instructions is read as reference material and then improvised over.
- `AGENTS.md` is capped at 150 lines and `CLAUDE.md` is a stub pointing at it.

## Consequences

- One source of truth. The bundles cannot drift: `docs:lint` regenerates them
  into a temp directory and diffs against the committed copies, so a doc edit
  without a `docs:llms` run is a red build.
- Size budgets are enforced in CI, so the corpus stays inside a small model's
  context. `docs:lint` warns at 90% and the failure message prints the ten
  largest files in the corpus, because a budget failure with no list of what is
  eating it is not actionable.
- Adding a doc page means deciding where it sits in the bundle order.
  `corpusFiles()` takes a preferred order per directory and appends anything it
  does not recognise, so the decision is optional but available.
- Three things are deliberately outside `llms-full.txt`, and all three are on the
  site and in `llms.txt`: `docs/recipes/README.md` (the authoring template — a
  model is writing a game, not a recipe), `docs/schemas/*.json` (11 KB restating
  what `docs/concepts/assets.md` says in prose), and `docs/concepts/llm-eval.md`
  (how this project measures models — the one page whose audience is not the
  reader of the bundle). The corpus is everything a model needs to build a game,
  which is not the same as every file under `docs/`.
- `docs:lint` also checks what prose alone cannot: every recipe's "Files you will
  edit" paths resolve inside a template, every `ts` snippet parses, every
  `@gameable/*` symbol a snippet imports is really exported, that no page links
  outside `docs/` (VitePress cannot route it), and that no unfinished-work marker
  survives in a page.
- The TypeDoc pages exclude `packages/splat/src/three-fork/`. It is three's own
  file plus marked insertions, byte-verified against upstream, and its JSDoc
  carries ~118 `{@link}`s into three's class tree; rewriting them would break the
  diff, so the fork is documented by `UPSTREAM.md` instead.
