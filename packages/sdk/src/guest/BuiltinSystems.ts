/**
 * The runtime's built-in systems: the look accumulator, velocity integration
 * for body-less entities, and the camera rig `player.camera` declares.
 */
import { camera } from '../camera';
import { Not, RigidBody, Transform, Velocity, commitRemovals, registerQuery } from '../ecs';
import { TRANSFORM_FLAGS } from '../packing';
import type { GameDefinition } from '../defineGame';
import type { Query } from '../ecs';
import type { RuntimeState } from '../state';

/**
 * Terms of the built-in velocity query, built once.
 *
 * `Not(RigidBody)` is the narrowing that matters: bodies are integrated by the
 * host's physics and ingested through `BodyIndex`, so the guest must not
 * integrate them — and excluding them in the query beats testing every entity
 * in the loop.
 */
const VELOCITY_TERMS = [Velocity, Not(RigidBody)];

/** One guest's built-in systems, and the velocity query they keep. */
export class BuiltinSystems {
  /**
   * The registered velocity query, and the world it belongs to.
   *
   * `resetWorld` wipes a world's query registry in place without changing its
   * identity, so `init` and `restore` drop this explicitly ({@link forgetQuery})
   * rather than relying on the identity check alone.
   */
  private velocityQuery: Query | null = null;
  private velocityWorld: object | null = null;
  private readonly gx: number;
  private readonly gy: number;
  private readonly gz: number;
  private readonly hasGravity: boolean;

  /**
   * @param rt The runtime the systems read and write.
   * @param definition The game: `world.gravity` and `player.camera`.
   */
  constructor(
    private readonly rt: RuntimeState,
    private readonly definition: GameDefinition,
  ) {
    const gravity = definition.world?.gravity;
    this.gx = typeof gravity === 'number' ? 0 : (gravity?.[0] ?? 0);
    this.gy = typeof gravity === 'number' ? gravity : (gravity?.[1] ?? 0);
    this.gz = typeof gravity === 'number' ? 0 : (gravity?.[2] ?? 0);
    this.hasGravity = this.gx !== 0 || this.gy !== 0 || this.gz !== 0;
  }

  /** The world was reset: register the velocity query again on next use. */
  forgetQuery(): void {
    this.velocityQuery = null;
  }

  /** Integrate the look accumulator from mouse movement. */
  look(): void {
    const rt = this.rt;
    rt.players.integrateLooks();
    const mouse = rt.inputLanes.mouse;
    if (!mouse.locked) return;
    const s = rt.look.sensitivity;
    rt.look.yaw -= mouse.dx * s;
    rt.look.pitch -= mouse.dy * s;
    const limit = Math.PI / 2 - 0.001;
    if (rt.look.pitch > limit) rt.look.pitch = limit;
    else if (rt.look.pitch < -limit) rt.look.pitch = -limit;
  }

  /**
   * Integrate `Velocity` into `Transform` for entities the host physics does
   * not own, applying `world.gravity` first.
   *
   * bitecs `query()` hashes and filters its term array on every call, so this
   * registers the query once per world and reads the query's own dense array,
   * whose identity is stable and whose contents bitecs maintains as components
   * are added and removed. `commitRemovals` is the one thing `query()` did for
   * us that we still have to do: it flushes entities that left the query.
   */
  velocity(): void {
    const rt = this.rt;
    let q = this.velocityQuery;
    if (q === null || this.velocityWorld !== rt.world) {
      this.velocityWorld = rt.world;
      q = registerQuery(rt.world, VELOCITY_TERMS);
      this.velocityQuery = q;
    }
    commitRemovals(rt.world);
    const entities = q.dense;
    const dt = rt.dt;
    const packer = rt.packer;
    const { gx, gy, gz, hasGravity } = this;
    const { x: px, y: py, z: pz } = Transform;
    const { x: lx, y: ly, z: lz } = Velocity;
    for (let i = 0; i < entities.length; i += 1) {
      const e = entities[i] ?? 0;
      if (e === 0) continue;
      if (hasGravity) {
        lx[e] = (lx[e] ?? 0) + gx * dt;
        ly[e] = (ly[e] ?? 0) + gy * dt;
        lz[e] = (lz[e] ?? 0) + gz * dt;
      }
      const vx = lx[e] ?? 0;
      const vy = ly[e] ?? 0;
      const vz = lz[e] ?? 0;
      if (vx === 0 && vy === 0 && vz === 0) continue;
      px[e] = (px[e] ?? 0) + vx * dt;
      py[e] = (py[e] ?? 0) + vy * dt;
      pz[e] = (pz[e] ?? 0) + vz * dt;
      packer.mark(e, TRANSFORM_FLAGS.POSITION);
    }
  }

  /** Drive the built-in camera rig declared by `player.camera`. */
  camera(): void {
    const spec = this.definition.player;
    if (!spec?.camera || this.rt.player === 0) return;
    if (spec.camera === 'firstPerson') {
      camera.firstPerson(this.rt.player, { eyeHeight: spec.eyeHeight });
    } else {
      camera.follow(this.rt.player, { distance: spec.distance, height: spec.height });
    }
  }
}
