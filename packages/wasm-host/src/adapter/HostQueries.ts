/**
 * The synchronous half of `HostApi`: physics queries and manifest lookups.
 *
 * Shared by the page's `createEngineHost` and the server's `createServerHost`,
 * so a raycast a guest makes on the authority answers exactly what the same
 * raycast answers in the browser. Neither host owns anything this class does
 * not: they differ only in where the physics world, the body-to-entity map and
 * the asset registry come from.
 *
 * **No allocation on the query path.** Every hit is a pooled record, valid
 * until the next call of the same query; the guest copies what it needs before
 * it returns.
 */
import type { AssetRegistry } from '@gameable/assets';
import type { PhysicsService } from '@gameable/physics-jolt';
import type {
  AssetDesc,
  AssetId,
  HostApi,
  LogLevel,
  OverlapHit,
  QueryFilter,
  RayHit,
  RayQuery,
  Vec3,
} from '@gameable/sdk';

import { layerBits } from './bodyShapes';
import { newRayHit, RayCaster } from './RayCaster';

/** The physics world, or a resolver for one that may not exist yet. */
export type PhysicsSource = PhysicsService | (() => PhysicsService | null);

/** Options accepted by `HostQueries`. */
export interface HostQueriesOptions {
  /** Deterministic run seed. Defaults to `0x5eed1234`. */
  seed?: number;
  /** Where guest `console.log` goes. Defaults to the console, prefixed `[game]`. */
  log?: (level: string, message: string) => void;
  /** Most hits an `overlap-sphere` may return in one call. Defaults to 64. */
  maxOverlaps?: number;
}

/**
 * The default log sink: the console, with the guest's lines marked.
 *
 * @param level Log level.
 * @param message The line.
 */
function consoleLog(level: string, message: string): void {
  const line = `[game] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * The eight `HostApi` members, over a physics world, a body map and a registry.
 *
 * Internal to the package: the page reaches it through `createEngineHost`, a
 * server through `createServerHost` from `gameable/host/server`.
 *
 * @example
 * ```ts
 * import { HostQueries } from './HostQueries';
 *
 * const host = new HostQueries(physics, (body) => adapter.entityOfBody(body), engine.assets, {
 *   seed: 1,
 * });
 * const hit = host.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 10, filter);
 * ```
 */
export class HostQueries implements HostApi {
  private readonly source: PhysicsSource;
  private readonly entityOfBody: (body: number) => number;
  private readonly assets: AssetRegistry;
  private readonly seedValue: number;
  private readonly logSink: (level: string, message: string) => void;
  /** The physics world once resolved; a null answer is asked again next time. */
  private resolvedWorld: PhysicsService | null = null;
  private readonly overlapIds: Uint32Array;
  private readonly bounds = new Float32Array(13);
  /** The single-ray caster, with its one reused hit record. */
  private readonly rays: RayCaster;
  /** Centre handed to the physics module, reused every overlap. */
  private readonly center: [number, number, number] = [0, 0, 0];
  /** Pooled `raycast-batch` results and the array they are returned in. */
  private readonly batchHits: RayHit[] = [];
  private readonly batchOut: (RayHit | null)[] = [];
  /** Pooled `overlap-sphere` results, on the same "until the next call" terms. */
  private readonly overlapPool: OverlapHit[] = [];
  private readonly overlapOut: OverlapHit[] = [];

  /**
   * @param physics The physics world, or a resolver called until it answers.
   * @param entityOfBody The body-to-entity map hits report through.
   * @param assets The registry `resolveId` and `describe` read.
   * @param options Seed, log sink and query capacity.
   */
  constructor(
    physics: PhysicsSource,
    entityOfBody: (body: number) => number,
    assets: AssetRegistry,
    options: HostQueriesOptions = {},
  ) {
    this.source = physics;
    this.entityOfBody = entityOfBody;
    this.rays = new RayCaster(entityOfBody);
    this.assets = assets;
    this.seedValue = options.seed ?? 0x5eed1234;
    this.logSink = options.log ?? consoleLog;
    this.overlapIds = new Uint32Array(options.maxOverlaps ?? 64);
  }

  log(level: LogLevel, message: string): void {
    this.logSink(level, message);
  }

  seed(): number {
    return this.seedValue;
  }

  nowMs(): number {
    return performance.now();
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter): RayHit | null {
    const live = this.physicsWorld();
    return live === null ? null : this.rays.cast(live, origin, direction, maxDistance, filter);
  }

  raycastBatch(rays: readonly RayQuery[]): readonly (RayHit | null)[] {
    // One round trip on the wire; the queries themselves are still one each.
    const out = this.batchOut;
    out.length = 0;
    const live = this.physicsWorld();
    for (let i = 0; i < rays.length; i += 1) {
      const ray = rays[i];
      const found =
        live === null
          ? null
          : this.rays.cast(live, ray.origin, ray.direction, ray.maxDistance, ray.filter);
      if (found === null) {
        out.push(null);
        continue;
      }
      let slot = this.batchHits[i] as RayHit | undefined;
      if (slot === undefined) {
        slot = newRayHit();
        this.batchHits[i] = slot;
      }
      // `cast` returns the one shared record, so each result is copied into
      // its own pooled slot before the next ray overwrites it.
      slot.body = found.body;
      slot.entity = found.entity;
      slot.point.x = found.point.x;
      slot.point.y = found.point.y;
      slot.point.z = found.point.z;
      slot.normal.x = found.normal.x;
      slot.normal.y = found.normal.y;
      slot.normal.z = found.normal.z;
      slot.distance = found.distance;
      out.push(slot);
    }
    return out;
  }

  overlapSphere(
    center: Vec3,
    radius: number,
    filter: QueryFilter,
    maxResults: number,
  ): readonly OverlapHit[] {
    const out = this.overlapOut;
    out.length = 0;
    const live = this.physicsWorld();
    if (live === null) return out;
    const ids = this.overlapIds;
    const bounds = this.bounds;
    this.center[0] = center.x;
    this.center[1] = center.y;
    this.center[2] = center.z;
    const found = live.overlapSphereInto(this.center, radius, layerBits(filter.layers), ids);
    const limit = Math.min(found, maxResults, ids.length);
    for (let i = 0; i < limit; i += 1) {
      const body = ids[i];
      const entity = this.entityOfBody(body);
      if (filter.excludeBody === body) continue;
      if (filter.excludeEntity !== undefined && filter.excludeEntity !== 0) {
        if (filter.excludeEntity === entity) continue;
      }
      // The physics module reports ids, not points; the body's own origin is
      // the useful answer for the gameplay code that asks.
      let px = center.x;
      let py = center.y;
      let pz = center.z;
      if (live.readBodyBounds(body, bounds, 0)) {
        px = bounds[6];
        py = bounds[7];
        pz = bounds[8];
      }
      const depth = Math.max(0, radius - Math.hypot(px - center.x, py - center.y, pz - center.z));
      const index = out.length;
      let slot = this.overlapPool[index] as OverlapHit | undefined;
      if (slot === undefined) {
        slot = { body: 0, entity: 0, point: { x: 0, y: 0, z: 0 }, depth: 0 };
        this.overlapPool[index] = slot;
      }
      slot.body = body;
      slot.entity = entity;
      slot.point.x = px;
      slot.point.y = py;
      slot.point.z = pz;
      slot.depth = depth;
      out.push(slot);
    }
    return out;
  }

  resolveId(name: string): AssetId {
    return this.assets.resolve(name);
  }

  describe(id: AssetId): AssetDesc | undefined {
    const assets = this.assets;
    const name = assets.idOf(id);
    if (name === undefined) return undefined;
    const entry = assets.entry(name);
    if (entry === undefined) return undefined;
    return {
      id,
      name,
      kind: entry.type,
      tags: entry.tags ?? [],
      ready: assets.get(name) !== undefined,
      hasCollider: entry.collider !== undefined,
      rig: entry.rig?.backend,
    };
  }

  /**
   * The physics world, resolved lazily so a page can build its host before boot.
   *
   * @returns The service, or null when physics is not registered.
   */
  private physicsWorld(): PhysicsService | null {
    const source = this.source;
    if (typeof source !== 'function') return source;
    this.resolvedWorld ??= source();
    return this.resolvedWorld;
  }
}
