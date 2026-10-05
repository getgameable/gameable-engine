# Glossary

Terms that mean something specific in this repository.

**AAM** — AvatarOS Asset Manager. The optional remote asset backend behind
`gameable/aam`. It produces ordinary manifest entries; it is not a second
addressing scheme.

**Action** — A named input, resolved by `gameable/input` and read as
`input.pressed('fire')` or `input.axis2('move')`. Game code names actions; only
the action map names keys.

**`alpha`** — The fraction of a fixed step left over in the loop's accumulator
when a frame renders, in `[0, 1)`. How far to blend a transform from where it was
at the last fixed step to where it is now. Passed to `update(dtReal, alpha)` and
to `writeInterpolated`.

**`.aosrig`** — The baked rig pack a `RigBackend` consumes: a JSON header plus
neutral vertices, an expression basis, skinning weights, joints and topology.
Produced offline by `packages/character/tools/gnm_pack.py` from an aosRig
`BakedHead`.

**ARKit-52** — The 52-blendshape facial expression space face clips are authored
in. Mapped into a bundle's own expression space at load time, never hardcoded.

**`BakedHead`** — The numpy-only artefact aosRig exports from GNM: neutral mesh,
expression basis, eye joints, skinning and topology. The engine's handoff from
the Python side.

**bitecs** — The ECS library. Version 0.4, structure-of-arrays, and it lives
inside the wasm guest.

**Branch** — One part an exporter split an avatar into: `head`, `eyes`, and on a
clothed bundle `top`, `bottom`, `hair`. Each has its own decoders and its own slot
range inside one animated splat.

**Bundle** — A character's shipped directory: `scene.json` plus decoders,
geometry and appearance data.

**Command** — A structural change the guest requests, as a variant in
`frame-output`: spawn, despawn, add-body, play-sound, and so on. Commands are
batched; they do not return values in the same frame.

**Component (ECS)** — A typed column of data in bitecs, read as
`Transform.x[entity]`. Not to be confused with a wasm component.

**Component (wasm)** — A WebAssembly Component Model artifact: the compiled game
module, built with `jco componentize` and loaded with `jco transpile`.

**Direct mode** — `createSandbox({ mode: 'direct' })`. Runs the game's
TypeScript through the same guest runtime as wasm, in the host's realm, for fast
iteration. Parity with wasm mode is enforced by a test, not by discipline.

**`gameable-source` condition** — The package export condition that resolves to
`src/index.ts` instead of `dist/`. Why `npm install` is the only build step.

**Engine module** — `{ id, order?, init, fixedUpdate?, update?, dispose }`. How
every host subsystem plugs into the loop.

**Expression space** — What a bundle expects `setExpression` to be given:
`arkit52` (52), `gnm` (387), or `gnm68` (68). Declared in the bundle, because two
spaces that share a width are otherwise indistinguishable.

**Fixed step** — The simulation quantum, `1/60 s`. `fixedUpdate(dt)` always gets
that `dt`, runs 0 to 5 times per frame, and is the only place deterministic work
belongs. Rendering is not fixed-step; it happens whenever the browser asks.

**`frame-input` / `frame-output`** — The two records that cross the wasm
boundary once per fixed step. Input carries time, input state, body state,
events and, in a room, every player's input (`players`); output carries
transforms, commands, the commands applied on the authority only
(`local-commands`), the camera and the HUD.

**Gaussian splat** — A point primitive with a position, a 3D covariance, a
colour and an opacity. Worlds and characters are both made of them. On the GPU it
is 52 bytes: centre, two covariance halves and a packed colour word.

**GNM** — Google's parametric head model. 253 identity and 383 expression
parameters, Apache-2.0, Python only. The second `RigBackend`; it reaches the
browser as a bake, never as an inference session.

**Guest** — The wasm side: game logic, the ECS, the SDK runtime.

**Handle** — A stable integer that stands in for a string across the boundary. An
asset handle is a 1-based `u32` assigned in manifest order (`0` means "no
asset"); entity and body handles are minted by the guest.

**Host** — The browser side: renderer, physics, input, audio, assets,
characters.

**`head_ext`** — GNM's per-frame input: 387 floats, 383 expression coefficients
followed by `[pitchL, yawL, pitchR, yawR]` gaze angles in radians.

**jco** — The JavaScript Component Tools. `jco componentize --backend qjs`
builds the guest; `jco transpile` makes it loadable in a browser.

**Jolt** — The physics engine, `jolt-physics` 1.1, compiled to wasm.

**Lift** — The WGSL compute pass that turns character vertices and decoder
output into gaussians written straight into GPU storage buffers. Two passes:
frame and bounds, then eigen-decompose and pack.

**`llms-full.txt` / `llms.txt`** — The generated core documentation corpus and its
index, committed to the repository and size-budgeted by `docs:lint`. Topics with a
bundle of their own (`llms-multiplayer.txt`, `llms-character.txt`) are not in the core
corpus, which points to them.

**Manifest** — `assets.json`. Maps string ids to files, types and metadata. The
only thing that knows where bytes live.

**ORL** — OpenRigLogic. The first rig backend: the character's own DNA, evaluated
by a vendored wasm module, then blendshape deltas and skinning on the GPU.

**POC** — `F:\work\aos\aos-threejs-poc`, the React-Three-Fiber prototype the
character runtime is ported from.

**Prefab** — A pure description of an entity — asset, body, health, components —
built by `prefab()` at module scope and instantiated with `ctx.spawn(...)`. It
allocates nothing and mints no ids until it is spawned.

**Rig backend** — The pluggable first stage of the character pipeline: controls
in, posed vertices in a GPU buffer out. `orl` and `gnm` ship, and a bundle's
`scene.json` names which one posed it.

**Sandbox** — The interface the host uses to run game logic:
`tick(frame-input) -> frame-output`, in `wasm` or `direct` mode.

**Slot range** — A contiguous span of gaussians inside one animated splat, owned
by one branch of a character. Slots are fixed and never compacted: a culled
gaussian is written with alpha 0 and keeps its address.

**SPZ** — The recommended compressed splat container format.

**System** — A plain function of the frame context that the guest runs every
fixed step, in declaration order. It must not allocate.

**Wizer** — The pre-initialiser that snapshots the QuickJS heap at build time.
Why module-level state (including a seeded RNG) must be created in `init`, not
at import time.

**WIT** — The interface description language for the component boundary. The
world is `gameable:engine@0.2.0 / game-module`, in `wit/`.
