# ADR 0013: One key table, and it lives in gameable/sdk/keycodes

- **Status**: Accepted — shipped in M2
- **Date**: 2026-09-13
- **Plan decision**: none; a consequence of
  [ADR 0002](./0002-one-export-per-frame.md)

## Context

`input-state.keys` in `wit/types.wit` is 256 bits packed into eight `u32` words:
key `c` is bit `c & 31` of word `c >> 5`. The host writes those bits from
`KeyboardEvent.code`; the guest reads them by name. Both sides therefore need the
same `code → index` table, and "the same" has to mean _the same_, not
_equivalent_ — a recorded input tape, a replay, a snapshot and a compiled wasm
guest all encode those numbers, so one index that differs by one silently
reinterprets every recording ever made.

The obvious arrangement is a table on each side plus a test asserting they match.
That was the arrangement for a while, and it is wrong in a specific way: the test
proves today's tables agree, and says nothing about the next append. Two
append-only lists maintained in parallel are one forgotten commit away from
disagreeing, and the failure surfaces as a game where `KeyJ` fires the weapon.

The complication is direction. `gameable/input` is a **host** package and
`gameable` is the **guest** API — the one import a game needs. Making the
host depend on the game-facing SDK to learn what `Space` means looks backwards.

## Decision

The keyboard table lives in exactly one file, `packages/sdk/src/keycodes.ts`,
exposed as the subpath `gameable/sdk/keycodes`. `gameable/input` imports
`KEY_NAMES` from it and builds its own host index from that array.

The subpath is what makes the dependency direction acceptable: it is a
dependency-free table module — names and numbers, no prelude, no runtime, no
bitecs — so importing it pulls in none of the game-facing SDK. The host depends
on _the contract_, which happens to be published from the SDK package because
that is the package a guest can import.

The split of the 256 indexes:

| Range      | Owner            | Contents                                              |
| ---------- | ---------------- | ----------------------------------------------------- |
| `0..127`   | the shared table | keyboard codes, imported from `gameable/sdk/keycodes` |
| `128..247` | the shared table | free, for appends                                     |
| `248..255` | `gameable/input` | the reserved pointer block, `Mouse0`..`Mouse4`        |

Mouse buttons are mirrored into the pointer block host-side, which the guest
table leaves empty, so `'LMB'` reads exactly like `'Space'` in a game's action
map.

## Consequences

- Host and guest cannot drift, because there is nothing to drift _from_. The test
  in `packages/input/src/keycodes.test.ts` now pins the append-only property
  rather than an agreement between two lists.
- The table is frozen forever and append-only. Never reorder a group, never
  remove a code, never renumber; new codes go on the end, below 248.
- `gameable/input` gains a dependency on `gameable`. That is the cost,
  and it is bounded to one subpath; if it ever stops being bounded, the table
  moves to a package of its own and both sides import that.
- `gameable/input` still does **not** depend on `gameable/core`: it declares
  `EngineModule` / `EngineContext` / `EngineServices` structurally in
  `src/moduleTypes.ts`, so an input capture is usable in a test harness, a
  recorder or a standalone viewer with no engine at all. The two decisions look
  similar and are not: a key index is a wire format, and a module shape is a
  structural type.
- Game code should not reach for either table. `input.axis2('move')` and
  `input.pressed('fire')` resolve named actions, and a key code appearing in a
  game is a smell the recipes call out.
