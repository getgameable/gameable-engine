# ADR 0010: Placeholder assets ship as an npm package, not as LFS content

- **Status**: Accepted — shipped in M2
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 10

## Context

The acceptance bar for the scaffolds is that `npm create gameable` produces a
game that runs with **zero edits**. Requiring Git LFS, an asset server or a
manual download before the first frame fails that bar, and LFS on a fresh
Windows machine is a common first-run failure.

## Decision

Ship CC0-only placeholder content as `gameable/placeholder`, capped at
12 MB. Templates depend on it like any other package. Enemies and the player are
capsules until splat characters land.

What shipped is **1.0 MB**, and every byte of it is _generated_ rather than
collected:

| File                       | What                                                        | How                                                                                        |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `arena.spz`                | 121,385 gaussians, SPZ v2, a 24 × 24 m arena and a sky dome | `scripts/gen-arena.mjs` scatters gaussians over analytic planes, boxes, a wedge and a dome |
| `arena.collider.bin`       | 98 vertices, 142 triangles                                  | the same generator, in a flat `u32/f32` container Jolt can take directly                   |
| `arena.spawns.json`        | 1 player, 6 enemy, 3 pickup points                          | —                                                                                          |
| `shot/hit/pickup/step.wav` | four effects, 0.13–0.54 s                                   | `scripts/gen-sfx.mjs`, oscillators and seeded noise                                        |
| `face_idle.arkit.json`     | 120 frames at 30 fps: one breath, two blinks                | `scripts/gen-face.mjs`, hand-authored ARKit curves                                         |

The generators are seeded, so `npm run generate -w packages/assets-placeholder`
reproduces the committed bytes exactly, and `prebuild` runs it so a build cannot
ship stale content.

Real binary content elsewhere in this repository is LFS-tracked, but
`fixtures/**` and `tests/fixtures/**` are carved out so tests survive a clone
without LFS.

## Consequences

- `npm create` → `npm run dev` renders something on a clean machine, with no LFS
  and no network.
- Generating rather than collecting is what makes the licence question trivial:
  there is no upstream, so `assets/CREDITS.md` has nothing to attribute. The
  CC0-only rule in `AGENTS.md` rule 14 is therefore satisfied by construction
  rather than by audit.
- Two shipped files are **not** manifest entries, and cannot be: the schema fixes
  `type` to `splat | gltf | character | audio`, and an ARKit weight track and a
  spawn table are neither. They are ordinary exports (`arenaSpawns`,
  `placeholderAssetUrl`) — the same shape the Asset Manager adapter uses when it
  returns face clips outside the manifest.
- `PLACEHOLDER_ASSETS_BASE` is `new URL('../assets/', import.meta.url)`, which
  works under Node and a dev server and **not** in a bundled build, where
  `import.meta.url` is the emitted chunk. A browser build must hand the bundler
  each file; `templates/fps/src/main.ts` shows the `?url` import pattern.
- The locomotion GLBs the plan imagined here are not in the package. They are
  retargeted per-project by `packages/animation/tools/retarget_locomotion.mjs`
  and indexed by a `locomotion.json`, which keeps the 12 MB cap comfortable.
- The 12 MB cap is a real constraint on what can be a placeholder; at 1.0 MB
  there is room, and the rule is that a candidate must be generatable.
