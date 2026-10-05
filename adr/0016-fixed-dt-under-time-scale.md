# ADR 0016: A fixed step is always `1 / fixedHz`; time scale changes how many steps a frame buys

- **Status**: Accepted — shipped in the September 2026 performance pass
- **Date**: 2026-09-16
- **Plan decision**: none; a correction to how `time.timeScale` was implemented

## Context

`docs/concepts/engine-loop.md`, `EngineModule.fixedUpdate`'s TSDoc and the WIT
comment on `frame-input.dt` all said the same thing: `dt` is the fixed
timestep, `1 / fixed-hz`. The implementation said otherwise. `createEngine`
multiplied `dt` by `time.timeScale` before handing it to every `fixedUpdate`
hook, so `set-time-scale(0.5)` gave Jolt a 8.3 ms step it is not tuned for,
gave the guest a `dt` that no longer matched `frame * fixedDt`, and made a
recorded input tape replay differently at any speed other than 1. At
`timeScale: 0` the guest was still ticked sixty times a second with `dt = 0`.

## Decision

`FixedLoop` gains a mutable `timeScale`. The accumulator advances by
`dtReal * timeScale`; a fixed step is always `fixedDt` long and `fixedUpdate`
always receives it. Half speed means a frame buys half as many steps; zero
pauses the simulation while `update` and `render` keep running; a negative
value is treated as zero. `createEngine` copies `time.timeScale` onto the loop
once per frame, and `time.elapsed` advances by `fixedDt` per step, whatever the
scale. `update` hooks still receive `dtReal * timeScale`, because presentation
code wants scaled wall time.

## Consequences

- Physics, the guest and every module see one constant `dt`. A replay at any
  time scale runs the same steps in the same order.
- Slow motion is quantised to whole steps: at `timeScale 0.25` a 60 Hz display
  runs a step every fourth frame and interpolates between. That is what the
  interpolation exists for, and it is what every fixed-step engine does.
- A module that wanted the old behaviour — a variable step scaled by
  `timeScale` — has to scale inside its own hook. Nothing in the repository
  did.
