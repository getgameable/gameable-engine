# The engine loop

The host runs a single `requestAnimationFrame` loop with a fixed-step
accumulator. Simulation advances in whole steps of `1/60 s`; rendering happens
whenever the browser asks. The two are joined by `alpha`, the fraction of a step
left in the accumulator, which is how far to blend a transform from where it was
to where it is.

Each frame, in order:

1. `beginFrame()` on every module that implements it — input capture.
2. `fixedUpdate(dt)` on every module, **0 to 5 times**, `dt` always `1/60`.
3. `update(dtReal, alpha)` on every module, exactly once.
4. `renderer.render(scene, camera)`, with the sRGB splat pass (`attachSrgbPass`) hooked in: the
   opaque depth, then the splats blended on sRGB values, laid over the frame.
5. `endFrame()` on every module that implements it.

Game logic only ever sees the fixed step, so a replay of the same inputs
produces the same simulation on any machine.

## Who runs when inside a fixed step

Every module implementing a hook is called in `order`, lowest first:

| `order` | Module    | What it does in `fixedUpdate`                         |
| ------- | --------- | ----------------------------------------------------- |
| `-100`  | `input`   | Takes the frame's key, mouse and gamepad edges        |
| `-50`   | `game`    | One guest tick, then applies its commands             |
| `0`     | `physics` | Steps Jolt, then fires `physics:stepped`              |
| `200`   | rendering | Splats, overlays — `update` only, nothing in the step |

**The guest runs before physics**, and that is worth a paragraph. A
`move-character`, `apply-impulse` or `set-body-velocity` the guest emits is
applied to the world and then simulated by the step that follows it, in the
same 1/60 s. Run the guest after physics instead — as the engine used to — and
every command waits for the next step: one whole step of input latency between
the key going down and the character moving.

The bodies the guest reads are still the previous step's, and deliberately so:
they are the state it reacted to when it emitted those commands, which is what
keeps a replay deterministic. They reach it by way of `physics:stepped`, which
the game module subscribes to. The same handler writes each body's row straight
onto the entity it drives, so a physics-driven object never sends its transform
back across the wasm boundary — see
[the wasm boundary](./wasm-boundary.md) and [Physics](./physics.md).

## The substep cap and the death spiral

A frame that takes 200 ms owes twelve steps. Running all twelve makes the next
frame slower still, which owes more — the accumulator runs away and the game
freezes. So the loop runs at most `maxSubsteps` (default 5) and **throws the
rest away**: time is lost, and the game stays responsive. `FrameTiming.clamped`
says when that happened.

The other way round, a 60 Hz display driving a 60 Hz simulation lands within a
rounding error of a whole step every frame. The accumulator comparison carries a
microsecond of slack so float noise cannot turn that into an alternating
zero-step/two-step judder.

## Interpolation

`TransformStore` keeps every entity's transform twice: as it was at the end of
the previous fixed step, and as it is now. `commit()` moves current to previous;
`writeInterpolated(id, object3d, alpha)` writes the blend onto a three object —
lerped position and scale, slerped rotation, straight out of flat typed arrays
with no temporaries.

## Driving it yourself

`createFixedLoop` is pure and has no `requestAnimationFrame` in it, so it can be
driven from a test, a benchmark or a replay:

```ts
import { createFixedLoop } from 'gameable/core';

let ticks = 0;
const loop = createFixedLoop({
  fixedDt: 1 / 60,
  maxSubsteps: 5,
  fixedUpdate: () => {
    ticks += 1;
  },
  update: (dtReal, alpha) => {
    console.log(dtReal, alpha);
  },
});

loop.step(0); // baseline frame: no fixed step runs
const timing = loop.step(1000 / 30); // 33.3 ms buys two steps
console.log(ticks, timing.substeps, timing.alpha); // 2 2 <0..1>
```

## Rules

- **Nothing in `fixedUpdate` or `update` may allocate.** They run at least 60
  times a second. Preallocate typed arrays, pool objects, use dirty flags.
- **`update` is for presentation**, `fixedUpdate` is for simulation. Anything
  that must be deterministic belongs in the fixed step.
- **`time.timeScale` scales the simulation**, not the frame rate, and not
  the step: a fixed step is always `1 / fixedHz` long. Half speed means a frame
  buys half as many steps, so physics and the game see one constant `dt` at
  every speed and a recording replays at any speed. `0` pauses the simulation
  while frames keep rendering.

## See also

- [Modules](./modules.md)
- [The wasm boundary](./wasm-boundary.md)
- [Create an engine](../recipes/create-an-engine.md)

An explicit guest `markMoved(entity, TRANSFORM_FLAGS.ROTATION)` keeps the authored visual rotation through that fixed step’s physics readback. Body position still comes from physics. On a step without an authored rotation, the body rotation is used again. This lets a character face its travel direction without rotating its collision capsule.
