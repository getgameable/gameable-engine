# ADR 0002: One guest export per frame: tick(frame-input) -> frame-output

- **Status**: Accepted — shipped in M1
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 1

## Context

Game logic runs inside a QuickJS WebAssembly component. Every crossing of the
component boundary costs canonical-ABI lifting/lowering plus QuickJS value
marshalling. A chatty API (one call per entity, per query, per spawn) would put
that cost on the hot path and would make deterministic replay hard.

## Decision

The guest exports exactly one per-frame function:
`tick(frame-input) -> frame-output`. Continuous data crosses as packed
`list<f32>` (transforms stride 12, bodies stride 14); structural changes cross as
a `list<command>` variant. The guest mints all entity handles. The only
synchronous host imports are physics queries. v1 uses records, variants, lists
and primitives only — no resources, no async — so a Rust `wit-bindgen` guest
implementing the same world is trivial.

What shipped is five exports — `init`, `tick`, `shutdown`, `snapshot`,
`restore` — of which exactly one runs per frame, and three imported interfaces:
`env` (`log`, `seed`, `now-ms`), `physics-query` (`raycast`, `raycast-batch`,
`overlap-sphere`) and `assets` (init-time only).

## Consequences

- Boundary cost is O(1) calls per frame instead of O(entities). Measured on the
  reference machine: **0.19 ms p50** per steady-state tick in QuickJS, 0.30 ms
  p99, 0.07 ms for the Rust guest; ~500 ms to instantiate cold; ~2.1 MiB of
  component.
- A frame is a value, so record/replay, determinism hashing and snapshot/restore
  all fall out for free.
- Commands are batched, so the guest cannot read back the result of a spawn in
  the same frame. Handles are guest-minted to make that a non-issue.
- Adding a capability means adding a command variant, which is a WIT change.
- Packing into `list<f32>` bought two sharp edges that the SDK now absorbs: a
  zero-length `list<f32>` is rejected by jco's lifter (QuickJS returns pointer 1
  for a zero-length allocation), so `TransformPacker` emits one all-zero row and
  the host skips rows whose flags are zero; and an incoming list is a plain
  `Array` in QuickJS however the generated `.d.ts` types it, so the SDK types
  every incoming list as `ArrayLike<number>` and copies into preallocated typed
  arrays.
- Keeping the world resource-free and async-free was what made a second guest
  language cheap rather than a project: `examples/wasm-guest-rust` implements the
  same five exports in ~107 KiB and the host cannot tell which language it is
  talking to.
