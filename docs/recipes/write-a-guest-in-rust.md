# Write a guest in Rust

## Goal

Your game logic is a Rust crate compiled straight to a WebAssembly component,
loaded by the same `createSandbox({ mode: 'wasm' })` that loads a TypeScript
guest. The host never learns which language you used.

## Files you will edit

- `Cargo.toml`
- `src/lib.rs`

## Steps

1. Install the target once. `rustc` emits a component for `wasm32-wasip2` by
   itself, so there is no `cargo-component` and no `wasm-tools component new`
   step.

   ```sh
   rustup target add wasm32-wasip2
   ```

2. Declare a `cdylib` with one dependency, and a release profile that cares
   about size. An empty `[workspace]` stops cargo walking up into a parent
   manifest.

   ```toml
   # Cargo.toml
   [package]
   name = "my-guest"
   version = "0.1.0"
   edition = "2021"

   [workspace]

   [lib]
   crate-type = ["cdylib"]

   [dependencies]
   wit-bindgen = "0.62.0"

   [profile.release]
   opt-level = "s"
   lto = true
   codegen-units = 1
   strip = true
   panic = "abort"
   ```

3. Generate the bindings from the engine's WIT — **do not copy it into your
   crate**, or it will drift from the host — and implement the five exports.

   ```rust
   // src/lib.rs
   wit_bindgen::generate!({ path: "../../wit", world: "game-module" });

   use crate::gameable::engine::env;
   use crate::exports::gameable::engine::game::{FrameInput, FrameOutput, GameConfig, GameError, Guest};

   struct Component;

   impl Guest for Component {
       fn init(config: GameConfig) -> Result<(), GameError> {
           // Seed here, never at module scope, exactly as in the TS guest.
           STATE.with(|s| s.borrow_mut().rng = (config.seed ^ env::seed()) | 1);
           Ok(())
       }

       fn tick(input: FrameInput) -> FrameOutput { /* … */ }
       fn shutdown() {}
       fn snapshot() -> Vec<u8> { /* … */ }
       fn restore(bytes: Vec<u8>) -> Result<(), GameError> { /* … */ }
   }

   export!(Component);
   ```

   The `Guest` methods are free functions — there is no `self` — so state is
   global. `thread_local! { static STATE: RefCell<State> }` keeps that safe
   with no `unsafe`, and wasm is single-threaded so the borrow never contends.

4. Build and transpile. Two steps, not three: cargo produces the component,
   `jco transpile` produces the loader, with the same flags the TypeScript
   guest uses.

   ```sh
   cargo build --release --target wasm32-wasip2
   npx jco transpile target/wasm32-wasip2/release/my_guest.wasm \
     --instantiation async --no-nodejs-compat --name game -o dist/guest
   ```

   `examples/wasm-guest-rust/build.mjs` wraps both steps, verifies the output
   really is a component (preamble `00 61 73 6d 0d 00 01 00`, layer 1, not a
   core module's `00 61 73 6d 01 00 00 00`) and prints raw and brotli sizes.

## Verify

```sh
node examples/wasm-guest-rust/build.mjs
GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts tests/boundary/rust-guest.test.ts
```

The build prints a component around 107 KiB (39 KiB brotli) against the QuickJS
guest's ~2.1 MiB, and all eleven boundary assertions pass: the frame-0 `spawn`
and `add-body` commands, a stride-12 transform buffer, the `raycast` import
round trip, the HUD, and a snapshot/restore that hashes identically.

## See also

- [The wasm boundary](../concepts/wasm-boundary.md)
- [Build the wasm guest](./build-the-wasm-guest.md)
- `examples/wasm-guest-rust/README.md` — the worked example
- `packages/wasm-host/README.md` — gameable/host
