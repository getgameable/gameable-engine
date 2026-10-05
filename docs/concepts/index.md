# Concepts

Gameable Engine splits a game in two along one line: the **host** is a browser page
that owns the `WebGPURenderer`, Jolt physics, input, audio, the asset registry
and the splat characters; the **guest** is all of your game logic, TypeScript
compiled to a QuickJS WebAssembly component with bitecs 0.4 inside it. They meet
at a single WIT world and a single export per frame —
`tick(frame-input) -> frame-output` — so entity handles are minted by the guest,
continuous data crosses as packed `list<f32>`, structural changes cross as a
batched command list, and the only synchronous call back into the host is a
physics query. The rest of the engine follows from that shape: the host loop
advances simulation in whole `1/60 s` steps and renders whenever the browser
asks, blending the gap with `alpha`; every host subsystem is an `EngineModule`
plugged into that loop in `order`; content is addressed by string id, never by
URL; worlds are gaussian splats that three.js sorts on the GPU; and a character
is gaussians rewritten every frame by a compute shader, straight into the
renderer's buffers. Because the guest is a value-in, value-out function,
`npm run dev` can run the _same_ TypeScript directly in the host's realm with no
build step, and a parity test hashes both modes to keep them honest.

## One frame, end to end

```
        browser rAF
             │
             ▼
   ┌───────────────────┐
   │ beginFrame()      │  input module latches keys, mouse deltas, gamepads
   └─────────┬─────────┘
             │
             ▼
   ╔═════════╧═════════════════════════════════════════════╗
   ║ fixedUpdate(1/60), 0..5 times — the simulation step    ║
   ║                                                       ║
   ║   input state ──┐                                     ║
   ║   body buffer ──┼──► frame-input ──► GUEST tick()      ║
   ║   events      ──┘                      │  bitecs      ║
   ║                                        │  systems     ║
   ║                                        ▼              ║
   ║                          frame-output ─┤              ║
   ║                            transforms  │  commands    ║
   ║                                        │              ║
   ║   apply commands ◄─────────────────────┘              ║
   ║     spawn / add-body / play-sound / set-expression     ║
   ║                    │                                  ║
   ║                    ▼                                  ║
   ║              physics.step(dt) ──► new body transforms  ║
   ╚════════════════════╤══════════════════════════════════╝
                        │   (leftover time = alpha)
                        ▼
   ┌───────────────────────────────────────────────────────┐
   │ update(dtReal, alpha) — presentation only             │
   │   interpolate transforms onto three objects           │
   │   animator: body / additive / face / procedural       │
   │   character: rig ─► decoders ─► lift ─► GPU buffers   │
   └────────────────────────┬──────────────────────────────┘
                            ▼
                  renderer.render(scene, camera)
      (sRGB splat pass first: depth, splats back-to-front)
                            │
                            ▼
                        endFrame()
```

Everything above the `alpha` line is deterministic and replayable; everything
below it is presentation and may be skipped, interpolated or degraded.

## The pages

| Page                                    | What it answers                                            |
| --------------------------------------- | ---------------------------------------------------------- |
| [The engine loop](./engine-loop.md)     | Fixed step, substep cap, `alpha`, interpolation            |
| [Engine modules](./modules.md)          | How a host subsystem plugs in, `order`, services           |
| [Assets and the manifest](./assets.md)  | `assets.json`, string ids, handles, loaders                |
| [The wasm boundary](./wasm-boundary.md) | The WIT world, the JS shapes, direct vs wasm mode          |
| [ECS and game code](./ecs.md)           | `defineGame`, bitecs, tick order, zero allocation          |
| [Gaussian splats](./splats.md)          | The four GPU buffers, sorting, slots, the fork             |
| [Splat characters](./characters.md)     | Rig, decoders, lift, rig backends, expression spaces       |
| [Animation](./animation.md)             | The four layers, locomotion blending, head aim             |
| [Physics](./physics.md)                 | Jolt bodies, layers and masks, `CharacterVirtual`, queries |
| [Multiplayer](./multiplayer.md)         | The authority, the view, roles, Play Solo, room addresses  |

## Where the rules come from

A concept page says how something behaves. `AGENTS.md`, at the repository root, states
the rules that behaviour depends on.

## See also

- [Recipes](../recipes/index.md) — one task, at most two files
- [Glossary](../glossary.md) — what the jargon means here
- [Troubleshooting](../troubleshooting.md) — symptom first
