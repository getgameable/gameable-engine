# ADR 0017: Feature modules: a game declares what it loads

- **Status**: Accepted — shipped with phase 1 of the multiplayer work (2026-10-02)
- **Date**: 2026-10-02
- **Plan decision**: the multiplayer spec, section 4.2
  (`specs/2026-10-02-multiplayer-and-feature-modules.md`), plan Task 0.1

## Context

Optional engine stacks were opted into by hand in each template's `main.ts`. The
character bridge, which brings the rig backends, the animator and the animated
splat fork, was a dynamic import the FPS and third-person pages each wrote out
themselves. Multiplayer is the next optional stack, and it has two sides: the
page needs a client and the room host needs a server, from the same game. Hard
rule 4 says a game never edits `packages/*`, so the switch has to live in the one
file an author edits, and a page that does not need a stack must not download it.

## Decision

A game declares its optional features in `defineGame({ features })`, for example
`features: { characters: true }`. `featuresOf` in `gameable` normalises the
block (a `false` key is the same as absent; every present feature gets an options
object).

`resolveFeatures(features, table)` in `gameable/core` maps each declared
feature to a loader from a per-side table and returns the loaded features in
order; an unknown feature is a `FeatureError` naming the known ones.
`bindFeatures(loaded, engine)` then binds each one to the booted engine. The
browser's table is `clientFeatures(overrides?)` at
`gameable/host/features`; the room host gets its own table when phase 3 adds a feature that has a server side.

A feature is an explicit factory behind a dynamic `import()`, never a
side-effect import: nothing registers itself by being imported.

The character bridge is the first feature. The templates boot through
`resolveFeatures` and `bindFeatures`, and page-owned options (callbacks, a splat
head's `headOffset`) travel in the `clientFeatures` overrides.

The page imports the game definition in both direct and wasm mode to read its
features. This deliberately corrects the spec, which had the guest build write a
`build/features.json`: the definition is already a plain module the page can
import, and a second file derived from it is one more thing that can go stale.

## Consequences

- A page downloads only what the game declares; a game without `characters` never
  fetches the rig stack.
- `EngineModule`, `order`, services and `createGameSlot` are unchanged; a feature
  contributes ordinary modules.
- A new feature is one table entry per side plus a package. A feature with no
  server entry does not exist on the server.
- The page now imports the game definition in wasm mode too, so the definition
  module's top level must stay cheap and side-effect free.
