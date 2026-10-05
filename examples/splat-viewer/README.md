# splat-viewer

The reference app for `gameable/splat`: static splats, dynamic splats, the WebGL fallback
and the S1/S2 benchmarks, all from one page.

```sh
npm run dev -w examples/splat-viewer     # http://localhost:5178
npm run build -w examples/splat-viewer
npm run preview -w examples/splat-viewer # http://localhost:4178
```

`predev` and `prebuild` generate `public/models/synthetic_150k.spz` (1.9 MB, deterministic) if
it is missing, so a bare clone runs with no binary in the repository and no Git LFS.

## Modes

| Query                    | What it does                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| _(none)_                 | A 150 k-gaussian synthetic SPZ, loaded through the engine's asset registry       |
| `?model=<url>`           | Any `.spz`, `.ply`, `.splat` or `.ksplat` instead                                |
| `?mode=dynamic&n=250000` | The fork plus a WGSL producer rewriting every gaussian every frame               |
| `?backend=webgl`         | Forces the WebGL fallback. Static only — dynamic refuses, loudly                 |
| `?bench=1`               | Runs the benchmark into `window.__AOS_BENCH__` and `<pre id="bench">`            |
| `?orbit=0`               | Stops the automatic 2°/frame orbit and lets you drag                             |
| `?deg=<n>`               | Degrees the camera turns per **frame**. Above ~1.81 forces a re-sort every frame |
| `?frames=<n>`            | Benchmark frames to measure, after 30 warm-up frames                             |

Everything except `?bench=1` boots through `createEngine` with the `splat()` module, which is
the path a game takes. The benchmark builds its own renderer because it needs
`trackTimestamp: true`.

## Tests

```sh
npx playwright install chromium                        # once
npx playwright test -c tests/e2e/playwright.config.ts  # from the repository root
```
