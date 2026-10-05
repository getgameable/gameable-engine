// Ported from aos-threejs-poc/src/lib/movementComponent.js @ cdd63b10
/**
 * movementComponent — navmesh path following, modelled on Unreal's
 * `CharacterMovementComponent` + `PathFollowingComponent` +
 * `AIController::MoveTo*`.
 *
 * three-free on purpose: the movement math is plain trig, so the component
 * unit-tests against a fake group (`{ position, rotation }`).
 *
 * Three POC couplings are gone. The module singleton is a factory, because one
 * scene has more than one NPC. The `window.__NAV_MARKERS__` /
 * `window.__AVATAR_SCENE__` string-target lookup is gone — a target is a point
 * or an object, never a name resolved through a global registry. And `_setWalk`,
 * which reached into `window.__AVATAR_ACTIONS__` to fade a clip called
 * something matching `/walk|locomotion|stride/i`, is gone entirely: the
 * animator drives locomotion from velocity now, so movement just moves.
 */

/** A world-space point. */
export type Vec3 = readonly [number, number, number];

/** The navmesh queries the component needs. */
export interface NavMeshLike {
  /** Ground height the component falls back to when it has no group. */
  floorY: number;
  /**
   * Find a path between two points.
   *
   * @param from Start point.
   * @param to Goal point.
   *
   * @returns Waypoints including the goal, or null when unreachable.
   */
  findPath(from: Vec3, to: Vec3): Vec3[] | null;
  /**
   * Pick a random reachable point.
   *
   * @param center Search centre.
   * @param radius Search radius in metres.
   * @param rng Uniform `[0, 1)` source.
   *
   * @returns A point, or null when nothing is reachable.
   */
  getRandomReachablePoint?(center: Vec3, radius: number, rng?: () => number): Vec3 | null;
}

/** The transform the component drives: XZ position and yaw. */
export interface MovementGroupLike {
  /** World position. Y is owned by the floor, not by this component. */
  position: { x: number; y: number; z: number };
  /** World rotation; only `y` is written. */
  rotation: { y: number };
}

/** Anything `moveToActor` can follow. */
export type MovementTarget =
  | Vec3
  | { position: { x: number; y: number; z: number } }
  | {
      getWorldPosition(target: { x: number; y: number; z: number }): {
        x: number;
        y: number;
        z: number;
      };
    };

/** Movement tuning. */
export interface MovementConfig {
  /** Metres per second; ~1.4 is a human walk. */
  maxSpeed: number;
  /** Metres per second squared. */
  accel: number;
  /** Metres; the move completes inside this radius of the goal. */
  acceptanceRadius: number;
  /** Radians per second. */
  turnRate: number;
  /** Added to the computed yaw, for models whose forward is not +Z. */
  facingOffset: number;
  /** Metres a followed target may drift before `moveToActor` re-paths. */
  replanThreshold: number;
}

/** What a move ended as. */
export type MovementStatus = 'idle' | 'moving' | 'arrived' | 'failed';

/**
 * The payload of an `onMoveCompleted` event.
 *
 * POOLED: one object per component, refilled for each event. Read it inside the
 * sink; do not retain it, and copy the fields you need to keep.
 */
export interface MoveCompletedEvent {
  /** How the move ended. */
  result: 'success' | 'aborted' | 'failed';
  /** Why it failed, when it did; `undefined` on a success or an abort. */
  reason?: string;
}

/**
 * Event sink.
 *
 * @param type Event name; only `onMoveCompleted` is emitted today.
 * @param data Event payload, POOLED — valid until the next event. Copy what you
 *   need to keep.
 */
export type MovementEventSink = (type: string, data: MoveCompletedEvent) => void;

/** Options for {@link createMovementComponent}. */
export interface MovementOptions {
  /** Tuning overrides. */
  config?: Partial<MovementConfig>;
}

/** Two pi, hoisted. */
const TWO_PI = Math.PI * 2;

/**
 * The shortest signed angle from `from` to `to`.
 *
 * @param from Current angle in radians.
 * @param to Target angle in radians.
 *
 * @returns The delta in `(-π, π]`.
 */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * Whether a movement target is a bare point rather than an object.
 *
 * A hand-written guard because `Array.isArray` widens a readonly tuple to
 * `any[]`, which then makes every component read an unchecked `any`.
 *
 * @param target The target.
 *
 * @returns Whether it is a {@link Vec3}.
 */
function isPoint(target: MovementTarget): target is Vec3 {
  return Array.isArray(target);
}

/**
 * Planar distance between two points.
 *
 * @param a First point.
 * @param b Second point.
 *
 * @returns Distance in the XZ plane.
 */
function distXZ(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
}

/** Navmesh path following for one character. */
export class MovementComponent {
  /** Current status. */
  status: MovementStatus = 'idle';

  /** The path being followed. */
  path: Vec3[] = [];

  /** Index of the waypoint currently being steered toward. */
  targetIndex = 0;

  /** Current speed in metres per second. */
  speed = 0;

  /** Tuning. */
  readonly config: MovementConfig = {
    maxSpeed: 1.4,
    accel: 6.0,
    acceptanceRadius: 0.2,
    turnRate: 8.0,
    facingOffset: 0,
    replanThreshold: 0.5,
  };

  /** What kind of goal is being followed. */
  private goalKind: 'location' | 'actor' | 'random' | null = null;

  /** The followed object, for `moveToActor`. */
  private goalRef: MovementTarget | null = null;

  /** The final destination. */
  private goalPoint: [number, number, number] | null = null;

  /** The navmesh. */
  private navmesh: NavMeshLike | null = null;

  /** The transform being driven. */
  private group: MovementGroupLike | null = null;

  /** Where events go. */
  private eventSink: MovementEventSink | null = null;

  /**
   * The one pooled `onMoveCompleted` payload.
   *
   * A move can complete on any tick, so the payload was a per-arrival
   * allocation on the frame path. One object per component, refilled by
   * {@link MovementComponent.fire}.
   */
  private readonly completedEvent: MoveCompletedEvent = { result: 'success' };

  /** Scratch for target resolution; avoids a per-frame allocation. */
  private readonly scratch = { x: 0, y: 0, z: 0 };

  /** Scratch current position. */
  private readonly here: [number, number, number] = [0, 0, 0];

  /** Scratch for target resolution. */
  private readonly step: [number, number, number] = [0, 0, 0];

  /**
   * Scratch for the waypoint walk.
   *
   * Deliberately NOT `step`: a navmesh is free to hand back the very array it
   * was given, so reusing one scratch for both let the walk overwrite the
   * waypoint it was measuring against and "arrive" instantly.
   */
  private readonly probe: [number, number, number] = [0, 0, 0];

  /**
   * Build a component.
   *
   * @param options See {@link MovementOptions}.
   */
  constructor(options: MovementOptions = {}) {
    if (options.config !== undefined) Object.assign(this.config, options.config);
  }

  /**
   * Clear the path and go idle.
   */
  reset(): void {
    this.status = 'idle';
    this.path = [];
    this.targetIndex = 0;
    this.speed = 0;
    this.goalKind = null;
    this.goalRef = null;
    this.goalPoint = null;
  }

  /**
   * Set the navmesh.
   *
   * @param nm The navmesh, or null.
   */
  setNavMesh(nm: NavMeshLike | null): void {
    this.navmesh = nm;
  }

  /**
   * Set the transform to drive.
   *
   * @param g The transform, or null.
   */
  setGroup(g: MovementGroupLike | null): void {
    this.group = g;
  }

  /**
   * Set the event sink.
   *
   * @param fn The sink, or null.
   */
  setEventSink(fn: MovementEventSink | null): void {
    this.eventSink = fn;
  }

  /**
   * Patch the tuning.
   *
   * @param patch Fields to change.
   */
  configure(patch: Partial<MovementConfig>): void {
    Object.assign(this.config, patch);
  }

  /**
   * Unreal's `MoveToLocation`.
   *
   * @param point The destination.
   * @param acceptanceRadius Override for this move, in metres.
   *
   * @returns Whether a path was found.
   */
  moveToLocation(point: Vec3, acceptanceRadius?: number): boolean {
    this.goalKind = 'location';
    this.goalRef = null;
    return this.planTo(point, acceptanceRadius);
  }

  /**
   * Unreal's `MoveToActor`: follows a possibly-moving target.
   *
   * @param target The target.
   * @param acceptanceRadius Override for this move, in metres.
   *
   * @returns Whether a path was found.
   */
  moveToActor(target: MovementTarget, acceptanceRadius?: number): boolean {
    const p = this.resolveTarget(target);
    if (p === null) return this.fail('moveToActor: target not resolvable');
    this.goalKind = 'actor';
    this.goalRef = target;
    return this.planTo(p, acceptanceRadius);
  }

  /**
   * Unreal's `MoveToRandomPoint`.
   *
   * @param center Search centre.
   * @param radius Search radius in metres.
   * @param rng Uniform `[0, 1)` source.
   *
   * @returns Whether a path was found.
   */
  moveToRandomPoint(center: Vec3, radius: number, rng?: () => number): boolean {
    const nav = this.navmesh;
    if (nav?.getRandomReachablePoint === undefined) {
      return this.fail('moveToRandomPoint: navmesh cannot sample points');
    }
    const p = nav.getRandomReachablePoint(center, radius, rng);
    if (p === null) return this.fail('moveToRandomPoint: no reachable point in radius');
    this.goalKind = 'random';
    this.goalRef = null;
    return this.planTo(p, undefined);
  }

  /** Unreal's `StopMovement` — halt and clear the path. */
  abort(): void {
    const wasMoving = this.status === 'moving';
    this.reset();
    if (wasMoving) this.fire('onMoveCompleted', 'aborted');
  }

  /**
   * Advance one frame.
   *
   * @param dt Seconds since the last tick.
   */
  tick(dt: number): void {
    const group = this.group;
    if (this.status !== 'moving' || group === null) return;
    if (dt <= 0) return;

    // moveToActor: follow a possibly-moving target.
    if (this.goalKind === 'actor' && this.goalRef !== null) {
      const p = this.resolveTarget(this.goalRef);
      if (
        p !== null &&
        this.goalPoint !== null &&
        distXZ(p, this.goalPoint) > this.config.replanThreshold
      ) {
        if (!this.planTo(p, undefined)) return;
      }
    }

    const pos = this.currentPos();
    const finalGoal = this.goalPoint;
    // The acceptance radius is measured against the FINAL destination, so the
    // move ends early rather than grinding out the last waypoint.
    if (finalGoal !== null && distXZ(pos, finalGoal) <= this.config.acceptanceRadius) {
      this.arrive();
      return;
    }

    let wp = this.path.at(this.targetIndex);
    if (wp === undefined) {
      this.arrive();
      return;
    }

    this.speed = Math.min(this.config.maxSpeed, this.speed + this.config.accel * dt);
    let remaining = this.speed * dt;

    // Advance through every waypoint overshot this frame.
    let px = pos[0];
    let pz = pos[2];
    while (wp !== undefined) {
      this.probe[0] = px;
      this.probe[2] = pz;
      const d = distXZ(this.probe, wp);
      if (remaining < d) {
        const inv = d > 1e-9 ? remaining / d : 0;
        px += (wp[0] - px) * inv;
        pz += (wp[2] - pz) * inv;
        break;
      }
      px = wp[0];
      pz = wp[2];
      remaining -= d;
      this.targetIndex += 1;
      wp = this.path.at(this.targetIndex);
    }

    // Face the movement direction, rate-limited.
    const dirX = px - pos[0];
    const dirZ = pz - pos[2];
    if (dirX * dirX + dirZ * dirZ > 1e-12) {
      const targetYaw = Math.atan2(dirX, dirZ) + this.config.facingOffset;
      const cur = group.rotation.y;
      const delta = shortestAngle(cur, targetYaw);
      const maxStep = this.config.turnRate * dt;
      group.rotation.y = cur + Math.max(-maxStep, Math.min(maxStep, delta));
    }

    group.position.x = px;
    group.position.z = pz;

    if (wp === undefined) this.arrive();
  }

  /**
   * Plan a path to a point and start moving.
   *
   * @param goalPoint The destination.
   * @param acceptanceRadius Override for this move.
   *
   * @returns Whether a path was found.
   */
  private planTo(goalPoint: Vec3, acceptanceRadius: number | undefined): boolean {
    const nav = this.navmesh;
    if (nav === null) return this.fail('no navmesh loaded');
    const path = nav.findPath(this.currentPos(), goalPoint);
    if (path === null || path.length === 0) return this.fail('no path to goal');
    if (acceptanceRadius !== undefined && Number.isFinite(acceptanceRadius)) {
      this.config.acceptanceRadius = acceptanceRadius;
    }
    // Copy the waypoints: a navmesh may return a cached or aliased array, and
    // the component holds this path across frames.
    this.path = path.map((p) => [p[0], p[1], p[2]] as Vec3);
    this.targetIndex = 0;
    this.goalPoint = [goalPoint[0], goalPoint[1], goalPoint[2]];
    this.status = 'moving';
    return true;
  }

  /**
   * Finish a successful move.
   *
   * Stop WHERE WE ARE — we are already within the acceptance radius. Do NOT
   * teleport to the exact goal: snapping the remaining distance shows a visible
   * jump on the final segment. Unreal's acceptance radius means "arrived when
   * within R", not "teleport to the centre".
   */
  private arrive(): void {
    this.status = 'arrived';
    this.speed = 0;
    this.path = [];
    this.fire('onMoveCompleted', 'success');
  }

  /**
   * Finish a failed move.
   *
   * @param reason Why it failed.
   *
   * @returns Always false, so callers can `return this.fail(...)`.
   */
  private fail(reason: string): boolean {
    this.status = 'failed';
    this.speed = 0;
    this.path = [];
    this.fire('onMoveCompleted', 'failed', reason);
    return false;
  }

  /**
   * The current world position.
   *
   * @returns A reused 3-vector.
   */
  private currentPos(): Vec3 {
    const group = this.group;
    if (group !== null) {
      this.here[0] = group.position.x;
      this.here[1] = group.position.y;
      this.here[2] = group.position.z;
    } else {
      this.here[0] = 0;
      this.here[1] = this.navmesh?.floorY ?? 0;
      this.here[2] = 0;
    }
    return this.here;
  }

  /**
   * Resolve a target to a world point.
   *
   * @param target A point or an object.
   *
   * @returns A reused 3-vector, or null when the target has no position.
   */
  private resolveTarget(target: MovementTarget): Vec3 | null {
    if (isPoint(target)) {
      this.step[0] = target[0];
      this.step[1] = target[1];
      this.step[2] = target[2];
      return this.step;
    }
    if ('getWorldPosition' in target) {
      const v = target.getWorldPosition(this.scratch);
      this.step[0] = v.x;
      this.step[1] = v.y;
      this.step[2] = v.z;
      return this.step;
    }
    if ('position' in target) {
      this.step[0] = target.position.x;
      this.step[1] = target.position.y;
      this.step[2] = target.position.z;
      return this.step;
    }
    return null;
  }

  /**
   * Emit an `onMoveCompleted` event through the pooled payload.
   *
   * @param type Event name.
   * @param result How the move ended.
   * @param reason Why it failed, when it did.
   */
  private fire(type: string, result: MoveCompletedEvent['result'], reason?: string): void {
    const sink = this.eventSink;
    if (sink === null) return;
    const event = this.completedEvent;
    event.result = result;
    event.reason = reason;
    sink(type, event);
  }
}

/**
 * Create a movement component.
 *
 * @param options See {@link MovementOptions}.
 *
 * @returns A fresh {@link MovementComponent}; there is no shared singleton.
 */
export function createMovementComponent(options: MovementOptions = {}): MovementComponent {
  return new MovementComponent(options);
}
