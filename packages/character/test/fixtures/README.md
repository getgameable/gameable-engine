# Test fixtures

Every file here is checked in, and the whole directory is **0.81 MB** — small enough that
`npm test` needs no network, no GPU and no submodule checkout. Where a real asset would have
been too large, the fixture is a deterministic subset and this file says how to regenerate it.

## `bundle/scene.json`

A verbatim copy of `aos-threejs-poc/public/assets/ogs/myra/scene.json` @ `cdd63b10` — a
`multi_region` manifest with a `head` and an `eyes` branch and no `rig` or `expression_space`
block. It is the fixture for `manifest.test.ts` precisely _because_ it declares neither: it is
what a legacy bundle looks like, so every engine-side default is exercised against a real
shipped file rather than against a hand-written one that agrees with the parser by
construction.

## `orl/deform-synthetic.json`

A verbatim copy of the POC's `tests/fixtures/orlDeformSynthetic.json` @ `cdd63b10`: a tiny
hand-built ORL case — neutral vertices, int8 blendshape deltas, a CSR scatter, joint matrices
and the expected deformed result. Small enough to read, which is the point: when
`deform.ts` disagrees with it, the disagreement is findable by eye.

## `gnm/myra-200.aosrig`

A **200-vertex truncation** of the shipped `myra` head, 464 KB. The full pack is 39 MB of
basis alone, far past the 5 MB fixture budget.

Regenerate with:

```sh
python packages/character/tools/gnm_pack.py \
  --head  <path>/myra.head.npz \
  --rig   <path>/myra.aosrig \
  --out   packages/character/test/fixtures/gnm/myra-200.aosrig \
  --subset 200
```

The subset is an **evenly-spread stride**, not the first 200 vertices, and that is
load-bearing: the first 200 vertices of the head carry no eye skinning weight at all (the eyes
start around vertex 12,466), so a head-of-array subset would have made every gaze assertion
pass vacuously. `gnm_reference.py` selects with the identical function, and the reference npz
records the chosen `vertex_ids`, so the two can never drift apart.

The pack's own header records its provenance under `source`: the input npz and rig names,
whether the layout came from `aosrig.head.block` or from the script's constants, the truncation
count, and the measured fp16 basis error — **0.0 m**, because the packer rounds every
per-coefficient scale down to a power of two and `gnm.test.ts` asserts that requantisation is
exactly lossless.

## `gnm/reference_frames.npz`

The CPU oracle: 10 random `head_ext` vectors (seed `20250913`) and the head-local vertices the
python model produces for them, for the same 200 `vertex_ids`. `gnm.test.ts` runs
`src/rig/gnm/gnmReference.ts` over the pack and compares.

```sh
python packages/character/tools/gnm_reference.py \
  --head  <path>/myra.head.npz \
  --out   packages/character/test/fixtures/gnm/reference_frames.npz \
  --frames 10 --seed 20250913 --subset 200
```

The npz records which oracle produced it — `gnm` when the `aosrig` package imports, `numpy`
when it does not — and the test prints it. This fixture was generated with the **`numpy`**
oracle: the same linear model the bake stores, evaluated straight out of the npz. That is the
right gate for what is being tested (the browser must reproduce the _baked_ head, and the bake
is exactly this arithmetic); it is weaker in one respect only, in that it cannot catch a bad
bake.

This is the fixture that caught the gaze quaternion's Z-term sign. Composing `Ry·Rx` instead
of `Rx·Ry` is correct on each axis alone and wrong only on the diagonal — every single-axis
check still passed, and the error showed up here as 0.85 mm.

## `aosrig-splat-soma/` and `aosrig-splat-soma/steph/`

The version 2 package's body, held to the studio's own player. Each folder is what the
studio's exporter writes for this test from a real package (aos-gameable-cc,
`companion/engine_package.py`, on 2026-09-25): the package's `skeleton.json` byte for byte,
one of its clips cut to three frames (`clips.json`), and `expected.json`, the 110 joints'
worlds that `soma_body.Rig.pose` makes of that skeleton at the middle frame (row-major 4 x 4).
The exporter picks the clip and frame with the largest twist-helper angle in the package, so
the test cannot pass with the helpers left at rest: 97.9 degrees on Tala's test package
(`ual_celebration`), 147.4 degrees on Steph's.

```sh
cd companion
python engine_package.py --check-only <package folder> --pose-fixture <this folder>
```
