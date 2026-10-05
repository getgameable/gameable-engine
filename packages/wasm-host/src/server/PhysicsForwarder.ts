/**
 * `PhysicsForwarder` — the guest's body commands, handed to the Jolt world.
 *
 * The argument mapping is the page's (`createEngineAdapter`'s physics
 * section), through the same `adapter/bodyShapes` helpers, so a body built on
 * the server is the body the page would have built. What the page adds on top
 * (placeholder meshes, interpolation snaps) has no meaning here and is left
 * out. The forwards reuse scratch arrays and allocate nothing.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, BodyId, Quat, Vec3 } from '@gameable/sdk';

import {
  addBodySkip,
  isGuestShape,
  jumpSpeed,
  shapeKind,
  toJoltBody,
  warnDroppedMoveFields,
} from '../adapter/bodyShapes';
import type { WarnOnce } from './WarnOnce';
import type { WorldRecord } from './WorldRecord';

/**
 * Forwards body commands to a physics world and keeps the body table current.
 *
 * @example
 * ```ts
 * // Internal to the server adapter, which builds one per world:
 * const bodies = new PhysicsForwarder(physics, new WorldRecord(), new WarnOnce(console.warn));
 * bodies.removeBody(11);
 * ```
 */
export class PhysicsForwarder {
  private readonly physics: PhysicsService;
  private readonly world: WorldRecord;
  private readonly warnings: WarnOnce;
  private readonly scratch3a: [number, number, number] = [0, 0, 0];
  private readonly scratch3b: [number, number, number] = [0, 0, 0];
  private readonly scratch4: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * `warnings.warn`, bound once so the per-tick path passes no new closure.
   *
   * @param key Deduplication key.
   * @param build Deferred message.
   */
  private readonly warn = (key: string, build?: () => string): void => {
    this.warnings.warn(key, build);
  };

  /**
   * @param physics The Jolt world.
   * @param world The record whose body table this keeps.
   * @param warnings The one-time warning sink.
   */
  constructor(physics: PhysicsService, world: WorldRecord, warnings: WarnOnce) {
    this.physics = physics;
    this.world = world;
    this.warnings = warnings;
  }

  /** @param args The guest's `add-body`. */
  addBody(args: AddBodyCmd): void {
    if (!this.world.attachBody(args.body, args.entity)) return; // past maxBodies: dropped, warned
    const kind = shapeKind(args.shape.kind);
    if (!isGuestShape(kind)) {
      const skip = addBodySkip(args.shape.kind, kind);
      this.warnings.warn(skip.key, skip.message);
      return;
    }
    try {
      this.physics.addBody(toJoltBody(args, kind));
    } catch (cause) {
      this.warnings.warn(
        `add-body:${String(args.body)}`,
        () => `gameable: add-body ${String(args.body)} failed: ${String(cause)}`,
      );
    }
  }

  /** @param body The body to destroy. */
  removeBody(body: BodyId): void {
    this.world.detachBody(body);
    this.physics.removeBody(body);
  }

  /**
   * @param body Body id.
   * @param position World position.
   * @param rotation World rotation.
   * @param teleport Move without sweeping; also marks the entity the body
   *   drives as teleported, so clients snap to it.
   */
  setBodyTransform(body: BodyId, position: Vec3, rotation: Quat, teleport: boolean): void {
    const p = this.scratch3a;
    const q = this.scratch4;
    p[0] = position.x;
    p[1] = position.y;
    p[2] = position.z;
    q[0] = rotation.x;
    q[1] = rotation.y;
    q[2] = rotation.z;
    q[3] = rotation.w;
    this.physics.setTransform(body, p, q, teleport);
    if (teleport) this.world.teleport(this.world.entityOfBody(body));
  }

  /**
   * @param body Body id.
   * @param linear Linear velocity; `undefined` sends zero, as the page does.
   * @param angular Angular velocity; likewise.
   */
  setBodyVelocity(body: BodyId, linear: Vec3 | undefined, angular: Vec3 | undefined): void {
    const l = this.scratch3a;
    const a = this.scratch3b;
    l[0] = linear?.x ?? 0;
    l[1] = linear?.y ?? 0;
    l[2] = linear?.z ?? 0;
    a[0] = angular?.x ?? 0;
    a[1] = angular?.y ?? 0;
    a[2] = angular?.z ?? 0;
    this.physics.setVelocity(body, l, a);
  }

  /**
   * @param body Body id.
   * @param impulse Impulse in newton-seconds.
   * @param atPoint World point, or `undefined` for the centre of mass.
   */
  applyImpulse(body: BodyId, impulse: Vec3, atPoint: Vec3 | undefined): void {
    const i = this.scratch3a;
    i[0] = impulse.x;
    i[1] = impulse.y;
    i[2] = impulse.z;
    if (atPoint === undefined) {
      this.physics.applyImpulse(body, i);
      return;
    }
    const p = this.scratch3b;
    p[0] = atPoint.x;
    p[1] = atPoint.y;
    p[2] = atPoint.z;
    this.physics.applyImpulse(body, i, p);
  }

  /**
   * @param body Body id.
   * @param enabled In the broad phase or not.
   */
  setBodyEnabled(body: BodyId, enabled: boolean): void {
    this.physics.setEnabled(body, enabled);
  }

  /**
   * @param body Character body id.
   * @param desiredVelocity World-space velocity.
   * @param jump Jump this step when grounded.
   * @param crouch Crouch request; the physics module cannot honour it yet.
   * @param maxSlopeDeg Slope limit; only the module's default is honoured.
   */
  moveCharacter(
    body: BodyId,
    desiredVelocity: Vec3,
    jump: boolean,
    crouch: boolean,
    maxSlopeDeg: number,
  ): void {
    const v = this.scratch3a;
    v[0] = desiredVelocity.x;
    v[1] = jumpSpeed(desiredVelocity.y, jump, this.physics, body);
    v[2] = desiredVelocity.z;
    this.physics.moveCharacter(body, v);
    warnDroppedMoveFields(crouch, maxSlopeDeg, this.warn);
  }
}
