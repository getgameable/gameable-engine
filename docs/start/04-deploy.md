# Ship it

A built game is **static files**. There is no server, no runtime, no build step
on the host. Put `dist/` behind any CDN and you are done.

## 1. Build

```sh
npm run build            # gameable build --release
```

Six steps, in this order:

1. `jco guest-types` writes the ambient `gameable:engine/*@0.2.0` declarations into
   `.gameable/guest-types`.
2. `tsc --noEmit -p tsconfig.json`. A type error fails here, not thirty seconds
   later inside QuickJS.
3. `jco componentize --backend qjs` turns `src/game.ts` into
   `.gameable/game.wasm`. Red `UNRESOLVED_IMPORT` warnings for the
   `gameable:engine/*` specifiers are expected noise — componentize resolves those
   itself, after the bundle — and `gameable build` filters them out.
4. `jco transpile --instantiation async --no-nodejs-compat` unpacks the
   component into `dist/guest`: nine core `.wasm` files and a `game.js` whose
   `instantiate` the host calls.
5. `wasm-opt -Oz` over each of those core modules, under `--release`. Binaryen
   cannot parse a **component**, so this happens after transpile, never before.
   It is skipped with a warning when `binaryen` is not installed.
6. `vite build` with `GAMEABLE_WASM=1`, which is what tells the page to load the
   component instead of running your TypeScript directly.

The result is `dist/`, typically a couple of megabytes of wasm plus whatever
splats and audio your manifest points at.

## 2. Check the budget

```sh
npm run build -- --report
```

```
report
  component         2.07 MiB raw
  component brotli  579.5 KiB  (budget 819.2 KiB)
  dist/guest        2.53 MiB raw
  dist/guest brotli 605.8 KiB
  instantiate cold  418.2 ms
  instantiate warm  11.6 ms
  tick p50 (1000)   0.087 ms
  tick p99          0.402 ms  (budget 1.50 ms)
```

Sizes are brotli at quality 11, which is what a CDN serves. The timings come
from instantiating the real component in node and ticking it a thousand times
against a `NullEngineAdapter` — the boundary, with no renderer attached.

Two budgets fail the build: a 99th-percentile tick over **1.5 ms** (a quarter of
a 60 Hz frame) and a component over **0.8 MB** brotli. `--no-gate` prints the
numbers without failing, for when you are measuring rather than shipping. Wire
`--report` into CI and a size or speed regression stops being something anyone
has to notice.

## 3. Host it

Upload `dist/`. Any static host works: S3 plus CloudFront, Cloudflare Pages,
Netlify, GitHub Pages, nginx, `python -m http.server` for a look.

```sh
npm run preview          # vite preview, to check the built output locally
```

### You do **not** need COOP/COEP

Cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` plus
`Cross-Origin-Embedder-Policy: require-corp`) is only needed for
`SharedArrayBuffer`. Gameable Engine v1 runs the guest and Jolt on the main thread
behind a `Sandbox` interface, and moves nothing across a worker boundary, so
nothing asks for one. Setting the headers anyway is not harmful, but it will
break embedded third-party content and it buys you nothing here.

If a later version moves the simulation to a worker with transferable buffers,
that is still transferable buffers — not shared memory — and the requirement
does not change.

### Serve `.wasm` as `application/wasm`

This is the one server setting that matters. `WebAssembly.instantiateStreaming`
refuses any other MIME type, and the failure looks like a mysterious network
error rather than a configuration mistake.

Most hosts get it right. Check with:

```sh
curl -sI https://example.com/guest/game.core.wasm | grep -i content-type
# content-type: application/wasm
```

nginx:

```nginx
types { application/wasm wasm; }
```

Apache:

```apacheconf
AddType application/wasm .wasm
```

`_headers`, for Netlify and Cloudflare Pages:

```
/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
```

### Compression and caching

Serve the `.wasm` and `.js` files brotli-compressed; that is the difference
between 2.5 MB and 600 KB, and it is the number `--report` prints. Everything
Vite emits with a content hash in its name can be `immutable`; `index.html` must
not be.

### A subdirectory

Vite needs to know:

```js
// vite.config.ts
export default { base: '/my-game/' };
```

Asset ids are unaffected — they resolve through the manifest's `baseUrl`, not
through the page URL.

## Verify

```sh
npm run build -- --report   # exits 0, both budgets green
npm run preview             # walk, shoot, win, in the built output
curl -sI <your-host>/guest/game.core.wasm | grep -i content-type
```

Then open the deployed URL in Chrome with the console open. No 404s, no
`application/octet-stream`, and the game plays exactly as it did in `npm run dev`
— the two modes share the same guest runtime, and a parity test proves it.

## Next

- [Build the wasm guest](../recipes/build-the-wasm-guest.md) — the pipeline by hand
- [Debug with doctor](../recipes/debug-with-doctor.md)
- [The wasm boundary](../concepts/wasm-boundary.md)
- [Troubleshooting](../troubleshooting.md)
