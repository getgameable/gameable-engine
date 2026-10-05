# The wasm game-logic boundary

All game logic is TypeScript compiled to a QuickJS WebAssembly component. The
host owns rendering, physics, input, audio, assets and characters; the guest
owns entities, components and systems. They meet at one WIT world,
`gameable:engine@0.2.0 / game-module`, and at **one export per frame**.

## The contract

The guest exports five functions:

| Export                   | Meaning                                           |
| ------------------------ | ------------------------------------------------- |
| `init(game-config)`      | Once, before the first tick. Seed the RNG here.   |
| `tick(frame-input)`      | One fixed step. Returns `frame-output`.           |
| `shutdown()`             | Release guest resources. No further calls follow. |
| `snapshot() -> list<u8>` | The whole guest state, opaque to the host.        |
| `restore(list<u8>)`      | Read one back, from the same build.               |

and imports three interfaces: `env` (`log`, `seed`, `now-ms`),
`physics-query` (`raycast`, `raycast-batch`, `overlap-sphere` — the only
synchronous host calls) and `assets` (`resolve-id`, `describe`, init-time
only).

Continuous data crosses as packed `list<f32>`:

- **`frame-input.bodies`**, stride 15: `body-id`, position (3), rotation (4),
  linear velocity (3), angular velocity (3), character ground state (1). Sorted ascending by body id.
- **`frame-output.transforms`**, stride 12: `entity`, `transform-flags`,
  position (3), rotation (4), scale (3). Only rows whose flags are non-zero.

`transforms` carries **guest-authored** moves only. A physics-driven entity is
not one: the host reads the body rows when it steps and writes them onto the
entity itself, so the same numbers never make the round trip out again. The
guest still receives them as `bodies` and still keeps `Transform` and
`Velocity` up to date for gameplay — it reads them, it does not own them. A
system that writes a transform lane by hand says so with `markMoved(entity)`,
and that row does cross. See [Physics](./physics.md).

Structural changes cross as a `list<command>` variant — spawn, add-body,
play-sound, set-expression and twenty more — applied by the host front to back
after the guest returns. Physics queries are the one exception; everything else
is deferred, and there is deliberately no per-entity call.

## JavaScript shapes

jco lifts and lowers the canonical ABI into plain JavaScript. The shapes differ
between the two sides, and getting them wrong is the most common way to break
the boundary.

| WIT                         | In the guest (QuickJS)                 | On the host (V8)                 |
| --------------------------- | -------------------------------------- | -------------------------------- |
| `u64`                       | `number`                               | `bigint`                         |
| `u32`, `f32`, `f64`         | `number`                               | `number`                         |
| `list<f32>`, `list<u32>` in | plain `Array`                          | any `ArrayLike`, typically typed |
| `list<f32>` out             | `Array` or `Float32Array` (20% faster) | `Float32Array`                   |
| `list<u8>`                  | `Uint8Array`                           | `Uint8Array`                     |
| `option<T>` = none          | `null` incoming                        | `undefined` / absent             |
| `variant`                   | `{ tag: 'kebab-case', val }`           | same                             |
| `enum`                      | kebab-case string                      | same                             |
| `flags`                     | every key present incoming             | every key present                |
| `record`                    | object with camelCase fields           | same                             |
| exported `result<_, E>`     | **throw** the `E` record               | `ComponentError` with `.payload` |
| exported `interface`        | `export const game = { … }`            | `root.game`                      |

Four rules fall out of that table, and the SDK enforces all four:

1. **Never `instanceof` or `.subarray()` an incoming list.** The generated
   guest `.d.ts` claims `Float32Array`; at runtime it is a plain `Array`. The
   SDK types every incoming list as `ArrayLike<number>`, which makes the
   mistake a compile error, and copies into preallocated typed arrays.
2. **Never emit a zero-length `list<f32>`.** QuickJS returns a pointer of 1 for
   a zero-length allocation and jco's lifter rejects it with
   `list pointer [1] is not aligned to 4`. `TransformPacker` emits a single
   all-zero row instead; the host skips rows whose flags are zero.
3. **`u64` is a `bigint` on the host.** `frame` must be `BigInt()`ed on the way
   in and `Number()`ed in the guest. `createInputEncoder` and the SDK runtime
   do both.
4. **Every float is an `f32`.** The SDK rounds with `Math.fround` on the way
   out and `quantizeInput` rounds on the way in, so direct mode and wasm mode
   are bit-identical rather than merely similar.

## Two modes, one program

`createSandbox` runs the guest either way:

- **`mode: 'wasm'`** loads a `jco transpile`d component and calls
  `instantiate(getCoreModule, imports, WebAssembly.instantiate)`. This is the
  shipping path.
- **`mode: 'direct'`** dynamic-imports the game's TypeScript and runs it
  through the same `createGuest` runtime in the host's realm. No build step, so
  this is what `npm run dev` uses.

They share the guest runtime on purpose. `tests/boundary/parity.test.ts` drives
300 scripted frames through both and compares `hashFrameOutput` frame by frame;
a divergence is a bug in the engine, not a configuration difference.

A guest trap **permanently poisons** a component instance — every later call
fails with `cannot enter component instance` — so the sandbox latches a `dead`
flag on the first failure, returns an inert frame, and leaves it to the host to
build a new sandbox.

## Building the guest

Three steps, all absolute forward-slashed paths.
`fixtures/tiny-game/scripts/build.mjs` is the reference implementation.

```sh
# 1. ambient types for the gameable:engine imports (committed, not per build)
jco guest-types <abs>/wit --world-name game-module -o <abs>/src/wit/generated

# 2. TypeScript in, component out. Bundled by rolldown automatically.
jco componentize --backend qjs --backend-qjs-disable-async \
  -n game-module --wit <abs>/wit \
  --bundle-config <abs>/build/rolldown.config.mjs \
  -o <abs>/build/game.wasm <abs>/build/entry.ts

# 3. component in, nine core wasm files plus game.js out. No --map.
jco transpile <abs>/build/game.wasm --instantiation async --no-nodejs-compat \
  --name game -o <abs>/build/guest
```

Red `UNRESOLVED_IMPORT` warnings for the `gameable:engine/*` specifiers in step 2
are expected noise: componentize resolves them itself, after the bundle.

`jco componentize` compiles exactly one module, and that module has to import
the versioned `gameable:engine/*@0.2.0` specifiers — which only resolve inside
componentize. So the build **generates** a four-line entry per game:

```ts
// build/entry.ts — generated
import { createGuestExports } from '../../../packages/sdk/src/wit/entry';
import definition from '../src/game';

export const game = createGuestExports(definition);
```

The game module itself never mentions WIT. `createGuestExports` imports the
prelude first, adapts the three import interfaces to the SDK's `HostApi`, and
wires them to `createGuest`.

## What QuickJS does not have

componentize-qjs is QuickJS-NG plus a Wizer heap snapshot. There is no
`console`, no `TextEncoder` / `TextDecoder`, no `structuredClone`, no timers
and no `crypto`. There _is_ `performance.now`, `Date.now`, `Proxy`, `Promise`
and the typed arrays.

Worse, **module scope runs during the build-time snapshot**. A `Date.now()` or
`Math.random()` at module top level is frozen into the binary, and QuickJS
seeds `Math.random` identically on every instantiation. So:

> Seed randomness inside `init()`, from `env.seed()`. Never at module scope.

`gameable/sdk/prelude` installs `console` (routed at `env.log`), UTF-8
`TextEncoder` / `TextDecoder` polyfills and a `performance.now` fallback, and
replaces `Math.random` with a guard that throws a helpful message until the
runtime seeds it. In V8 it deliberately leaves `Math.random` alone, because
patching the global would reach vitest and the host application too — which is
one more reason to use `ctx.rng`.

The component imports 18 `wasi:*` interfaces but only ever calls two functions:
`wasi:clocks/monotonic-clock#now` and `wasi:clocks/wall-clock#now`.
`minimalWasi()` stubs the rest in about 100 lines; the stderr `OutputStream` is
the one stub that needs a real write path, because that is where QuickJS writes
trap messages.

## Measured cost

From `tests/boundary/smoke.test.ts` on the reference machine (node 24, Windows):

| Measurement                          | Value    |
| ------------------------------------ | -------- |
| Instantiate (cold, includes compile) | ~500 ms  |
| Steady-state tick, p50               | 0.18 ms  |
| Steady-state tick, p90               | 0.22 ms  |
| Steady-state tick, p99               | 0.30 ms  |
| Component size                       | ~2.1 MiB |

A steady-state tick allocates nothing: the transform buffer is preallocated and
its subarrays memoised, command objects are pooled per tag, and the frame-output
record is reused.

## Other guest languages

Nothing above is JavaScript-specific. The world is resource-free and
async-free on purpose — records, variants, enums, flags, lists, primitives —
which is the subset every `wit-bindgen` backend supports, so a Rust, C or Go
guest implements the same five exports and the host cannot tell them apart.

`examples/wasm-guest-rust` is the proof, and the Rust path is two steps rather
than three: `cargo build --release --target wasm32-wasip2` emits a component by
itself — rustc links through `wasm-component-ld`, so there is no `componentize`
pass, no generated entry module and no `cargo-component` — and then the same
`jco transpile --instantiation async --no-nodejs-compat`. Bindings come from
`wit_bindgen::generate!({ path: "../../wit", world: "game-module" })`, pointed
at the engine's own WIT, never a vendored copy.

The differences that matter:

|                  | QuickJS guest                 | Rust guest                        |
| ---------------- | ----------------------------- | --------------------------------- |
| Component        | ~2.1 MiB                      | ~107 KiB (39 KiB brotli)          |
| Steady tick p50  | 0.19 ms                       | 0.07 ms                           |
| `wasi:*` imports | 18                            | 5, all covered by `minimalWasi()` |
| Guest state      | module scope, frozen by Wizer | `thread_local!`, seeded in `init` |

Rust cannot fully honour "no allocation in a system": `frame-output.transforms`
is a `Vec<f32>` the canonical ABI takes by value, so one allocation per frame
is structural. Everything else is pre-sized.

## See also

- [ECS and game code](./ecs.md)
- [Write a guest in Rust](../recipes/write-a-guest-in-rust.md)
- [Build the wasm guest](../recipes/build-the-wasm-guest.md)
- [Write a game system](../recipes/write-a-game-system.md)
- `packages/wasm-host/README.md` — gameable/host
- `packages/sdk/README.md` — gameable
