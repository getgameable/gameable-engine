# Physics

Physics is Jolt (`jolt-physics` 1.1, wasm) behind an `EngineModule`. It provides
rigid bodies, `CharacterVirtual` controllers, raycast / raycast-batch /
overlap-sphere queries, contact events and a wireframe debug view. Queries are
the only synchronous imports the guest gets; everything that mutates the world is
a command in `frame-output` (`add-body`, `apply-impulse`, `move-character`, ...).
Physics steps inside `fixedUpdate`, so results are deterministic for a given
command stream.

## The shape of a frame

```
fixedUpdate(dt)
  game     (-50) -> guest tick()        game: reads last step's bodies
                 -> apply commands      host: move-character, apply-impulse, ...
  physics  (0)   -> world.step(dt)      host: simulates those commands now
                 -> 'physics:stepped'   host: readBodies(buffer) once, and
                                              the rows go straight onto the
                                              entities they drive
                 -> drainContacts(pool) host: only bodies flagged report-contacts
```

The guest runs **before** the step, so a command it emits is simulated in the
same fixed step — that is one step of input latency removed. The rows it reads
are the previous step's: exactly the state it was reacting to. The host applies
those same rows to the scene itself, which is why a body-driven entity never
appears in `frame-output.transforms`; see
[the wasm boundary](./wasm-boundary.md).

The body buffer is a packed `Float32Array`, stride 15, one row per **enabled
non-static** body, sorted ascending by body id:

| lane  | meaning                                                                        |
| ----- | ------------------------------------------------------------------------------ |
| 0     | body id                                                                        |
| 1–3   | position x, y, z                                                               |
| 4–7   | rotation x, y, z, w                                                            |
| 8–10  | linear velocity                                                                |
| 11–13 | angular velocity                                                               |
| 14    | ground state: 0 unknown/non-character, 1 ground, 2 steep, 3 unsupported, 4 air |

Static bodies are never written — they never move, and the guest already knows
where it put them. Neither is a **sleeping** body re-read: Jolt parks a body
that has settled, and the world replays the last row it read for it, which is
one wasm crossing instead of fifteen. Any setter (`set-body-transform`,
`set-body-velocity`, `apply-impulse`, `set-body-enabled`) drops that mirror, so
a teleported sleeper still reads true.

The buffer is preallocated and reused; `readBodies` returns the row count it
_wanted_, so a guest that outgrows its buffer grows it once and carries on
rather than allocating every frame. `movingBodyCount` is that number _before_
the call, which is how the host sizes its buffer without ever reading twice.

## Contacts are opt-in

A body reports nothing unless it asks to. Two flags, both off by default:

| Flag             | Emits                                                    |
| ---------------- | -------------------------------------------------------- |
| `reportContacts` | `begin` when a pair starts touching, `end` when it stops |
| `reportStay`     | ...and `stay`, every step, for as long as it touches     |

One flagged side of a pair is enough — a projectile that wants to know what it
hit does not need every wall in the level to agree.

The default is off because contacts are not free: a world of resting crates
generates a manifold per touching pair per step whether or not anybody reads
it, and turning one into a record costs wasm crossings. Flag the handful of
bodies whose collisions the game reacts to and the rest cost a single integer
comparison. `stay` is separately opt-in because it is the expensive one: a box
on a floor emits it sixty times a second forever, and `begin`/`end` are enough
to answer "am I touching this".

A step that produces more reportable contacts than `maxContactsPerStep` (256 by
default) drops the surplus and warns once, because growing the pool would mean
allocating inside Jolt's own `Step()`.

## Layers and masks

A body declares what it **is** (`layer`) and what it **collides with** (`mask`),
both as bitsets. Two bodies interact only when `a.mask & b.layer` and
`b.mask & a.layer` are both non-zero, which makes one-way relationships
impossible by construction — a pickup that ignores the player is a pickup the
player also walks through.

Jolt itself wants a symmetric table of _object layers_, so the module mints one
object layer per distinct `(layer, mask, moving)` triple a game actually uses,
lazily, and enables the pairs that the masks imply. Sixty-four slots — thirty-two
static, thirty-two moving — cover any reasonable game; `layers.maxObjectLayers`
raises the ceiling.

## Characters

A `character` body is a Jolt `CharacterVirtual`, not a rigid body: it has no
inertia, does not bounce, and is moved by setting a desired velocity rather than
by forces. It carries an _inner_ kinematic body so that other bodies collide with
it and raycasts hit it, which is why one body id addresses both halves.

`move-character` takes the horizontal components literally. A positive `y` while
grounded is a jump — an edge, consumed once, so one jump command does not
re-launch the character every time it lands. After that gravity integrates until
it lands. The controller sticks to the floor over small drops, walks up stairs,
and refuses slopes steeper than 45° (Jolt's own default is 50°, which lets a
player walk up scenery an artist drew as a wall).

Only contacts below the capsule's lower hemisphere count as ground, so brushing
a pillar is not standing on it.

Disabling a character is the one thing `set-body-enabled` cannot do properly: the
controller owns its inner body and destroys it itself, so the engine stops
stepping and reading a disabled character but leaves that body in the broad
phase. Things still bump into it. Remove it when it has to stop existing.

## Queries

`raycast`, `raycast-batch` and `overlap-sphere` are the only blocking calls the
guest may make during `tick`, because each one is a full canonical-ABI round
trip. Prefer the batch form: it packs N rays into one buffer (stride 7) and
returns N results (stride 9) for a single crossing.

Mesh colliders respect triangle winding — Jolt ignores back faces — so a collider
baked with the wrong winding is invisible to hitscan weapons while still stopping
the player.

## Debug view

`engine.get('physics').debugWireframe(scene)` adds a `LineSegments` drawing each
body's oriented bounds. The line buffer is rebuilt only when the set of bodies
changes; every other frame just rewrites the existing positions.

## See also

- [The engine loop](./engine-loop.md)
- [Modules](./modules.md)
- [Add a physics body](../recipes/add-a-physics-body.md)
- `packages/physics-jolt/README.md` — gameable/physics
