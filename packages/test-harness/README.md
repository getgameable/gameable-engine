# gameable/test

## What

Test doubles for the wasm boundary: a mock host implementing every `gameable:engine`
import, host-shaped `frame-input` builders with key and mouse helpers, a frame
driver, and the hashes the determinism and parity tests compare.

## When to use

You are writing vitest tests for a game module, or for an engine package that
talks to a sandbox. Everything here is node-only and has no engine dependency.

## Install

```sh
npm install --save-dev gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { expect, it } from 'vitest';
import { createGuest } from 'gameable';
import { createFrameInput, createGameConfig, createMockHost, press, simulate } from 'gameable/test';

import game from '../src/game.ts';

it('spawns the player and three enemies on frame 0', () => {
  const host = createMockHost({ seed: 42, assets: ['arena', 'enemy-capsule'] });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 42n }));

  const out = guest.tick(createFrameInput({ frame: 0 }));
  expect(out.commands.filter((c) => c.tag === 'spawn')).toHaveLength(4);
});

it('is deterministic', () => {
  const script = (frame, input) => {
    if (frame === 10) press(input, 'W');
  };
  const a = simulate(makeGuest(), { frames: 600, script });
  const b = simulate(makeGuest(), { frames: 600, script });
  expect(b.hashes).toEqual(a.hashes);
});
```

## API

- **`createMockHost({ seed, nowMs, raycast, overlapSphere, assets, strictAssets })`** —
  a `HostApi` that records every `env.log` line (`log_`, `warnings()`) and
  every query (`rayCalls`). `assets` is the manifest: a name that is not in it
  resolves to nothing, because `strictAssets` defaults to **true** — a typo'd
  asset id should fail a test, not mint a handle. Pass `strictAssets: false`
  for a test that does not care which assets exist; `handleOf(name)` registers
  one on demand either way.
- **`createFrameInput(overrides)` / `createGameConfig(overrides)` /
  `createInputState()`** — host-side shapes: `frame` and `seed` are `bigint`s,
  key bitsets are `Uint32Array`s, absent options are `undefined`.
- **`press(state, key)` / `release(state, key)` / `endFrame(state)` /
  `pressMouse` / `releaseMouse`** — write the bitsets the way
  `gameable/input` does. Key names come from `gameable/sdk/keycodes`, so
  `'W'`, `'KeyW'` and `'Shift'` all work.
- **`packBodies(rows)`** — build a stride-15 `bodies` list, sorted by body id.
- **`simulate(guest, { frames, dt, script, keepOutputs })`** — drive a guest or
  a `Sandbox` and collect per-frame hashes, command tags, HUD payloads and
  transform row counts.
- **`hashFrameOutput(out)`, `hashTransforms`, `hashCommands`, `stableJson`** —
  FNV-1a over the raw f32 bit patterns and a key-sorted JSON rendering of the
  commands.

## Gotchas

- **Determinism tests must run the tape twice**, and ideally again across a
  `snapshot` / `restore` cycle. One run proves nothing.
- **`simulate` reuses one input state and clears its edges between frames**, so
  a `press` in the script stays held until you `release` it — exactly like the
  real input module.
- **The mock host is not a physics engine.** Queries return whatever the
  options say; `bodies` is whatever you pack.
- **Frame outputs are reused objects.** `keepOutputs` collects references to
  the same record, so hash as you go rather than comparing outputs afterwards.
