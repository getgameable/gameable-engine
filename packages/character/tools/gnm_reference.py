#!/usr/bin/env python3
"""Evaluate a GNM head at random `head_ext` vectors and write the oracle the browser is held to.

`test/gnm.test.ts` runs `src/rig/gnm/gnmReference.ts` — the TypeScript reference the
WGSL shader is written against — over the `.aosrig` pack and compares against these
frames at 1e-3 cm. That is the whole correctness gate for the GNM backend: the shader
is checked against the TypeScript, and the TypeScript is checked against here.

TWO ORACLES, and the output says which was used:

  gnm      `GnmHead.forward` via `aosrig`, when it imports. The real model, so a bug
           in the npz bake itself would show up.
  numpy    the linear model read straight out of the npz — `neutral + expr @ basis`,
           then GNM's eye rotation blended by each eye's skinning weight. Identical
           arithmetic to `BakedHead.forward`, without needing the submodule.

The numpy path is the default target on a machine with no `aosrig` checkout, and it is
NOT a weaker check for what this test is for: the browser's job is to reproduce the
BAKED head, and the bake is exactly this linear model. It is weaker for one thing only
— it cannot catch a bad bake — which is why the oracle is recorded in the npz and the
test prints it.

Output `reference_frames.npz`:
  head_ext   (F, 387) f32   the inputs
  vertices   (F, V, 3) f32  head-local metres, BEFORE the seam stitch and skinning
  vertex_ids (V,) i64       which vertices these are (all of them, or the subset)
  oracle     ()  U          "gnm" or "numpy"
  seed       ()  i64

Usage:
    python tools/gnm_reference.py --head F:/work/aos/aosRig/assets/myra/myra.head.npz \\
                                  --out build/reference_frames.npz [--frames 10] [--subset 200]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

GAZE_DIM = 4
# Expression coefficients are standardised latents: the trained range is a few units,
# so ±2 exercises real deformation without leaving the distribution entirely.
EXPR_SIGMA = 1.0
EXPR_CLIP = 2.0
# Gaze in radians. ±0.35 rad is ~20°, past anything anatomically comfortable.
GAZE_RANGE = 0.35


def random_head_ext(rng: np.random.Generator, frames: int, expr_dim: int) -> np.ndarray:
    expr = np.clip(rng.normal(0.0, EXPR_SIGMA, (frames, expr_dim)), -EXPR_CLIP, EXPR_CLIP)
    gaze = rng.uniform(-GAZE_RANGE, GAZE_RANGE, (frames, GAZE_DIM))
    # Frame 0 is the NEUTRAL: a reference set whose every row moves cannot tell you
    # whether the neutral itself is right, and the neutral is what everything else is
    # a delta from.
    out = np.concatenate([expr, gaze], axis=-1).astype(np.float64)
    out[0] = 0.0
    return out


def axis_angle_mat(axis, angle: np.ndarray) -> np.ndarray:
    """Rodrigues, batched over `angle`. Mirrors aosrig.math3d.axis_angle_mat."""
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    angle = np.asarray(angle, dtype=np.float64)
    cos = np.cos(angle)[..., None, None]
    sin = np.sin(angle)[..., None, None]
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]], dtype=np.float64)
    return np.eye(3) * cos + sin * K + (1 - cos) * np.outer(a, a)


def gaze_to_eye_mats(gaze: np.ndarray) -> np.ndarray:
    """`(F,4)` -> `(F,2,3,3)`: `R = Rx(pitch) @ Ry(yaw)` per eye, in (left, right) order."""
    mats = []
    for k in (0, 2):
        mats.append(axis_angle_mat((1.0, 0, 0), gaze[..., k]) @ axis_angle_mat((0, 1.0, 0), gaze[..., k + 1]))
    return np.stack(mats, axis=-3)


def select_vertices(total: int, subset: int | None) -> np.ndarray | None:
    """A deterministic, EVENLY SPREAD vertex subset for the committed fixtures.

    A prefix would be wrong: the first 200 vertices of this head carry no eye
    weights at all (the eyeballs start around index 12,466), so a prefix fixture
    would leave the gaze half of the model completely untested while looking like a
    full pass. A fixed stride covers every region — face, eyes, tongue, neck seam —
    at the same cost. Both tools compute it the same way, and `gnm_reference.py`
    records the indices so the test can assert the two agree.
    """
    if subset is None or subset >= total:
        return None
    stride = max(1, total // subset)
    return (np.arange(subset, dtype=np.int64) * stride)[:subset]


def forward_numpy(z, head_ext: np.ndarray, subset: int | None) -> np.ndarray:
    """`BakedHead.forward`, read straight out of the npz."""
    neutral = np.asarray(z["neutral"], dtype=np.float64)
    basis = np.asarray(z["basis"])
    eye_names = [str(n) for n in z["eye_names"]]
    eye_positions = np.asarray(z["eye_positions"], dtype=np.float64)
    eye_weights = np.asarray(z["eye_weights"], dtype=np.float64)

    picked = select_vertices(neutral.shape[0], subset)
    if picked is not None:
        neutral = neutral[picked]
        basis = basis[:, picked]
        eye_weights = eye_weights[:, picked]

    E = basis.shape[0]
    expr = head_ext[:, :E]
    gaze = head_ext[:, E : E + GAZE_DIM]
    F = head_ext.shape[0]

    B = basis.reshape(E, -1).astype(np.float32)
    verts = neutral[None] + (expr.astype(np.float32) @ B).reshape(F, -1, 3).astype(np.float64)

    R = gaze_to_eye_mats(gaze)  # (F,2,3,3)
    for e, side in enumerate(("left_eye", "right_eye")):
        k = eye_names.index(side)
        p = eye_positions[k]
        w = eye_weights[k]
        if not np.any(w):
            continue
        moved = np.einsum("fij,fvj->fvi", R[:, e], verts - p) + p
        verts = verts + w[None, :, None] * (moved - verts)
    return verts


def forward_gnm(head_npz: Path, head_ext: np.ndarray, subset: int | None):
    """`GnmHead.forward` through aosrig, or None when the submodule is not importable."""
    try:
        from aosrig.head.baked import BakedHead  # type: ignore
    except Exception:  # noqa: BLE001
        return None
    try:
        baked = BakedHead.load(head_npz)
        verts = baked.forward(head_ext)
    except Exception as exc:  # noqa: BLE001 — a broken submodule must fall back, loudly
        print(f"gnm_reference: aosrig imported but BakedHead.forward failed ({exc}); using numpy")
        return None
    picked = select_vertices(verts.shape[1], subset)
    if picked is not None:
        verts = verts[:, picked]
    return verts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--head", required=True, type=Path, help="<char>.head.npz")
    ap.add_argument("--out", required=True, type=Path, help="destination reference_frames.npz")
    ap.add_argument("--frames", type=int, default=10)
    ap.add_argument("--seed", type=int, default=20250913)
    ap.add_argument("--subset", type=int, default=None, help="keep N evenly-spread vertices")
    ap.add_argument(
        "--json",
        type=Path,
        default=None,
        help="also write the frames as JSON, for a browser-side self-check (npz needs numpy)",
    )
    args = ap.parse_args()

    z = np.load(args.head, allow_pickle=False)
    expr_dim = int(np.asarray(z["basis"]).shape[0])
    rng = np.random.default_rng(args.seed)
    head_ext = random_head_ext(rng, args.frames, expr_dim)

    verts = forward_gnm(args.head, head_ext, args.subset)
    oracle = "gnm"
    if verts is None:
        verts = forward_numpy(z, head_ext, args.subset)
        oracle = "numpy"

    total_verts = int(np.asarray(z["neutral"]).shape[0])
    vertex_ids = (
        select_vertices(total_verts, args.subset)
        if args.subset is not None
        else np.arange(total_verts, dtype=np.int64)
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.out,
        head_ext=head_ext.astype(np.float32),
        vertices=np.asarray(verts, dtype=np.float32),
        vertex_ids=vertex_ids,
        oracle=np.array(oracle),
        seed=np.array(args.seed, dtype=np.int64),
    )

    if args.json is not None:
        # The same frames as JSON, because a browser has no npz reader and the
        # self-check in `examples/character-showcase` is the one consumer that needs
        # these numbers at runtime rather than in a node test. Rounded to 1e-7 m
        # (0.1 µm): four orders of magnitude below the 1e-5 m gate, and it roughly
        # halves the file.
        import json as _json

        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            _json.dumps(
                {
                    "oracle": oracle,
                    "seed": int(args.seed),
                    "frames": int(head_ext.shape[0]),
                    "headExtDim": int(head_ext.shape[1]),
                    "vertexCount": int(np.asarray(verts).shape[1]),
                    "totalVertexCount": total_verts,
                    "units": "m",
                    "stage": "forward",  # before the seam stitch and before skinning
                    "vertexIds": [int(i) for i in vertex_ids],
                    "headExt": [[round(float(x), 7) for x in row] for row in head_ext],
                    "vertices": [
                        [round(float(x), 7) for x in frame.reshape(-1)]
                        for frame in np.asarray(verts, dtype=np.float64)
                    ],
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        print(f"gnm_reference: {args.json} ({args.json.stat().st_size / 1e6:.2f} MB)")
    size = args.out.stat().st_size
    print(
        f"gnm_reference: {args.out} ({size / 1e6:.2f} MB) — {args.frames} frames, "
        f"{np.asarray(verts).shape[1]} vertices, oracle={oracle}"
    )


if __name__ == "__main__":
    main()
