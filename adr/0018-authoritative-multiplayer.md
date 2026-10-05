# ADR 0018: Multiplayer on an authoritative dedicated room server; the frame-output is the replication stream

- **Status**: Proposed — lands with phase 3
- **Date**: 2026-10-02
- **Plan decision**: the multiplayer spec, sections 1, 3 and 4
  (`specs/2026-10-02-multiplayer-and-feature-modules.md`), plan Task 0.1

## Context

The multiplayer work asks for the kinds of multiplayer games that top Roblox's chart, on a
server we host. The field has settled the topology: in July 2026 Roblox shipped
Server Authority, making the server the source of truth for game logic and
simulation, after a decade of client-owned physics that produced the speed-hack
class of exploits (spec section 3 lists the sources and what each changed).
Unreal's dedicated server has always had this shape. The engine already has the
pieces a server needs: one guest export per frame (ADR 0002), a guest that runs
the same in direct and wasm mode (ADR 0003), and Jolt physics owned by the host.

## Decision

Each match is a room on an authoritative dedicated room server. The room runs the
game's own guest and Jolt headless, through `createHeadlessEngine` from
`gameable/core/headless` and the room host pieces in
`gameable/host/server`; neither loads three.

The guest's frame-output is the replication stream: its commands go to clients
reliably, and its transform rows go unreliably at the game's `sendHz`. Clients
send input and never own physics.

The guest contract moves to WIT `gameable:engine@0.2.0`, which adds per-player input
(`players`), net events (`player-joined`, `player-left`, `message`) and a `send`
command. One-player games keep ticking unchanged.

## Consequences

- One codebase per game: systems are tagged by side (`authority`, `client`,
  `both`), and the server runs the same component the browser runs.
- Client-side prediction is a later phase; it will use the acked input sequence
  that is already on the wire.
- Capacity is memory-bound before it is CPU-bound, on the one measurement so far:
  one laptop run built and ran 10 rooms in one process, and 12 aborted with
  `Aborted(OOM)` while building a Jolt world (observed). That the cap is Jolt's
  per-world allocation in a shared wasm heap is inferred, not observed. See
  `specs/measurements/2026-10-02-headless-rooms-per-core.md`; phase 3 plans for
  about 10 rooms per process until that is settled.
