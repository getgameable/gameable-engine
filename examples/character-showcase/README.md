# character-showcase

The rig → GPU → splat path, end to end, on real WebGPU: a baked **GNM** head posed by
`gnm_blend.wgsl` on the renderer's own device, written into an `AnimatedSplat` by
`DebugVertexLift`, one 2 mm gaussian per rig vertex.

```sh
npm run dev -w examples/character-showcase     # http://localhost:5179
npm run build -w examples/character-showcase
npm run preview -w examples/character-showcase # http://localhost:4180
```

**There are no decoders in this example, and that is the point.** A character's geometry and
appearance decoders are trained per character and per topology, and none exist for GNM topology
yet — they are being retrained by another team. What renders here is the rig stage and nothing
else, so a rig bug has nowhere to hide behind a plausible-looking face.

## The pack is generated, not committed

`predev` and `prebuild` run `scripts/gen-gnm-pack.mjs`, which bakes
`F:/work/aos/aosRig/assets/myra/myra.head.npz` into `public/generated/` with the character
package's own python tools (numpy only — neither `gnm` nor `aosrig` is needed):

| File                    | What                                                              |     Size |
| ----------------------- | ----------------------------------------------------------------- | -------: |
| `myra_head.aosrig`      | the full pack: 383 coefficients, fp16 basis, 17,821 vertices      | 42.66 MB |
| `myra_head.e64.aosrig`  | **the default**: 64 coefficients (the model's reduced view), lean |  7.85 MB |
| `reference_frames.npz`  | 10 random `head_ext` frames + the python model's vertices         |  0.05 MB |
| `reference_frames.json` | the same, for the browser self-check                              |  0.19 MB |
| `status.json`           | what was baked, what it measured, or what was missing             |        — |

Truncating 383 coefficients to 64 costs **0.26 mm mean / 6.7 mm max** vertex error over those
ten (deliberately extreme, ±2σ) reference frames, which the packer measures with
`--trunc-report` rather than asserting.

The source npz is licensed data that lives outside this repository, so the generator **never
fails the build**: a missing npz, python or numpy writes the reason into `status.json`, exits
0, and the app shows it on screen. Point it elsewhere with `GAMEABLE_MYRA_HEAD` / `GAMEABLE_MYRA_RIG` /
`GAMEABLE_PYTHON`, or run `npm run gen:pack:force -w examples/character-showcase` to re-bake.

## Modes

| Query         | What it does                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| _(none)_      | The 64-coefficient pack, expression sliders, fixed front view                  |
| `?pack=full`  | The full 383-coefficient pack (42 MB — a slow reload, an identical frame time) |
| `?rig=orl`    | The ORL backend from `public/bundles/<name>/`; see below                       |
| `?anim=1`     | The placeholder ARKit idle clip through `Animator` → the ARKit→GNM map         |
| `?gain=<n>`   | Exaggerate the mapped expression (the idle clip and the stopgap map are quiet) |
| `?selftest=1` | GPU vertices vs the CPU reference, into `window.__AOS_SELFTEST__`              |
| `?bench=1`    | Rig and sort GPU time, into `window.__AOS_BENCH__`                             |
| `?orbit=1`    | Drag to orbit instead of the fixed front view                                  |
| `?sigma=<m>`  | Gaussian radius in metres (default 0.002)                                      |
| `?shading=`   | `tint` (default), `normal` (radial pseudo-normal), `flat`                      |
| `?tint=uv`    | Colour by the pack's `uv` instead of by skinning joint                         |
| `?dist=<m>`   | Camera distance; the rig is fitted to 0.35 m tall at the origin                |
| `?debug=1`    | Expose `window.__AOS_DEBUG__` — read slot ranges back from the console         |

Everything except `?bench=1` boots through `createEngine` with the `splat()` module, which is
the path a game takes. The benchmark builds its own renderer because it needs
`trackTimestamp: true`, which `createEngine` does not expose.

## What is measured

On an RTX-class GPU in headless Chromium, 17,821 vertices, 800×600:

| Measurement                                          |    Value | Gate        |
| ---------------------------------------------------- | -------: | ----------- |
| GNM blend + LBS + debug lift, GPU p50                | 0.014 ms | —           |
| Splat sort, GPU p50                                  | 0.315 ms | —           |
| Rig + sort, p50                                      | 0.330 ms | < 1.5 ms    |
| CPU→GPU bytes per frame                              |   1008 B | no vertices |
| Self-test: GPU vs the CPU reference (truncated pack) | 2.4e-7 m | ≤ 1e-5 m    |
| Self-test: GPU vs the CPU reference (full pack)      | 6.0e-7 m | ≤ 1e-5 m    |
| Self-test: full pack vs the python model             | 6.4e-8 m | reported    |
| Self-test: truncated pack vs the python model        | 5.8e-3 m | reported    |

The first two self-test rows are the **S4 acceptance**: the shader and the TypeScript reference
agree to well inside a micrometre, and `packages/character`'s node tests already hold that
reference to the python model. The last two are what the _pack_ costs — fp16 quantisation
(exactly nothing, because the packer's per-coefficient scales are powers of two) plus, for the
truncated pack, the 319 coefficients it dropped.

## The ORL path

`?rig=orl` needs a character bundle this repository does not ship — ORL is driven by a licensed
per-character DNA. Drop `orl_pack.bin` and `rig_names.json` into
`public/bundles/<name>/` and reload; without them the app says exactly that rather than 404ing.

## The ARKit → GNM map is a stopgap

`?anim=1` plays `gameable/placeholder`'s ARKit-52 idle through the real `Animator`
face layer and maps it into `head_ext` with `ARKIT_TO_GNM_DEFAULT`. That table is hand-authored
from a displacement ranking (`node ../../packages/character/scripts/rank-gnm-coefficients.mjs
public/generated/myra_head.aosrig`), not fitted: the real map ships as `arkit_to_gnm.json`
with the retrained decoders. It is deliberately conservative, so the idle moves the face by
about a millimetre — `?gain=6` exaggerates it for a screenshot without making it more correct.

## Tests

```sh
npx playwright install chromium                                                      # once
npx playwright test -c tests/e2e/playwright.config.ts --project=gpu tests/e2e/character-showcase.spec.ts
```

The suite **skips itself** when `public/generated/` holds no pack, so a machine without the
licensed source still runs the rest of the e2e suite.
