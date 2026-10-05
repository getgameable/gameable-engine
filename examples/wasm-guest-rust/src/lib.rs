//! A complete gameable game module written in Rust.
//!
//! The reference guest is TypeScript compiled by `jco componentize --backend
//! qjs`. Nothing about the `gameable:engine@0.2.0 / game-module` world requires
//! JavaScript, though: the world is resource-free and async-free by design, so
//! `wit-bindgen` plus `cargo build --target wasm32-wasip2` produces a component
//! the very same host loads, through the very same `createSandbox`.
//!
//! This file is the proof, and it is meant to be read top to bottom: `init`
//! seeds a xorshift RNG and resolves assets; `tick` ingests `bodies`, walks the
//! player from WASD, orbits three boxes, raycasts on left mouse button and
//! emits transforms, a camera and a HUD; `snapshot` / `restore` are a
//! hand-rolled little-endian encoding; `shutdown` has nothing to release.
//!
//! The one engine rule that bites hardest here is "no allocation in a system".
//! Rust cannot honour it completely: `frame-output.transforms` is a `Vec<f32>`
//! that the canonical ABI takes by value, so one allocation per frame is
//! structural. Everything else — the command list, the HUD string — is either
//! pre-sized or skipped on most frames.

// Generate bindings straight from the repository's WIT. Note the path: this
// crate does NOT copy `wit/` — a copied WIT package is a second source of
// truth and will drift. `world: "game-module"` picks the world out of
// `wit/world.wit`.
wit_bindgen::generate!({ path: "../../wit", world: "game-module" });

use std::cell::RefCell;

// Imports the host supplies. `physics_query::raycast` is the only synchronous
// host call a tick may make; `assets::resolve_id` is init-time only.
use crate::gameable::engine::{assets, env, physics_query};
// Types the `game` interface does not itself `use`, so they live in `types`.
use crate::gameable::engine::types::{
    CameraMode, ErrorCode, LogLevel, ProjectionKind, QueryFilter, TransformFlags,
};
// Everything the exported interface speaks. `Guest` is the trait to implement.
use crate::exports::gameable::engine::game::{
    AddBodyCmd, AssetId, AudioBus, BodyFlags, BodyId, BodyKind, CameraState, CollisionLayers,
    Command, Entity, FrameInput, FrameOutput, GameConfig, GameError, Guest, MoveCharacterCmd,
    PlaySoundCmd, Quat, Shape, ShapeKind, SpawnCmd, Vec3,
};

// ---------------------------------------------------------------------------
// Constants. Ids are guest-minted: the host never hands one back, so the guest
// is free to allocate them however it likes. Fixed small integers are plenty.
// ---------------------------------------------------------------------------

/// The player's entity, and the body that drives it.
const PLAYER: Entity = 1;
/// Boxes get entities (and bodies) 2, 3, 4.
const FIRST_BOX: Entity = 2;
/// How many boxes orbit the arena.
const BOX_COUNT: usize = 3;
/// Stride of one `frame-input.bodies` row.
const BODY_STRIDE: usize = 15;
/// Stride of one `frame-output.transforms` row.
const TRANSFORM_STRIDE: usize = 12;
/// Key bit indexes, straight out of `packages/sdk/src/keycodes.ts`.
const KEY_W: usize = 22;
const KEY_A: usize = 0;
const KEY_S: usize = 18;
const KEY_D: usize = 3;
/// Metres per second the player walks at.
const WALK_SPEED: f32 = 4.0;
/// Radians of yaw per pixel of mouse movement.
const MOUSE_SENSITIVITY: f32 = 0.0025;
/// How far the hitscan reaches.
const RANGE: f32 = 100.0;
/// Where the boxes orbit, and how fast.
const ORBIT_CENTER: [f32; 3] = [0.0, 1.0, -6.0];
const ORBIT_RADIUS: f32 = 3.0;
const ORBIT_SPEED: f32 = 0.8;
/// Snapshot format: four magic bytes then a version that `restore` checks.
const SNAPSHOT_MAGIC: [u8; 4] = *b"AOSR";
const SNAPSHOT_VERSION: u8 = 1;
/// Exact snapshot size: an 8-byte header, two u64s, five u32s, two f32s, the
/// player's three axes, and one f32 of orbit phase per box.
const SNAPSHOT_BYTES: usize = 8 + 16 + 20 + 8 + 12 + 4 * BOX_COUNT;

// ---------------------------------------------------------------------------
// Guest state
// ---------------------------------------------------------------------------

/// Everything this module remembers between ticks.
struct State {
    /// Fixed simulation rate, from `game-config`.
    fixed_hz: u32,
    /// Dev mode turns on the chatty `env.log` lines.
    dev_mode: bool,
    /// xorshift64 state, seeded in `init` from `env.seed()`.
    rng: u64,
    /// Asset handles, resolved once in `init` and cached forever after.
    box_asset: Option<AssetId>,
    shot_asset: Option<AssetId>,
    /// Set on the first tick, so frame 0 spawns exactly once even if the host
    /// replays frame 0 (which `restore` plus a re-tick does).
    spawned: bool,
    /// Last frame number seen, and the simulated clock.
    frame: u64,
    elapsed: f32,
    /// Camera yaw, integrated from mouse dx.
    yaw: f32,
    /// Player position. The host owns it once physics reports a body row;
    /// until then dead reckoning from WASD keeps it moving.
    player: [f32; 3],
    /// Per-box orbit phase, randomised in `init` so the three do not stack.
    phase: [f32; BOX_COUNT],
    /// How many rays were cast and how many hit something.
    shots: u32,
    hits: u32,
    /// Guest-minted sound handles.
    next_sound: u32,
    /// How many body rows the host reported last tick, for the HUD.
    live_bodies: u32,
}

impl State {
    /// A state that has not been through `init` yet.
    fn new() -> Self {
        State {
            fixed_hz: 60,
            dev_mode: false,
            rng: 0x9e37_79b9_7f4a_7c15,
            box_asset: None,
            shot_asset: None,
            spawned: false,
            frame: 0,
            elapsed: 0.0,
            yaw: 0.0,
            player: [0.0, 1.0, 0.0],
            phase: [0.0; BOX_COUNT],
            shots: 0,
            hits: 0,
            next_sound: 1,
            live_bodies: 0,
        }
    }

    /// One xorshift64 step. Deterministic, seeded per run, and — unlike
    /// QuickJS's `Math.random` — not frozen into the binary at build time.
    fn next_u32(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        (x >> 32) as u32
    }

    /// A float in `0..1`, from the top 24 bits.
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
}

thread_local! {
    /// wasm is single-threaded and the `Guest` methods are free functions, so
    /// the state has to be global. `thread_local!` + `RefCell` keeps that safe
    /// (no `static mut`, no `unsafe`) and costs nothing measurable.
    static STATE: RefCell<State> = RefCell::new(State::new());
}

/// Borrow the state mutably for the length of one closure.
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|cell| f(&mut cell.borrow_mut()))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Read one bit out of a `key-state` bitset: key `c` is bit `c & 31` of word
/// `c >> 5`, exactly as `packages/sdk/src/keycodes.ts` writes it.
fn key_down(words: &[u32], index: usize) -> bool {
    match words.get(index >> 5) {
        Some(word) => word & (1u32 << (index & 31)) != 0,
        None => false,
    }
}

/// A vec3, shortened because this file writes a lot of them.
fn v3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

/// The identity rotation.
fn qid() -> Quat {
    Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }
}

/// A rotation of `yaw` radians about +Y.
fn q_yaw(yaw: f32) -> Quat {
    Quat { x: 0.0, y: (yaw * 0.5).sin(), z: 0.0, w: (yaw * 0.5).cos() }
}

/// Append little-endian bytes to a snapshot.
fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
}

/// A forward-only reader over the fixed-width snapshot body.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    /// The next `N` bytes, or zeros if the snapshot is short (already checked).
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let out = self.bytes.get(self.at..self.at + N).and_then(|s| s.try_into().ok());
        self.at += N;
        out.unwrap_or([0; N])
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }
}

/// Push one `frame-output.transforms` row. The flags lane is a bitset carried
/// as an integral f32 — bit 0 position, 1 rotation, 2 scale, 3 visible.
fn push_transform(out: &mut Vec<f32>, entity: Entity, flags: TransformFlags, p: [f32; 3], r: Quat) {
    out.push(entity as f32);
    out.push(flags.bits() as f32);
    out.extend_from_slice(&[p[0], p[1], p[2]]);
    out.extend_from_slice(&[r.x, r.y, r.z, r.w]);
    out.extend_from_slice(&[1.0, 1.0, 1.0]);
}

// ---------------------------------------------------------------------------
// Frame-0 scene construction
// ---------------------------------------------------------------------------

/// Spawn the player capsule and three boxes, each with a body.
///
/// Two commands per object: `spawn` creates the entity the renderer sees,
/// `add-body` creates the rigid body that drives it. Both ids are minted here.
fn spawn_scene(state: &mut State, commands: &mut Vec<Command>) {
    commands.push(Command::Spawn(SpawnCmd {
        entity: PLAYER,
        // No asset: the player is an invisible transform node in first person.
        asset: None,
        position: v3(state.player[0], state.player[1], state.player[2]),
        rotation: qid(),
        scale: v3(1.0, 1.0, 1.0),
        parent: None,
        visible: true,
        name: Some("player".to_string()),
    }));
    commands.push(Command::AddBody(AddBodyCmd {
        body: PLAYER as BodyId,
        entity: PLAYER,
        kind: BodyKind::Character,
        shape: Shape {
            kind: ShapeKind::Capsule,
            // capsule: (radius, half-height, _)
            half_extents: v3(0.3, 0.9, 0.0),
            asset: None,
        },
        position: v3(state.player[0], state.player[1], state.player[2]),
        rotation: qid(),
        mass: 80.0,
        friction: 0.4,
        restitution: 0.0,
        linear_damping: 0.0,
        angular_damping: 0.0,
        layer: CollisionLayers::PLAYER,
        mask: CollisionLayers::STATIC_GEOMETRY | CollisionLayers::ENEMY,
        flags: BodyFlags::LOCK_ROTATION | BodyFlags::NO_SLEEP | BodyFlags::REPORT_CONTACTS,
    }));

    for i in 0..BOX_COUNT {
        let entity = FIRST_BOX + i as Entity;
        let p = box_position(state.phase[i], 0.0);
        commands.push(Command::Spawn(SpawnCmd {
            entity,
            asset: state.box_asset,
            position: v3(p[0], p[1], p[2]),
            rotation: qid(),
            scale: v3(1.0, 1.0, 1.0),
            parent: None,
            visible: true,
            name: None,
        }));
        commands.push(Command::AddBody(AddBodyCmd {
            body: entity as BodyId,
            entity,
            // Kinematic: the guest integrates the orbit and the host follows.
            kind: BodyKind::Kinematic,
            shape: Shape { kind: ShapeKind::Box, half_extents: v3(0.5, 0.5, 0.5), asset: None },
            position: v3(p[0], p[1], p[2]),
            rotation: qid(),
            mass: 0.0,
            friction: 0.5,
            restitution: 0.1,
            linear_damping: 0.0,
            angular_damping: 0.0,
            layer: CollisionLayers::ENEMY,
            mask: CollisionLayers::PLAYER | CollisionLayers::PROJECTILE,
            flags: BodyFlags::REPORT_CONTACTS,
        }));
    }
}

/// Where a box sits at `phase + elapsed * ORBIT_SPEED` radians round the ring.
fn box_position(phase: f32, elapsed: f32) -> [f32; 3] {
    let a = phase + elapsed * ORBIT_SPEED;
    [
        ORBIT_CENTER[0] + a.cos() * ORBIT_RADIUS,
        ORBIT_CENTER[1] + (a * 2.0).sin() * 0.25,
        ORBIT_CENTER[2] + a.sin() * ORBIT_RADIUS,
    ]
}

// ---------------------------------------------------------------------------
// The exported world
// ---------------------------------------------------------------------------

/// The unit struct `export!` hangs the exports off.
struct Component;

impl Guest for Component {
    /// Called once, before the first tick.
    fn init(config: GameConfig) -> Result<(), GameError> {
        if config.fixed_hz == 0 {
            // `result<_, game-error>` lowers to a `Result`; the host turns the
            // error record into an `Error` with `.payload`.
            return Err(GameError {
                code: ErrorCode::InitFailed,
                message: "fixed-hz must be non-zero".to_string(),
            });
        }

        with_state(|state| {
            state.fixed_hz = config.fixed_hz;
            state.dev_mode = config.dev_mode;

            // Seed from the host, never from module scope. `config.seed`
            // mirrors `env.seed()`; xor them so either being zero is harmless,
            // and force the low bit so xorshift never sits on 0.
            state.rng = (config.seed ^ env::seed()) | 1;

            // Init-time only: resolve every name now and cache the handles.
            state.box_asset = assets::resolve_id("rust-crate");
            state.shot_asset = assets::resolve_id("rust-shot");

            // Randomise the orbit phases so the boxes do not stack.
            for i in 0..BOX_COUNT {
                state.phase[i] = state.next_f32() * std::f32::consts::TAU;
            }

            if state.dev_mode {
                env::log(
                    LogLevel::Info,
                    &format!(
                        "rust guest ready: {} Hz, {} boxes, seed {:#x}",
                        state.fixed_hz, BOX_COUNT, config.seed
                    ),
                );
            }
        });
        Ok(())
    }

    /// One fixed simulation step.
    fn tick(input: FrameInput) -> FrameOutput {
        with_state(|state| {
            state.frame = input.frame;
            state.elapsed = input.elapsed;

            // Pre-size both output lists: four transform rows, and at most the
            // frame-0 burst of commands.
            let mut transforms: Vec<f32> = Vec::with_capacity((BOX_COUNT + 1) * TRANSFORM_STRIDE);
            let mut commands: Vec<Command> = Vec::with_capacity(if state.spawned { 2 } else { 9 });

            // --- 1. structural work, once ---------------------------------
            if !state.spawned {
                state.spawned = true;
                spawn_scene(state, &mut commands);
            }

            // --- 2. ingest the host's physics output ----------------------
            // Stride 15, sorted ascending by body id. Read it as a flat slice;
            // never assume it is a typed array, and never hold on to it.
            state.live_bodies = (input.bodies.len() / BODY_STRIDE) as u32;
            for row in input.bodies.chunks_exact(BODY_STRIDE) {
                if row[0] as BodyId == PLAYER as BodyId {
                    // The character controller is authoritative for the player.
                    state.player = [row[1], row[2], row[3]];
                }
            }

            // --- 3. input -------------------------------------------------
            let mouse = input.input.mouse;
            if input.input.focused {
                state.yaw -= mouse.dx * MOUSE_SENSITIVITY;
            }
            let keys = &input.input.keys.down;
            let strafe = (key_down(keys, KEY_D) as i32 - key_down(keys, KEY_A) as i32) as f32;
            let ahead = (key_down(keys, KEY_W) as i32 - key_down(keys, KEY_S) as i32) as f32;
            let (sin, cos) = (state.yaw.sin(), state.yaw.cos());
            // Forward is -Z, so yaw rotates (x, z) into world space like this.
            let vx = (strafe * cos - ahead * sin) * WALK_SPEED;
            let vz = (-strafe * sin - ahead * cos) * WALK_SPEED;

            // Dead reckoning, so the example moves even against a host with no
            // physics behind it. A real game would trust the body row only.
            state.player[0] += vx * input.dt;
            state.player[2] += vz * input.dt;

            // Ask the host's character controller for the same motion. This is
            // a deferred command, not a call: it lands after the guest returns.
            commands.push(Command::MoveCharacter(MoveCharacterCmd {
                body: PLAYER as BodyId,
                desired_velocity: v3(vx, 0.0, vz),
                jump: false,
                crouch: false,
                max_slope_deg: 50.0,
            }));

            // --- 4. the one synchronous host call -------------------------
            // Left mouse button held: hitscan down the camera forward vector.
            if mouse.buttons & 1 != 0 {
                state.shots += 1;
                let eye = v3(state.player[0], state.player[1] + 1.7, state.player[2]);
                let forward = v3(-sin, 0.0, -cos);
                let filter = QueryFilter {
                    layers: CollisionLayers::ENEMY | CollisionLayers::STATIC_GEOMETRY,
                    exclude_body: Some(PLAYER as BodyId),
                    exclude_entity: None,
                    solid_only: true,
                };
                if let Some(hit) = physics_query::raycast(eye, forward, RANGE, filter) {
                    state.hits += 1;
                    if state.dev_mode {
                        env::log(
                            LogLevel::Debug,
                            &format!("hit entity {} at {:.2} m", hit.entity, hit.distance),
                        );
                    }
                }
                if let Some(asset) = state.shot_asset {
                    commands.push(Command::PlaySound(PlaySoundCmd {
                        sound: state.next_sound,
                        asset,
                        entity: Some(PLAYER),
                        position: None,
                        volume: 0.8,
                        pitch: 1.0,
                        looping: false,
                        bus: AudioBus::Sfx,
                    }));
                    state.next_sound += 1;
                }
            }

            // --- 5. pack the transforms -----------------------------------
            push_transform(
                &mut transforms,
                PLAYER,
                TransformFlags::POSITION | TransformFlags::VISIBLE,
                state.player,
                q_yaw(state.yaw),
            );
            for i in 0..BOX_COUNT {
                let p = box_position(state.phase[i], state.elapsed);
                push_transform(
                    &mut transforms,
                    FIRST_BOX + i as Entity,
                    TransformFlags::POSITION | TransformFlags::ROTATION,
                    p,
                    q_yaw(state.phase[i] + state.elapsed * ORBIT_SPEED),
                );
            }

            // --- 6. camera and HUD ----------------------------------------
            let camera = CameraState {
                mode: CameraMode::ThirdPerson,
                projection: ProjectionKind::Perspective,
                position: v3(state.player[0], state.player[1] + 1.7, state.player[2]),
                rotation: q_yaw(state.yaw),
                target: None,
                fov_y_deg: 75.0,
                near: 0.1,
                far: 1000.0,
                follow: Some(PLAYER),
                arm_length: 4.0,
                offset: v3(0.0, 1.6, 0.0),
            };

            // `option<string>`: `None` means "unchanged, keep the last HUD", so
            // only pay for the JSON on the frames that actually change it.
            let hud = if input.frame % 30 == 0 {
                Some(format!(
                    "{{\"frame\":{},\"shots\":{},\"hits\":{},\"bodies\":{},\"x\":{:.3},\"z\":{:.3}}}",
                    state.frame, state.shots, state.hits, state.live_bodies,
                    state.player[0], state.player[2]
                ))
            } else {
                None
            };

            FrameOutput { transforms, commands, local_commands: Vec::new(), camera, hud }
        })
    }

    /// No host resources are held, so there is nothing to release.
    fn shutdown() {
        with_state(|state| {
            if state.dev_mode {
                env::log(LogLevel::Info, "rust guest shutting down");
            }
        });
    }

    /// Serialise the whole state: magic, version, then little-endian fields.
    ///
    /// Hand-rolled on purpose. serde would work, but a snapshot is written and
    /// read by exactly one build of exactly one module, so a format anybody can
    /// read in a debugger beats a dependency.
    fn snapshot() -> Vec<u8> {
        with_state(|state| {
            let mut out = Vec::with_capacity(SNAPSHOT_BYTES);
            out.extend_from_slice(&SNAPSHOT_MAGIC);
            // Four header bytes: version, then two booleans and the box count,
            // so `restore` can reject a snapshot from a different build.
            out.extend_from_slice(&[
                SNAPSHOT_VERSION,
                state.spawned as u8,
                state.dev_mode as u8,
                BOX_COUNT as u8,
            ]);
            put(&mut out, &state.frame.to_le_bytes());
            put(&mut out, &state.rng.to_le_bytes());
            for word in [state.fixed_hz, state.shots, state.hits, state.next_sound] {
                put(&mut out, &word.to_le_bytes());
            }
            put(&mut out, &state.live_bodies.to_le_bytes());
            for value in [state.elapsed, state.yaw] {
                put(&mut out, &value.to_le_bytes());
            }
            for value in state.player.iter().chain(state.phase.iter()) {
                put(&mut out, &value.to_le_bytes());
            }
            debug_assert_eq!(out.len(), SNAPSHOT_BYTES);
            out
        })
    }

    /// Read one back. Anything unexpected is a `snapshot-version-mismatch`
    /// rather than a trap: a trap would poison the component instance.
    fn restore(bytes: Vec<u8>) -> Result<(), GameError> {
        /// Fail with the same error code and a message naming the problem.
        fn bad(what: &str) -> GameError {
            GameError {
                code: ErrorCode::SnapshotVersionMismatch,
                message: format!("bad snapshot: {what}"),
            }
        }

        if bytes.len() < 8 || bytes[0..4] != SNAPSHOT_MAGIC {
            return Err(bad("wrong magic"));
        }
        if bytes[4] != SNAPSHOT_VERSION {
            return Err(bad("wrong version"));
        }
        if bytes[7] as usize != BOX_COUNT {
            return Err(bad("box count changed"));
        }
        if bytes.len() != SNAPSHOT_BYTES {
            return Err(bad("wrong length"));
        }

        // Every field is fixed width, so reading is a straight walk. Keeping a
        // cursor rather than hand-written offsets is what keeps `restore` in
        // step with `snapshot` when a field is added.
        let mut r = Reader { bytes: &bytes, at: 8 };
        with_state(|state| {
            state.spawned = bytes[5] != 0;
            state.dev_mode = bytes[6] != 0;
            state.frame = r.u64();
            state.rng = r.u64();
            state.fixed_hz = r.u32();
            state.shots = r.u32();
            state.hits = r.u32();
            state.next_sound = r.u32();
            state.live_bodies = r.u32();
            state.elapsed = r.f32();
            state.yaw = r.f32();
            for axis in &mut state.player {
                *axis = r.f32();
            }
            for phase in &mut state.phase {
                *phase = r.f32();
            }
        });
        Ok(())
    }
}

// Wire `Component` to the component-model exports. Without this the linker
// reports "failed to find export of interface gameable:engine/game@0.2.0".
export!(Component);
