/**
 * `createServerAdapter` — the factory for {@link ServerAdapter}, in the
 * repository's `createX()` convention.
 */
import type { PhysicsService } from '@gameable/physics-jolt';

import { ServerAdapter } from './ServerAdapter';
import type { ServerAdapterOptions } from './types';

/**
 * Build the adapter an authority applies the guest's output to.
 *
 * @param physics The Jolt world (`engine.get('physics')` on a headless engine).
 * @param options Body table size and warning sink.
 * @returns The adapter.
 *
 * @example
 * ```ts
 * import { createHeadlessEngine } from 'gameable/core/headless';
 * import { physics } from 'gameable/physics';
 * import { createServerAdapter } from 'gameable/host/server';
 *
 * const engine = await createHeadlessEngine({ modules: [physics()] });
 * const adapter = createServerAdapter(engine.get('physics'));
 * ```
 */
export function createServerAdapter(
  physics: PhysicsService,
  options?: ServerAdapterOptions,
): ServerAdapter {
  return new ServerAdapter(physics, options);
}
