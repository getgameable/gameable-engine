# Vendored OpenRigLogic

`riglogic.wasm` and its emscripten glue `riglogic.js` are copied VERBATIM from
`aos-threejs-poc/src/lib/orl/` @ `cdd63b10`.

Provenance, from that repository's `CLAUDE.md` ("The exact MetaHuman rig (ORL)"):

> `src/lib/orl/riglogic.wasm` is the one static artifact and it is
> identity-INDEPENDENT code, built from the embind surface in the aosTools
> submodule (`aosTools/orl_wasm/`) — build tooling for a vendored library, the
> same category as `aosTools/texavatars/`, so this repo carries the built wasm and
> not the recipe. That build needs only Docker: OpenRigLogic is Epic's
> MIT-licensed release and `build.sh` fetches it pinned by SHA, reproducing the
> shipped binary byte for byte.

Two consequences that are load-bearing here:

- **The shipped wasm must export `getJointName`.** `bakeFromDna` reads it to write
  `jointNames` into a pack, and `shellDeform` binds the eye/teeth shells by those
  names — so a pack baked against a wasm without it drives the head fine and leaves
  the eyes and teeth at neutral.
- **`getJointOutputs` / `getBlendShapeOutputs` return ZERO-COPY VIEWS onto the wasm
  heap.** They are valid until the next `calculate()`, the build links
  `-sALLOW_MEMORY_GROWTH` so a heap grow DETACHES every existing view, and copying
  them allocated ~34 KB of garbage per call (measured 11.1 µs vs 0.25 µs). Never
  hold one across calls.

`.gitattributes` sends `**/*.wasm` to Git LFS; the `.js` glue is ordinary text and
is tracked in git proper. Do not edit either file — change the aosTools build and
re-copy.
