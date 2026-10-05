# Recipes

A recipe answers exactly one question — "how do I add a double jump", "how do I
put an NPC in the scene" — and is completable by editing **at most two files**.
If a task needs three files, it is two recipes or a design problem.

> [docs/recipes/index.md](../../docs/recipes/index.md) is the list. This page is
> the shape every recipe must have, and `npm run docs:lint` enforces it — the
> five headings, the two-file limit, and that every path under "Files you will
> edit" resolves inside a template.

## The mandatory template

Every file in `docs/recipes/` (except this one) has exactly these five level-2
headings, in this order:

```md
# <Verb the thing> (a title, not a question)

## Goal

One or two sentences. What the reader will have when they are done, stated as an
observable outcome, not as an implementation.

## Files you will edit

A list of at most two paths, relative to the game root. If the list is longer,
split the recipe.

## Steps

Numbered. Each step is one edit or one command. Show the code, do not describe
it. Diffs are welcome; full-file dumps are not.

## Verify

The exact command to run and what the reader should see. "It works" is not a
verification. Prefer something a test could assert.

## See also

Two to four links: the concept page behind the recipe, the package README, and
the neighbouring recipes.
```

## Rules

- **Two files maximum** in "Files you will edit".
- **Never `packages/`.** A recipe that requires editing the engine is a missing
  feature; file it instead of documenting it.
- **Assets by id.** Recipes add manifest entries; they never hardcode a URL.
- **No allocation in systems.** Recipe code runs every fixed step and is copied
  verbatim by readers and by language models. Preallocate.
- **Import `three/webgpu`**, never bare `three`, on the rare occasion a recipe
  touches three directly.
- **Runnable code only.** Snippets are extracted and typechecked by
  `npm run docs:lint`; pseudo-code will fail the build.

## Naming

`docs/recipes/<verb>-<noun>.md`, kebab-case: `add-double-jump.md`,
`spawn-an-npc.md`, `play-a-sound.md`. The filename is the slug in the sidebar.

## See also

- [All recipes](../../docs/recipes/index.md)
- [Build your first FPS](../../docs/start/02-first-fps.md)
- [ECS and game code](../../docs/concepts/ecs.md)
- [Troubleshooting](../../docs/troubleshooting.md)
