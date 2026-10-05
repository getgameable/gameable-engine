/**
 * One step of camera-relative locomotion for one body, from one input and
 * one camera. `createThirdPersonController` runs it for the single player
 * (`ctx.player`, `ctx.input`, `ctx.camera`) or for each player of a room
 * (their entity, input and camera). Allocates nothing.
 */
import { Health, Transform, Velocity } from './ecs';
import { TRANSFORM_FLAGS, markMoved } from './packing';
import { character } from './character';
import type { camera } from './camera';
import type { GameContext } from './defineGame';
import type { input } from './input';

export const IDLE = 'idle';
export const WALK = 'walk';
export const RUN = 'run';
export const JUMP = 'jump';
export const FALL = 'fall';
const STILL_SPEED = 0.05;
const TAU = Math.PI * 2;

/** One driven body's continuous state. */
export type LocomotionState = ReturnType<typeof makeLocomotionState>;

/** What one drive reads and writes besides the body's own state. */
export interface Rig {
  /** Base-layer clip ids, or empty for the animator's own blend. */
  readonly clips: readonly string[];
  /** Scratch weights, one per clip. */
  readonly weights: Float32Array;
  /** Scratch follow options. */
  readonly follow: { yaw: number; pitch: number; distance: number; height: number };
}

/** @returns A fresh state, as `reset` leaves it before the camera is read. */
export function makeLocomotionState() {
  return {
    state: IDLE,
    speed: 0,
    grounded: false,
    airborne: 0,
    yaw: 0,
    facing: Math.PI,
    pitch: 0,
    vx: 0,
    vz: 0,
    turning: false,
    descending: false,
    landing: 0,
  };
}

/**
 * Put a state and its camera's look back to the start.
 *
 * @param state The state.
 * @param view The camera whose look it owns.
 * @param rules `ctx.rules`, for `cameraPitch`.
 */
export function resetLocomotionState(
  state: LocomotionState,
  view: typeof camera,
  rules: GameContext['rules'],
): void {
  state.state = IDLE;
  state.speed = 0;
  state.grounded = false;
  state.airborne = 0;
  state.yaw = view.look.yaw = 0;
  // The model is +Z-forward. At camera yaw zero, travel forward is -Z.
  state.facing = Math.PI;
  state.pitch = view.look.pitch = Number(rules.cameraPitch ?? -0.25);
  state.vx = state.vz = 0;
  state.turning = false;
  state.descending = false;
  state.landing = 0;
}

/**
 * @param angle Radians.
 * @returns The same angle in `[-PI, PI)`.
 */
function wrap(angle: number): number {
  return ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/**
 * @param from Radians.
 * @param to Radians.
 * @param step Largest turn, radians.
 * @returns `from` turned towards `to` by at most `step`.
 */
function approachAngle(from: number, to: number, step: number): number {
  const delta = wrap(to - from);
  return wrap(from + Math.max(-step, Math.min(step, delta)));
}

/**
 * Drive one body one step.
 *
 * @param ctx The frame context (rules, dt, physics).
 * @param hero The body's entity; 0 drives nothing.
 * @param keys The input that steers it.
 * @param view The camera that follows it, and whose look sets "forward".
 * @param state The body's own state.
 * @param rig Clips and scratch.
 * @param freeze True to hold the body still (a conversation, a cutscene).
 */
export function driveThirdPerson(
  ctx: GameContext,
  hero: number,
  keys: typeof input,
  view: typeof camera,
  state: LocomotionState,
  rig: Rig,
  freeze: boolean,
): void {
  if (hero === 0) return;
  const look = view.look;
  const follow = rig.follow;
  look.yaw = wrap(look.yaw);
  look.pitch = Math.max(
    Number(ctx.rules.cameraMinPitch ?? -1.05),
    Math.min(Number(ctx.rules.cameraMaxPitch ?? 0.35), look.pitch),
  );
  state.yaw = follow.yaw = look.yaw;
  state.pitch = follow.pitch = look.pitch;
  follow.distance = Number(ctx.rules.cameraDistance ?? 4.5);
  follow.height = Number(ctx.rules.cameraHeight ?? 0.55);
  view.follow(hero, follow);

  const frozen = freeze || (Health.current[hero] ?? 0) <= 0;
  const move = keys.axis2('A', 'D', 'S', 'W');
  const mx = frozen ? 0 : move.x;
  const my = frozen ? 0 : move.y;
  const moving = Math.abs(mx) + Math.abs(my) > 0;
  const walkSpeed = Number(ctx.rules.walkSpeed ?? 3.2);
  const runSpeed = Number(ctx.rules.runSpeed ?? 6);
  const running = !frozen && keys.isDown('Shift');
  const speed = running ? runSpeed : walkSpeed;
  const length = Math.hypot(mx, my) || 1;
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  // Camera is on +Z at yaw zero. W travels away from it; D travels right.
  const targetX = ((mx * cos - my * sin) / length) * speed;
  const targetZ = ((-mx * sin - my * cos) / length) * speed;
  const dx = targetX - state.vx;
  const dz = targetZ - state.vz;
  const change = Math.hypot(dx, dz);
  const acceleration = Number(
    moving ? (ctx.rules.acceleration ?? 10) : (ctx.rules.deceleration ?? 14),
  );
  const blend = change > 0 ? Math.min(1, (acceleration * ctx.dt) / change) : 1;
  state.vx = frozen ? 0 : state.vx + dx * blend;
  state.vz = frozen ? 0 : state.vz + dz * blend;
  if (!moving && Math.hypot(state.vx, state.vz) < STILL_SPEED) state.vx = state.vz = 0;

  const vy = Velocity.y[hero] ?? 0;
  const wasGrounded = state.grounded;
  if (state.airborne > 0) state.airborne--;
  state.grounded = state.airborne === 0 && ctx.physics.isGrounded(hero);
  if (state.grounded) state.descending = false;
  else if (vy < 0) state.descending = true;
  if (!wasGrounded && state.grounded) state.landing = Number(ctx.rules.landingSeconds ?? 0.18);
  else state.landing = Math.max(0, state.landing - ctx.dt);

  const wantsJump = !frozen && keys.pressed('Space') && state.grounded;
  if (wantsJump) {
    state.airborne = Number(ctx.rules.jumpLockFrames ?? 3);
    state.grounded = false;
    state.descending = false;
    state.landing = 0;
  }
  ctx.physics.moveCharacter(
    hero,
    state.vx,
    wantsJump ? Number(ctx.rules.jumpSpeed ?? 6) : 0,
    state.vz,
    wantsJump,
  );

  state.speed = Math.hypot(state.vx, state.vz);
  state.state = state.grounded
    ? state.speed < STILL_SPEED
      ? IDLE
      : state.speed > walkSpeed + 0.25
        ? RUN
        : WALK
    : state.descending
      ? FALL
      : JUMP;

  turn(ctx, state, frozen);
  present(hero, state, vy, walkSpeed, runSpeed, rig);
}

/**
 * Turn the body: towards travel while moving; towards the camera's forward
 * once the camera has swung past the threshold while standing.
 *
 * @param ctx The frame context.
 * @param state The body's state.
 * @param frozen True while held still.
 */
function turn(ctx: GameContext, state: LocomotionState, frozen: boolean): void {
  if (state.speed > STILL_SPEED) {
    state.turning = false;
    state.facing = approachAngle(
      state.facing,
      Math.atan2(state.vx, state.vz),
      Number(ctx.rules.moveTurnRate ?? 10) * ctx.dt,
    );
  } else if (!frozen && state.grounded) {
    const forward = wrap(state.yaw + Math.PI);
    const difference = Math.abs(wrap(forward - state.facing));
    // Latch once past 90 degrees, then finish the turn instead of chattering at
    // the threshold. Small stationary camera orbits leave the body alone.
    if (difference > Number(ctx.rules.idleTurnThreshold ?? Math.PI / 2)) state.turning = true;
    if (state.turning) {
      state.facing = approachAngle(
        state.facing,
        forward,
        Number(ctx.rules.idleTurnRate ?? 4.5) * ctx.dt,
      );
      if (Math.abs(wrap(forward - state.facing)) < 0.01) {
        state.facing = forward;
        state.turning = false;
      }
    }
  } else {
    state.turning = false;
  }
}

/**
 * Publish the facing and tell the animator what the body is doing.
 *
 * @param hero The entity.
 * @param state Its state.
 * @param vy Its vertical speed.
 * @param walkSpeed The walk speed rule.
 * @param runSpeed The run speed rule.
 * @param rig Clips and scratch.
 */
function present(
  hero: number,
  state: LocomotionState,
  vy: number,
  walkSpeed: number,
  runSpeed: number,
  rig: Rig,
): void {
  const half = state.facing * 0.5;
  Transform.qx[hero] = Transform.qz[hero] = 0;
  Transform.qy[hero] = Math.sin(half);
  Transform.qw[hero] = Math.cos(half);
  // Physics owns the capsule transform and does not dirty guest output rows.
  // Publish our visual facing explicitly, including when standing still.
  markMoved(hero, TRANSFORM_FLAGS.ROTATION);
  character.setState(hero, state.state, state.vx, vy, state.vz, state.grounded);
  if (rig.clips.length === 0) return;
  // One explicit base layer blends the generated gait and collision-driven jump phases.
  const w = rig.weights;
  w.fill(0);
  if (!state.grounded) w[state.descending ? 4 : 3] = 1;
  else if (state.landing > 0) w[5] = 1;
  else if (state.speed <= walkSpeed) {
    w[1] = Math.min(1, state.speed / walkSpeed);
    w[0] = 1 - w[1];
  } else {
    w[2] = Math.min(1, (state.speed - walkSpeed) / (runSpeed - walkSpeed));
    w[1] = 1 - w[2];
  }
  character.setClipWeights(hero, rig.clips, w);
}
