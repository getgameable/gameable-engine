/**
 * `HostApi` to jco import object.
 *
 * Two details of jco 1.33 are load-bearing and easy to get wrong:
 *
 * 1. **Import-object keys are unversioned.** The guest imports
 *    `'gameable:engine/env@0.2.0'`, but the host supplies `imports['gameable:engine/env']`.
 *    Getting this wrong produces an `undefined is not a function` deep inside
 *    the generated bindings, with no mention of the interface name.
 * 2. **`u64` is a `bigint` on the host.** `env.seed()` must return a `bigint`
 *    even though the guest sees a `number`.
 *
 * There is no `--map`: the import object is passed straight to `instantiate`.
 */
import type {
  AssetDesc,
  HostApi,
  OverlapHit,
  QueryFilter,
  RayHit,
  RayQuery,
  Vec3,
} from '@gameable/sdk';

/** The `gameable:engine` half of a jco import object. */
export interface HostBindings {
  'gameable:engine/env': {
    log: (level: string, msg: string) => void;
    seed: () => bigint;
    nowMs: () => number;
  };
  'gameable:engine/physics-query': {
    raycast: (
      origin: Vec3,
      direction: Vec3,
      maxDistance: number,
      filter: QueryFilter,
    ) => RayHit | undefined;
    raycastBatch: (rays: RayQuery[]) => (RayHit | undefined)[];
    overlapSphere: (
      center: Vec3,
      radius: number,
      filter: QueryFilter,
      maxResults: number,
    ) => OverlapHit[];
  };
  'gameable:engine/assets': {
    resolveId: (name: string) => number | undefined;
    describe: (id: number) => AssetDesc | undefined;
  };
}

/**
 * Adapt a `HostApi` to the import object `instantiate` expects.
 *
 * @param host The host services.
 * @returns The `gameable:engine/*` import object, with unversioned keys.
 *
 * @example
 * ```ts
 * import { hostBindings, minimalWasi } from 'gameable/host';
 *
 * const root = await instantiate(getCoreModule, {
 *   ...minimalWasi(),
 *   ...hostBindings(host),
 * });
 * ```
 */
export function hostBindings(host: HostApi): HostBindings {
  return {
    'gameable:engine/env': {
      log: (level, msg) => {
        host.log(level as Parameters<HostApi['log']>[0], msg);
      },
      // u64: bigint on the host, number in the guest.
      seed: () => BigInt(Math.trunc(host.seed())),
      nowMs: () => host.nowMs(),
    },
    'gameable:engine/physics-query': {
      // `option<ray-hit>` is `undefined` on the host; `HostApi` is allowed to
      // say `null`, so normalise here rather than in every implementation.
      raycast: (origin, direction, maxDistance, filter) =>
        host.raycast(origin, direction, maxDistance, filter) ?? undefined,
      raycastBatch: (rays) => host.raycastBatch(rays).map((hit) => hit ?? undefined),
      overlapSphere: (center, radius, filter, maxResults) => [
        ...host.overlapSphere(center, radius, filter, maxResults),
      ],
    },
    'gameable:engine/assets': {
      resolveId: (name) => host.resolveId(name) ?? undefined,
      describe: (id) => host.describe(id) ?? undefined,
    },
  };
}
