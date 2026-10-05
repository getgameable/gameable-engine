# ADR 0015: The guest ticks before physics, and the host owns body-driven transforms

- **Status**: Accepted — shipped in the September 2026 performance pass
- **Date**: 2026-09-16
- **Plan decision**: none; a consequence of
  [ADR 0002](./0002-one-export-per-frame.md) once it was measured

## Context

Until this record the fixed step ran input at order `-100`, physics at `0` and
the game module at `100`. Physics stepped first, the guest then read the
post-step body rows, and the `move-character` / `apply-impulse` /
`set-body-velocity` commands it emitted were applied _after_ it returned — so
they were integrated by the **next** step. Every input paid one fixed step
(16.7 ms at 60 Hz) of latency by construction, and nothing documented it.

The same arrangement also made every physics-driven entity cross the wasm
boundary twice per step: 14 floats in as a body row, then — because the guest's
`BodyIndex.ingest` marked every ingested entity dirty — 12 floats back out as a
transform row, for the host to write into the very transform store it had just
read the physics world for. For 500 bodies that is 13,000 floats per step of
pure round trip, plus the dirty scan, the pack and the interpolation flag churn
on entities that had not moved.

## Decision

1. The game module registers at order **`-50`**: after input, before physics.
   The guest ticks on the previous step's post-step rows — exactly the data it
   was acting on before, one step older only in name — and the commands it
   emits are applied before `world.step()` runs. A press integrates in the step
   it was consumed in.
2. After `world.step()` the physics module emits an allocation-free
   `physics:stepped` engine event. The host loop reads the post-step rows once
   on that event, keeps them as the next tick's `frame-input.bodies`, and writes
   position and rotation for each row's entity straight into the
   `TransformStore` through the adapter's body-to-entity table. No boundary
   crossing, no guest involvement, and the store's compare-before-write means a
   body asleep on a shelf costs ten float comparisons and dirties nothing.
3. `BodyIndex.ingest` still updates the guest's `Transform` and `Velocity`
   components — gameplay code reads them — but no longer marks them for
   packing. Guest-authored movement (`spawn`, the velocity system,
   `markMoved`, `set-body-transform` with `teleport`) still marks and still
   crosses; physics-driven movement never does.

## Consequences

- One fixed step less of input latency, and the transforms list carries only
  what the guest itself moved. Direct and wasm mode shrink identically, so the
  parity hash still agrees between them.
- A game that writes a body-driven entity's `Transform` by hand and expects it
  to render must either drive the body (`physics.teleport`, `setVelocity`) or
  call `markMoved`; the physics row wins otherwise, as it always did on the
  next step.
- The `physics:stepped` payload is reused every step, like `engine:frame`;
  listeners read it and never retain it.
- `frame-input.bodies` is documented in `docs/concepts/engine-loop.md` as "the
  rows physics produced at the end of the previous step". The WIT comment
  still says "post-step", which remains true.

## Alternatives considered

- **Keep the order, apply commands before the step by buffering them a step
  early.** Same latency, more state.
- **Run the guest twice per step** (read, step, read again). Doubles the
  boundary cost the pass was removing.
- **Make the guest skip packing physics-driven entities but keep physics
  after the guest.** Fixes the round trip, not the latency.
