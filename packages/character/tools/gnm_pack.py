#!/usr/bin/env python3
"""Bake an aosRig ``BakedHead`` npz into a browser-ready ``.aosrig`` pack.

GNM is python-only and there is no ONNX export of it, so the browser side cannot run
the model — it runs the BAKED result: a neutral mesh, a linear expression basis, the
two eye joints gaze rotates about, and the rig skinning that keeps the neck seam
closed. This script is the whole conversion, and it deliberately reads the npz keys
DIRECTLY rather than importing ``aosrig``: the pack has to be reproducible on a
machine that has numpy and nothing else, and a bake is the wrong place to discover
that a submodule is missing.

``from aosrig.head.baked import BakedHead`` is attempted anyway, for one thing only:
if it imports, the layout and region names are read off ``block.HeadLayout`` instead
of the constants below, so a change to the model's parameter block cannot silently
leave a stale layout baked into a pack. Absent, the constants are used and the
header records that.

INPUT
  <char>.head.npz     aosRig ``BakedHead.save()``:
                        neutral (V,3) f32 · basis (E,V,3) f16|f32 · faces (T,3) i32
                        quads (Q,4) i32 · uv (V,2) f32 · quad_uv (Q,4,2) f32
                        eye_names (2,) U · eye_positions (2,3) f32 · eye_weights (2,V) f32
                        stitch_local (V,3) f32 · skin_index (V,4) u16 · skin_weight (V,4) f32
  <char>.aosrig.json  the rig: ``joints`` (name/parent) and ``head.attachment``
  <char>.aosrig.npz   ``bind_world`` (J,4,4) f32

OUTPUT
  <out>.aosrig        the container `src/rig/gnm/gnmPack.ts` parses.

WHAT THE CONVERSION ACTUALLY DOES, and each step is here because the browser cannot
do it cheaply at load:

1. TRANSPOSE THE BASIS to vertex-major ``(V,E,3)``. The bake is coefficient-major,
   which makes a GPU thread stride by ``V*3`` floats between its 383 reads.
2. QUANTISE IT TO fp16 with a per-coefficient scale, and pack the halves two to a
   u32 word. 78 MB -> 39 MB, and ``unpack2x16float`` is core WGSL so no adapter
   feature is needed. The scale is ``max|B[c]| / 65504`` clamped so a coefficient
   whose deltas are tiny does not lose its exponent range.
3. REMAP THE SKINNING to a COMPACT joint list — the head references 4-8 of the body
   rig's 54, and shipping 54 joints of skin rows would waste most of a uniform
   binding whose ceiling is what keeps the deform pipeline inside the default
   storage-buffer limit.
4. RECORD THE ATTACHMENT as ``bindTransform``. ``BakedHead.pose`` skins vertices in
   the body's BIND space, not head-local, so head-local has to travel
   ``head_bind_world @ local_to_head`` first. The pack keeps the model head-local
   (so gaze stays in the frame it is defined in) and the runtime folds this matrix
   into the skin matrices instead, which is exactly equivalent and costs nothing.

Usage:
    python tools/gnm_pack.py --head F:/work/aos/aosRig/assets/myra/myra.head.npz \\
                             --rig  F:/work/aos/aosRig/assets/myra/myra.aosrig \\
                             --out  build/myra.aosrig
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

MAGIC = b"AOSRIG01"  # 8 bytes: magic + format version
HEADER = 16
ALIGN = 8

# The parameter block, mirrored from aosrig/head/block.py. Used only when `aosrig`
# is not importable; see the module docstring.
FALLBACK_REGIONS = [
    ["left_eye", 100],
    ["right_eye", 100],
    ["lower_face", 150],
    ["tongue", 32],
    ["pupils", 1],
]
FALLBACK_REDUCED = {"left_eye": 16, "right_eye": 16, "lower_face": 28, "tongue": 3, "pupils": 1}
GAZE_DIM = 4

# fp16's largest finite value. The per-coefficient scale maps a basis row's peak onto
# this, so a row of millimetre deltas keeps its full mantissa.
HALF_MAX = 65504.0


def _align(n: int) -> int:
    return (n + (ALIGN - 1)) & ~(ALIGN - 1)


def head_layout() -> tuple[dict, str]:
    """The `head_ext` layout, from aosrig when it imports and from the constants when not."""
    try:
        from aosrig.head import block  # type: ignore

        layout = block.HeadLayout()
        return (
            {
                "dim": int(layout.dim),
                "exprDim": int(layout.expr_dim),
                "gazeDim": int(block.GAZE_DIM),
                "regions": [[r, int(n)] for r, n in layout.regions],
                "reduced": {k: int(v) for k, v in layout.reduced.items()},
            },
            "aosrig.head.block",
        )
    except Exception:  # noqa: BLE001 — any import failure means "use the constants"
        expr_dim = sum(n for _, n in FALLBACK_REGIONS)
        return (
            {
                "dim": expr_dim + GAZE_DIM,
                "exprDim": expr_dim,
                "gazeDim": GAZE_DIM,
                "regions": FALLBACK_REGIONS,
                "reduced": FALLBACK_REDUCED,
            },
            "gnm_pack.py constants",
        )


def float_to_half_array(values: np.ndarray) -> np.ndarray:
    """f32 -> u16 fp16 lanes, with numpy doing the rounding."""
    return values.astype(np.float16).view(np.uint16)


def pack_basis(basis: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict]:
    """Coefficient-major ``(E,V,3)`` -> vertex-major packed fp16 + per-coefficient scale.

    Returns ``(u32 words, f32 scales, stats)``. A scale of 0 would divide by zero, so
    a coefficient whose basis is identically zero keeps a scale of 1 and stores zeros.

    THE SCALE IS A POWER OF TWO, and that is the whole trick. The source basis is
    ALREADY fp16 in the bake, so a scale chosen as ``peak / 65504`` would re-round every
    value once more and lose up to an ulp per coefficient — accumulated over 383
    coefficients that measured **0.85 mm**, which is 85x the 1e-3 cm gate. A power of two
    is a pure exponent shift: the division and the shader's multiplication back are both
    EXACT, so an already-fp16 basis round-trips bit for bit and an f32 one loses only
    what fp16 costs it once.
    """
    E, V, _ = basis.shape
    b = np.asarray(basis, dtype=np.float32)
    peak = np.abs(b).reshape(E, -1).max(axis=1)
    with np.errstate(divide="ignore"):
        exponent = np.where(peak > 0, np.ceil(np.log2(peak / HALF_MAX)), 0.0)
    scale = np.where(peak > 0, np.exp2(exponent), 1.0).astype(np.float32)
    # Divide BEFORE the cast so the mantissa is used, and the shader multiplies the
    # scale back in once per coefficient rather than once per component.
    normalised = (b / scale[:, None, None]).astype(np.float16)

    # (E,V,3) -> (V,E,3), then flatten: a thread reading vertex v walks contiguously.
    vertex_major = np.ascontiguousarray(np.transpose(normalised, (1, 0, 2))).reshape(-1)
    lanes = vertex_major.view(np.uint16)
    if lanes.size % 2:
        lanes = np.concatenate([lanes, np.zeros(1, np.uint16)])
    words = lanes.view(np.uint32).copy()

    # What the quantisation cost, in the model's own units (metres).
    round_trip = (normalised.astype(np.float32) * scale[:, None, None]).astype(np.float32)
    err = np.abs(round_trip - b)
    stats = {
        "basisMaxAbsErrorM": float(err.max()),
        "basisMeanAbsErrorM": float(err.mean()),
        "basisPeakM": float(np.abs(b).max()),
    }
    return words, scale, stats


def compact_joints(skin_index: np.ndarray, names: list[str], parents: list[int]) -> tuple[list[int], np.ndarray]:
    """The joints the head actually references, plus every ancestor, in hierarchy order.

    Ancestors are kept even when no vertex is weighted to them: the forward walk that
    turns local transforms into world ones needs the chain, and a gap in it poses every
    descendant off a joint that is not there.
    """
    used = set(int(j) for j in np.unique(skin_index))
    closed = set(used)
    for j in used:
        p = parents[j]
        while p is not None and p >= 0 and p not in closed:
            closed.add(p)
            p = parents[p]
    # Hierarchy order (parents first) is what the runtime's forward walk requires.
    order = sorted(closed)
    remap = {old: new for new, old in enumerate(order)}
    new_index = np.vectorize(lambda j: remap[int(j)])(skin_index).astype(np.uint16)
    del names
    return order, new_index


def truncation_counts(layout: dict, keep: int) -> dict[str, int]:
    """How many coefficients of each region a ``--trunc-exp KEEP`` pack keeps.

    THE SHAPE OF THE TRUNCATION MATTERS MORE THAN ITS SIZE. The basis is ordered per
    region (left_eye 100, right_eye 100, lower_face 150, tongue 32, pupils 1), so keeping
    "the first KEEP coefficients" of the flat 383 would keep 64 left-eye coefficients and
    nothing else — a head that can only blink. The counts are taken from the model's own
    REDUCED ML view instead (`layout.reduced`, which sums to 64), scaled to whatever KEEP
    asks for, so every region survives in the proportion the model itself considers
    sufficient. ``--trunc-exp 64`` is therefore exactly the reduced view.

    Coefficients inside a region are ordered by explained variance, so keeping a prefix of
    each region is keeping its strongest modes.
    """
    reduced = {r: int(layout["reduced"].get(r, n)) for r, n in layout["regions"]}
    total_reduced = sum(reduced.values())
    if keep == total_reduced:
        return reduced
    ratio = keep / max(1, total_reduced)
    counts = {}
    for region, n in layout["regions"]:
        counts[region] = max(1, min(int(n), int(round(reduced[region] * ratio))))
    # Fix up the rounding on the largest region so the total is exactly `keep`.
    largest = max(counts, key=lambda r: counts[r])
    limits = {r: int(n) for r, n in layout["regions"]}
    counts[largest] = max(1, min(limits[largest], counts[largest] + (keep - sum(counts.values()))))
    return counts


def truncation_indices(layout: dict, counts: dict[str, int]) -> np.ndarray:
    """The coefficient indices a truncation keeps, in `head_ext` order."""
    kept = []
    start = 0
    for region, n in layout["regions"]:
        k = int(counts.get(region, 0))
        kept.extend(range(start, start + k))
        start += int(n)
    return np.asarray(kept, dtype=np.int64)


def truncation_report(head_npz: Path, basis: np.ndarray, kept: np.ndarray, frames_npz: Path) -> dict:
    """What dropping the other coefficients costs, on the recorded reference frames.

    The reference npz holds the `head_ext` vectors and the FULL model's vertices for a
    recorded vertex subset, so this is the honest measurement: reconstruct the same frames
    with only the kept coefficients and compare against what the whole model produced. It
    is reported in metres and in millimetres, because a pack that is 8 MB and wrong by a
    centimetre is not a saving.
    """
    ref = np.load(frames_npz, allow_pickle=False)
    head_ext = np.asarray(ref["head_ext"], dtype=np.float64)
    full = np.asarray(ref["vertices"], dtype=np.float64)
    ids = np.asarray(ref["vertex_ids"], dtype=np.int64)

    E = basis.shape[0]
    expr = head_ext[:, :E]
    dropped = np.setdiff1d(np.arange(E, dtype=np.int64), kept)
    if dropped.size == 0:
        return {"frames": int(head_ext.shape[0]), "maxAbsErrorM": 0.0, "meanAbsErrorM": 0.0}
    # The model is linear in `expr`, so the error of dropping coefficients is exactly the
    # contribution of the dropped ones — no need to re-run the gaze stage, whose rotation
    # is applied to both reconstructions identically at these small angles.
    B = np.asarray(basis[dropped][:, ids], dtype=np.float64).reshape(dropped.size, -1)
    delta = (expr[:, dropped] @ B).reshape(head_ext.shape[0], ids.size, 3)
    err = np.linalg.norm(delta, axis=-1)
    return {
        "frames": int(head_ext.shape[0]),
        "vertices": int(ids.size),
        "droppedCoefficients": int(dropped.size),
        "maxAbsErrorM": float(np.abs(delta).max()),
        "maxVertexErrorM": float(err.max()),
        "meanVertexErrorM": float(err.mean()),
        "referencePeakM": float(np.abs(full).max()),
    }


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


def read_rig(rig_stem: Path) -> dict:
    """Joint names/parents/bind_world plus the head attachment, from the aosrig pair."""
    # Appended, not `with_suffix`: the stem is `<char>.aosrig`, and `with_suffix`
    # would replace `.aosrig` rather than extend it.
    meta = json.loads(Path(f"{rig_stem}.json").read_text(encoding="utf-8"))
    arrays = np.load(Path(f"{rig_stem}.npz"), allow_pickle=False)
    names = [j["name"] for j in meta["joints"]]
    index = {n: i for i, n in enumerate(names)}
    parents = [(-1 if j["parent"] is None else index[j["parent"]]) for j in meta["joints"]]
    attachment = meta.get("head", {}).get("attachment", {})
    return {
        "names": names,
        "parents": parents,
        "bind_world": np.asarray(arrays["bind_world"], dtype=np.float64),
        "attachment": attachment,
    }


def head_bind_world(rig: dict) -> np.ndarray:
    """``head_bind_world @ local_to_head`` — head-local into the body's bind space.

    ``local_to_head`` is the head's own placement inside the ``head`` joint's frame,
    including the identity's uniform scale; ``bind_world[head]`` is where that joint
    sits at bind. Their product is the one matrix ``BakedHead.bind_space`` applies.
    """
    local_to_head = np.asarray(rig["attachment"].get("local_to_head"), dtype=np.float64)
    if local_to_head.shape != (4, 4):
        raise SystemExit("aosrig json: head.attachment.local_to_head is not a 4x4")
    head_index = rig["names"].index("head")
    return rig["bind_world"][head_index] @ local_to_head


def blob(name: str, dtype: str, shape, data: np.ndarray) -> dict:
    return {"name": name, "dtype": dtype, "shape": [int(d) for d in shape], "data": np.ascontiguousarray(data)}


def build(
    head_npz: Path,
    rig_stem: Path,
    subset: int | None,
    trunc_exp: int | None = None,
    trunc_report_frames: Path | None = None,
    lean: bool = False,
) -> bytes:
    z = np.load(head_npz, allow_pickle=False)
    layout, layout_source = head_layout()

    neutral = np.asarray(z["neutral"], dtype=np.float32)
    basis = np.asarray(z["basis"])
    V = neutral.shape[0]
    E = basis.shape[0]
    if basis.shape[1] != V:
        raise SystemExit(f"basis is (E={E}, V={basis.shape[1]}), neutral has {V} vertices")
    if E != layout["exprDim"]:
        raise SystemExit(f"basis has {E} coefficients, the layout declares {layout['exprDim']}")

    faces = np.asarray(z["faces"], dtype=np.uint32)
    quads = np.asarray(z["quads"], dtype=np.uint32) if "quads" in z.files else None
    uv = np.asarray(z["uv"], dtype=np.float32) if "uv" in z.files else None
    eye_names = [str(n) for n in z["eye_names"]]
    eye_positions = np.asarray(z["eye_positions"], dtype=np.float32)
    eye_weights = np.asarray(z["eye_weights"], dtype=np.float32)
    stitch = np.asarray(z["stitch_local"], dtype=np.float32) if "stitch_local" in z.files else None
    if "skin_index" not in z.files:
        raise SystemExit("this bake carries no skin_index — re-bake with a HeadSeam")
    skin_index = np.asarray(z["skin_index"], dtype=np.int64)
    skin_weight = np.asarray(z["skin_weight"], dtype=np.float32)

    # A truncated pack for the committed fixtures: a strided vertex subset, with the
    # topology dropped (a partial mesh's faces index vertices that are gone).
    # `--lean`: drop the topology. NOTHING in the runtime rig path reads `faces` or
    # `quads` — the blend, the gaze and the LBS are all per-vertex, and the debug preview
    # draws one gaussian per vertex — so for a pack that only ever drives the rig they are
    # 0.7 MB of download for nothing. `uv` stays: the preview colours by it.
    if lean:
        faces = np.zeros((0, 3), np.uint32)
        quads = None

    picked = select_vertices(V, subset)
    if picked is not None:
        V = int(picked.size)
        neutral = neutral[picked]
        basis = basis[:, picked]
        eye_weights = eye_weights[:, picked]
        skin_index = skin_index[picked]
        skin_weight = skin_weight[picked]
        if stitch is not None:
            stitch = stitch[picked]
        faces = np.zeros((0, 3), np.uint32)
        quads = None
        uv = uv[picked] if uv is not None else None

    # A truncated expression basis: fewer coefficients, in every region, so the pack fits
    # a dev machine's download budget. The layout is rewritten to match, which is what
    # keeps `coeffCount == headExt.exprDim` — the runtime pads a short control vector
    # against the LAYOUT, so a pack whose two disagreed would blend garbage.
    truncation = None
    if trunc_exp is not None and trunc_exp < E:
        counts = truncation_counts(layout, trunc_exp)
        kept = truncation_indices(layout, counts)
        truncation = {
            "fromCoefficients": int(E),
            "keptPerRegion": {r: int(counts[r]) for r, _ in layout["regions"]},
            "coefficientIds": [int(i) for i in kept],
        }
        if trunc_report_frames is not None and trunc_report_frames.exists():
            truncation["error"] = truncation_report(head_npz, basis, kept, trunc_report_frames)
            err = truncation["error"]
            print(
                f"gnm_pack: truncation to {int(kept.size)} coefficients costs "
                f"max {err['maxVertexErrorM'] * 1000:.3f} mm, mean "
                f"{err['meanVertexErrorM'] * 1000:.4f} mm over {err['frames']} reference frames"
            )
        basis = np.asarray(basis)[kept]
        E = int(kept.size)
        layout = {
            "dim": E + int(layout["gazeDim"]),
            "exprDim": E,
            "gazeDim": int(layout["gazeDim"]),
            "regions": [[r, int(counts[r])] for r, _ in layout["regions"]],
            "reduced": {r: int(counts[r]) for r, _ in layout["regions"]},
        }

    rig = read_rig(rig_stem)
    order, remapped_index = compact_joints(skin_index, rig["names"], rig["parents"])
    joint_names = [rig["names"][j] for j in order]
    position = {old: new for new, old in enumerate(order)}
    joint_parents = np.array(
        [position.get(rig["parents"][j], -1) if rig["parents"][j] >= 0 else -1 for j in order],
        dtype=np.int32,
    )
    rest_world = np.ascontiguousarray(rig["bind_world"][order], dtype=np.float32).reshape(-1)
    bind_transform = head_bind_world(rig)

    words, scale, quant_stats = pack_basis(np.asarray(basis, dtype=np.float32))

    blobs = [
        blob("neutral", "f32", (V, 3), neutral.reshape(-1)),
        blob("basis", "u32", (words.size,), words),
        blob("basisScale", "f32", (E,), scale),
        blob("skinIndex", "u16", (V, 4), remapped_index.reshape(-1).astype(np.uint16)),
        blob("skinWeight", "f16", (V, 4), float_to_half_array(skin_weight.reshape(-1))),
        blob("eyePositions", "f32", (2, 3), eye_positions.reshape(-1)),
        blob("eyeWeights", "f32", (2, V), eye_weights.reshape(-1)),
        blob("restWorld", "f32", (len(order), 4, 4), rest_world),
        blob("jointParents", "i32", (len(order),), joint_parents),
        blob("faces", "u32", faces.shape, faces.reshape(-1)),
    ]
    if quads is not None and quads.size:
        blobs.append(blob("quads", "u32", quads.shape, quads.reshape(-1)))
    if uv is not None and uv.size:
        blobs.append(blob("uv", "f32", uv.shape, uv.reshape(-1)))
    if stitch is not None:
        blobs.append(blob("stitchLocal", "f32", (V, 3), stitch.reshape(-1)))

    header = {
        "version": 1,
        "model": "gnm",
        "vertexCount": int(V),
        "coeffCount": int(E),
        "maxInfluence": 4,
        "units": "m",
        "headExt": layout,
        "joints": [
            {"name": n, "parent": int(joint_parents[i])} for i, n in enumerate(joint_names)
        ],
        "eyes": {"names": eye_names},
        "bindTransform": [float(x) for x in bind_transform.reshape(-1)],
        "source": {
            "head_npz": head_npz.name,
            "rig": rig_stem.name,
            "layout_from": layout_source,
            "truncated_to": int(V) if subset is not None else None,
            "truncatedExpression": truncation,
            "lean": bool(lean),
            **quant_stats,
        },
        "buffers": [],
    }
    return serialise(header, blobs)


def serialise(header: dict, blobs: list[dict]) -> bytes:
    """Two passes, because the header records absolute offsets and so has its own length."""

    def with_offsets(header_len: int):
        off = _align(HEADER + header_len)
        entries = []
        for b in blobs:
            entries.append(
                {
                    "name": b["name"],
                    "dtype": b["dtype"],
                    "shape": b["shape"],
                    "offset": off,
                    "byteLength": int(b["data"].nbytes),
                }
            )
            off = _align(off + int(b["data"].nbytes))
        full = dict(header)
        full["buffers"] = entries
        return full, off

    header_len = len(json.dumps(with_offsets(0)[0], separators=(",", ":")).encode("utf-8"))
    full, body = with_offsets(header_len)
    for _ in range(4):
        encoded = json.dumps(full, separators=(",", ":")).encode("utf-8")
        if len(encoded) <= header_len:
            break
        header_len = len(encoded)
        full, body = with_offsets(header_len)
    encoded = json.dumps(full, separators=(",", ":")).encode("utf-8")
    if len(encoded) > header_len:
        raise SystemExit("header did not converge")

    out = bytearray(body)
    out[0:8] = MAGIC
    struct.pack_into("<I", out, 8, header_len)
    struct.pack_into("<I", out, 12, body)
    out[HEADER : HEADER + len(encoded)] = encoded
    for entry, b in zip(full["buffers"], blobs):
        raw = b["data"].tobytes()
        out[entry["offset"] : entry["offset"] + len(raw)] = raw
    return bytes(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--head", required=True, type=Path, help="<char>.head.npz")
    ap.add_argument("--rig", required=True, type=Path, help="<char>.aosrig stem (no extension)")
    ap.add_argument("--out", required=True, type=Path, help="destination .aosrig")
    ap.add_argument(
        "--subset",
        type=int,
        default=None,
        help="keep N evenly-spread vertices (committed fixtures; drops the topology)",
    )
    ap.add_argument(
        "--trunc-exp",
        type=int,
        default=None,
        help="keep only N expression coefficients, spread across the regions in the "
        "proportions of the model's reduced view (64 == exactly the reduced view)",
    )
    ap.add_argument(
        "--lean",
        action="store_true",
        help="drop the topology (faces/quads); the runtime rig path never reads it",
    )
    ap.add_argument(
        "--trunc-report",
        type=Path,
        default=None,
        help="a reference_frames.npz to measure the truncation error against",
    )
    args = ap.parse_args()
    data = build(args.head, args.rig, args.subset, args.trunc_exp, args.trunc_report, args.lean)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(data)
    print(f"gnm_pack: {args.out} ({len(data) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
