/**
 * A scripted `HostApi`: everything a guest can import, with no engine behind
 * it.
 *
 * The mock is not a physics engine. Queries return whatever the options say,
 * assets resolve out of a table, and every log line is recorded so a test can
 * assert on it.
 */
import type {
  AssetDesc,
  AssetId,
  AssetKind,
  HostApi,
  LogLevel,
  OverlapHit,
  QueryFilter,
  RayHit,
  RayQuery,
  Vec3,
} from '@gameable/sdk';

/** One recorded `env.log` call. */
export interface LogLine {
  level: LogLevel;
  msg: string;
}

/** A manifest entry the mock host will resolve. */
export interface MockAsset {
  /** Manifest string id. */
  name: string;
  /** Asset family. Default `'data'`. */
  kind?: AssetKind;
  /** Tags, verbatim. */
  tags?: readonly string[];
  /** Whether the bytes are resident. Default true. */
  ready?: boolean;
  /** Whether a collider asset is attached. Default false. */
  hasCollider?: boolean;
  /** Rig backend for character assets. */
  rig?: string;
}

/** How to build a mock host. */
export interface MockHostOptions {
  /** The value `env.seed()` returns. Default `0x5eed1234`. */
  seed?: number;
  /** Milliseconds `env.nowMs()` returns; defaults to a 0.1 ms counter. */
  nowMs?: () => number;
  /** Scripted raycast. Return `null` for a miss. Default: always a miss. */
  raycast?: (
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
  ) => RayHit | null;
  /** Scripted sphere overlap. Default: no hits. */
  overlapSphere?: (
    center: Vec3,
    radius: number,
    filter: QueryFilter,
    maxResults: number,
  ) => readonly OverlapHit[];
  /**
   * Manifest entries: the assets this game is allowed to name.
   *
   * With the default {@link MockHostOptions.strictAssets} this is the whole
   * manifest, and a name that is not here resolves to nothing, exactly as a
   * missing entry in `assets.json` would.
   */
  assets?: readonly (string | MockAsset)[];
  /**
   * Refuse to resolve names that are not in `assets`. Default **true**.
   *
   * Minting a synthetic handle for any name a game asks for hides the most
   * common asset bug there is — a typo, or an id that was never added to
   * `assets.json` — behind a test that passes. Set it to `false` for a test
   * that genuinely does not care which assets exist.
   */
  strictAssets?: boolean;
}

/** A mock host, plus the recordings a test asserts on. */
export interface MockHost extends HostApi {
  /** Every `env.log` call, in order. */
  readonly log_: LogLine[];
  /** Lines at `'warn'` or `'error'`. */
  warnings(): LogLine[];
  /** How many `raycast` calls the guest made. */
  readonly rayCalls: { raycast: number; batch: number; overlap: number };
  /** Forget every recording. */
  reset(): void;
  /** The handle a name resolves to, minting one when needed. */
  handleOf(name: string): AssetId;
}

/**
 * Create a scripted host.
 *
 * @param options Seed, scripted queries and the manifest.
 * @returns A `HostApi` with recordings attached.
 *
 * @example
 * ```ts
 * import { createMockHost } from 'gameable/test';
 *
 * const host = createMockHost({
 *   seed: 42,
 *   assets: ['env.arena'],
 *   raycast: (origin) => ({
 *     body: 1,
 *     entity: 1,
 *     point: origin,
 *     normal: { x: 0, y: 1, z: 0 },
 *     distance: 2,
 *   }),
 * });
 * ```
 */
export function createMockHost(options: MockHostOptions = {}): MockHost {
  const lines: LogLine[] = [];
  const calls = { raycast: 0, batch: 0, overlap: 0 };
  const byName = new Map<string, AssetDesc>();
  const byId = new Map<number, AssetDesc>();
  let nextId = 1;
  let clock = 0;

  /**
   * Register one manifest entry.
   *
   * @param entry A name or a full description.
   * @returns The handle.
   */
  function register(entry: string | MockAsset): AssetId {
    const spec: MockAsset = typeof entry === 'string' ? { name: entry } : entry;
    const existing = byName.get(spec.name);
    if (existing) return existing.id;
    const desc: AssetDesc = {
      id: nextId,
      name: spec.name,
      kind: spec.kind ?? 'data',
      tags: spec.tags ?? [],
      ready: spec.ready ?? true,
      hasCollider: spec.hasCollider ?? false,
      rig: spec.rig,
    };
    nextId += 1;
    byName.set(desc.name, desc);
    byId.set(desc.id, desc);
    return desc.id;
  }

  for (const entry of options.assets ?? []) register(entry);

  const host: MockHost = {
    log_: lines,
    rayCalls: calls,

    log(level: LogLevel, msg: string): void {
      lines.push({ level, msg });
    },
    seed(): number {
      return options.seed ?? 0x5eed1234;
    },
    nowMs(): number {
      if (options.nowMs) return options.nowMs();
      clock += 0.1;
      return clock;
    },
    raycast(origin, direction, maxDistance, filter): RayHit | null {
      calls.raycast += 1;
      return options.raycast?.(origin, direction, maxDistance, filter) ?? null;
    },
    raycastBatch(rays: readonly RayQuery[]): readonly (RayHit | null)[] {
      calls.batch += rays.length;
      const out: (RayHit | null)[] = [];
      for (const ray of rays) {
        out.push(options.raycast?.(ray.origin, ray.direction, ray.maxDistance, ray.filter) ?? null);
      }
      return out;
    },
    overlapSphere(center, radius, filter, maxResults): readonly OverlapHit[] {
      calls.overlap += 1;
      return options.overlapSphere?.(center, radius, filter, maxResults) ?? [];
    },
    resolveId(name: string): AssetId | undefined {
      const known = byName.get(name);
      if (known) return known.id;
      if (options.strictAssets ?? true) return undefined;
      return register(name);
    },
    describe(id: AssetId): AssetDesc | undefined {
      return byId.get(id);
    },

    warnings(): LogLine[] {
      return lines.filter((l) => l.level === 'warn' || l.level === 'error');
    },
    reset(): void {
      lines.length = 0;
      calls.raycast = 0;
      calls.batch = 0;
      calls.overlap = 0;
      clock = 0;
    },
    handleOf(name: string): AssetId {
      return register(name);
    },
  };

  return host;
}
