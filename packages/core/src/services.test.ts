import { describe, expect, expectTypeOf, it } from 'vitest';

import { createModuleRegistry } from './module.js';

/** The service a hypothetical physics package would expose. */
interface FakePhysicsService {
  /** Gravity, metres per second squared. */
  gravity: number;
}

// This is the declaration-merging pattern every service package uses. In a real
// package the module specifier is 'gameable/core'; here it is the relative
// path, because the test lives inside core.
declare module './module.js' {
  interface EngineServices {
    /** The physics module's service. */
    physics: FakePhysicsService;
  }
}

describe('EngineServices declaration merging', () => {
  it('types get() without a cast at the call site', () => {
    const registry = createModuleRegistry();
    registry.registerService('physics', { gravity: -9.81 });

    const physics = registry.get('physics');

    expectTypeOf(physics).toEqualTypeOf<FakePhysicsService>();
    expect(physics.gravity).toBe(-9.81);
  });
});
