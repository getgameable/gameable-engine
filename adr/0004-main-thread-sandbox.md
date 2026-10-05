# ADR 0004: v1 runs the guest and Jolt on the main thread behind a Sandbox interface

- **Status**: Accepted — shipped in M1 (guest) and M2 (Jolt)
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 3

## Context

Moving simulation to a worker buys frame-time headroom but costs transferable
buffer plumbing, a second asset path, and a much harder debugging story — before
there is any evidence that the main thread is the bottleneck.

## Decision

Run the guest and Jolt on the main thread for v1, behind a `Sandbox` interface
whose only contract is `tick(frame-input) -> frame-output`. Because the
interface is already a value-in, value-out boundary, moving it to a worker later
is an implementation change, not an API change.

## Consequences

- v1 ships sooner and is far easier to debug and to profile.
- The evidence says the bet was right: a steady-state QuickJS tick is **0.19 ms
  p50** (0.30 ms p99), and a Rust guest is 0.07 ms. Neither is close to owning a
  16.6 ms frame; the splat sort and the character lift are the costs that matter.
- A heavy guest tick shows up as a dropped frame; the fixed-step accumulator
  caps the damage at five substeps and reports `FrameTiming.clamped`.
- A guest trap permanently poisons a component instance — every later call fails
  with `cannot enter component instance` — so the sandbox latches a `dead` flag
  on the first failure, returns an inert frame, and leaves rebuilding to the
  host. That behaviour is the same in both modes and is part of the interface,
  not of the main-thread choice.
- The worker move is a later optimisation with a known shape, not a rewrite.
