/**
 * The `HostApi` a headless sandbox imports on an authority.
 *
 * The same queries the page's `createEngineHost` answers, from the same
 * {@link HostQueries}: only the sources differ. Physics is the world the
 * server already holds, hit bodies map to entities through the
 * {@link ServerAdapter}'s world record, and ids resolve through the headless
 * engine's asset registry. It imports no three.js.
 */
import type { AssetRegistry } from '@gameable/assets';
import type { PhysicsService } from '@gameable/physics-jolt';

import { HostQueries, type HostQueriesOptions } from '../adapter/HostQueries';
import type { ServerAdapter } from './ServerAdapter';

/** Options accepted by {@link createServerHost}: seed, log sink and query capacity. */
export type ServerHostOptions = HostQueriesOptions;

/** The part of a {@link ServerAdapter} the host reads: its body-to-entity map. */
export interface ServerHostAdapter {
  /** The world record whose body table hits report through. */
  readonly world: Pick<ServerAdapter['world'], 'entityOfBody'>;
}

/**
 * The server's `HostApi`: {@link HostQueries} over a server adapter's world.
 *
 * @example
 * ```ts
 * import { ServerHost, createServerAdapter } from 'gameable/host/server';
 *
 * const adapter = createServerAdapter(engine.get('physics'));
 * const host = new ServerHost(engine.get('physics'), engine.assets, adapter, { seed: 7 });
 * console.log(host.resolveId('arena'));
 * ```
 */
export class ServerHost extends HostQueries {
  /**
   * @param physics The world the authority steps.
   * @param assets The registry `resolveId` and `describe` read.
   * @param adapter The adapter whose world record maps bodies to entities.
   * @param options Seed, log sink and query capacity.
   */
  constructor(
    physics: PhysicsService,
    assets: AssetRegistry,
    adapter: ServerHostAdapter,
    options: ServerHostOptions = {},
  ) {
    const world = adapter.world;
    super(physics, (body) => world.entityOfBody(body), assets, options);
  }
}

/**
 * Build the `HostApi` a headless sandbox imports on an authority.
 *
 * @param physics The world the authority steps (`engine.get('physics')`).
 * @param assets The headless engine's registry (`engine.assets`).
 * @param adapter The server adapter the guest's output is applied to.
 * @param options Seed (default `0x5eed1234`), log sink and query capacity.
 * @returns The host, to hand to `createSandbox`.
 *
 * @example
 * ```ts
 * import { createHeadlessEngine } from 'gameable/core/headless';
 * import { physics } from 'gameable/physics';
 * import {
 *   createSandbox,
 *   createServerAdapter,
 *   createServerHost,
 * } from 'gameable/host/server';
 *
 * const engine = await createHeadlessEngine({ manifest, modules: [physics()] });
 * const adapter = createServerAdapter(engine.get('physics'));
 * const host = createServerHost(engine.get('physics'), engine.assets, adapter, { seed: 1 });
 * const sandbox = await createSandbox({ mode: 'direct', game, host });
 * ```
 */
export function createServerHost(
  physics: PhysicsService,
  assets: AssetRegistry,
  adapter: ServerHostAdapter,
  options: ServerHostOptions = {},
): ServerHost {
  return new ServerHost(physics, assets, adapter, options);
}
