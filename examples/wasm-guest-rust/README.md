# wasm-guest-rust

The same game world as the TypeScript fixture, written in Rust and compiled
straight to a WebAssembly component. No jco `componentize`, no QuickJS, no
generated entry module — and the host cannot tell the difference.

```sh
rustup target add wasm32-wasip2            # once
node examples/wasm-guest-rust/build.mjs    # cargo + jco transpile -> dist/guest
GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts tests/boundary/rust-guest.test.ts
```

## What it proves

`gameable:engine@0.2.0 / game-module` is deliberately resource-free and async-free,
which is exactly the subset every `wit-bindgen` backend supports. `src/lib.rs`
implements all five exports — `init`, `tick`, `shutdown`, `snapshot`,
`restore` — and calls all three imports: `env.seed`, `env.log`,
`assets.resolve-id` and `physics-query.raycast`.

In one tick it spawns a player capsule and three boxes (frame 0 only), ingests
the stride-14 `bodies` list, walks the player from the WASD key bitset, orbits
the boxes, hitscans while the left mouse button is down, and emits a stride-12
transform buffer, a third-person `camera-state` and a HUD every 30 frames.
`tests/boundary/rust-guest.test.ts` asserts every one of those, through the
same `createSandbox({ mode: 'wasm' })` the TypeScript guest uses.

## Numbers, against the QuickJS guest

| Measurement           | QuickJS guest | This guest |
| --------------------- | ------------- | ---------- |
| Component             | ~2.1 MiB      | ~107 KiB   |
| Component, brotli     | —             | ~39 KiB    |
| Instantiate, cold     | ~500 ms       | ~230 ms    |
| Steady-state tick p50 | 0.19 ms       | 0.07 ms    |
| Steady-state tick p99 | 0.30 ms       | 0.15 ms    |

The remaining tick cost is almost all jco's JavaScript-side lowering of
`frame-input` and lifting of `frame-output` — work both guests pay identically.
What Rust removes is the interpreter underneath it.

## Three details worth stealing

**Do not copy the WIT.** `wit_bindgen::generate!({ path: "../../wit", world:
"game-module" })` reads the repository's own package at compile time. A
vendored copy is a second source of truth and will drift from the host.

**`cargo build --target wasm32-wasip2` already emits a component.** rustc links
through `wasm-component-ld`, so there is no `cargo-component` and no
`wasm-tools component new` step. `build.mjs` still checks the output's
preamble — `00 61 73 6d 0d 00 01 00`, layer 1 — because a core module and a
component are both `.wasm` and only one of them will transpile.

**State is global, because the exports are free functions.** `Guest` has no
`self`. A `thread_local! { static STATE: RefCell<State> }` keeps that safe
without a line of `unsafe`, and wasm is single-threaded so the borrow never
contends.

## Gotchas

- The output `Vec<f32>` is one allocation per frame that Rust cannot avoid: the
  canonical ABI takes the list by value. Everything else here is pre-sized.
- A `result<_, game-error>` error is not a trap, but `createSandbox` still
  latches `dead` when a lifecycle call throws. Return errors from `restore`;
  never panic.
- `panic = "abort"` in the release profile keeps the component small. A panic
  then aborts the instance, which the sandbox reports as a dead sandbox.
- `dist/` and `target/` are gitignored. Both are reproducible from `cargo` and
  `jco`.

## See also

- [Write a guest in Rust](../../docs/recipes/write-a-guest-in-rust.md)
- [The wasm boundary](../../docs/concepts/wasm-boundary.md)
- [Build the wasm guest](../../docs/recipes/build-the-wasm-guest.md)
- `packages/wasm-host/README.md` — gameable/host
