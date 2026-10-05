# ADR 0003: Dev mode runs the same TypeScript directly; wasm is the shipping path

- **Status**: Accepted — shipped in M1
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 2

## Context

The componentize + transpile pipeline takes seconds and hides source maps, which
is fatal for iteration speed and for debugging. But shipping a different code
path than the one you develop against is how parity bugs are born.

## Decision

`createSandbox({ mode: 'direct' })` dynamic-imports the game's TypeScript entry
and runs it through **the same** `createGuest(hostImports)` runtime and the same
host bindings the wasm guest uses. `mode: 'wasm'` loads the transpiled
component. Parity is enforced by a test that hashes transform buffers from both
modes over a scripted tape, not by discipline.

## Consequences

- Sub-second HMR while writing a game; real breakpoints in game code. The
  alternative is a `jco componentize` run, which is about thirty seconds.
- The guest runtime must stay free of node- and browser-only assumptions.
- The parity test is load-bearing, and it is real:
  `tests/boundary/parity.test.ts` drives 300 scripted frames through both modes
  and compares `hashFrameOutput` frame by frame.
- Bit-identical, not merely similar: every float is an `f32`, so the SDK rounds
  with `Math.fround` on the way out and `quantizeInput` rounds on the way in.
  Without that the two modes agree until the fourth decimal place and then a
  determinism hash disagrees for no visible reason.
- `gameable/sdk/prelude` has to behave differently in the two realms. It
  installs `console`, `TextEncoder`/`TextDecoder` and a `performance.now`
  fallback in QuickJS, but deliberately leaves `Math.random` alone under V8,
  because patching a global there would reach vitest and the host application
  too. `ctx.rng` is the way out of that for game code.
