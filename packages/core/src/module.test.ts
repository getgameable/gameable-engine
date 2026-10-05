import { describe, expect, it, vi } from 'vitest';

import type { EngineContext } from './context.js';
import type { EngineModule } from './module.js';
import { createModuleRegistry, ModuleError } from './module.js';

/** A context stub: the registry never reads from it, it only passes it on. */
const ctx = {} as EngineContext;

/**
 * A module that records what happened to it.
 *
 * @param id Module id.
 * @param order Sort key.
 * @param log Shared list every lifecycle call appends to.
 * @param service Optional service to return from `init`.
 * @returns The module.
 */
function probe(
  id: string,
  order: number | undefined,
  log: string[],
  service?: object,
): EngineModule {
  return {
    id,
    ...(order === undefined ? {} : { order }),
    init: () => {
      log.push(`init:${id}`);
      return service;
    },
    dispose: () => {
      log.push(`dispose:${id}`);
    },
  };
}

describe('ordering', () => {
  it('sorts by order, then by registration index', () => {
    const registry = createModuleRegistry();
    const log: string[] = [];
    registry.register(probe('c', 100, log));
    registry.register(probe('a', -100, log));
    registry.register(probe('b1', 0, log));
    registry.register(probe('b2', 0, log));
    registry.register(probe('d', undefined, log)); // treated as 0

    expect(registry.modules.map((m) => m.id)).toEqual(['a', 'b1', 'b2', 'd', 'c']);
  });

  it('inits in order and disposes in reverse', async () => {
    const registry = createModuleRegistry();
    const log: string[] = [];
    registry.register(probe('physics', 0, log));
    registry.register(probe('input', -100, log));
    registry.register(probe('hud', 100, log));

    await registry.initAll(ctx);
    registry.disposeAll();

    expect(log).toEqual([
      'init:input',
      'init:physics',
      'init:hud',
      'dispose:hud',
      'dispose:physics',
      'dispose:input',
    ]);
  });

  it('awaits each init before starting the next', async () => {
    const registry = createModuleRegistry();
    const log: string[] = [];
    registry.register({
      id: 'slow',
      order: -1,
      init: async () => {
        log.push('slow:start');
        await Promise.resolve();
        log.push('slow:end');
      },
      dispose: () => undefined,
    });
    registry.register(probe('fast', 0, log));

    await registry.initAll(ctx);
    expect(log).toEqual(['slow:start', 'slow:end', 'init:fast']);
  });
});

describe('services', () => {
  it('registers a service returned from init, under the module id', async () => {
    const registry = createModuleRegistry();
    const physics = { gravity: -9.81 };
    registry.register(probe('physics', 0, [], physics));

    await registry.initAll(ctx);

    expect(registry.tryGet('physics')).toBe(physics);
    expect(registry.has('physics')).toBe(true);
  });

  it('registers a service through registerService', () => {
    const registry = createModuleRegistry();
    const audio = { volume: 1 };
    registry.registerService('audio', audio);
    expect(registry.tryGet('audio')).toBe(audio);
  });

  it('lets registerService win over the init return value', async () => {
    const registry = createModuleRegistry();
    const early = { early: true };
    registry.register({
      id: 'thing',
      init: (c) => {
        c.registerService('thing', early);
        return { late: true };
      },
      dispose: () => undefined,
    });

    await registry.initAll({
      registerService: (id, service) => {
        registry.registerService(id, service);
      },
    } as EngineContext);

    expect(registry.tryGet('thing')).toBe(early);
  });

  it('throws a helpful error for an unknown service', () => {
    const registry = createModuleRegistry();
    registry.registerService('audio', {});
    expect(() => registry.get('nope' as never)).toThrow(ModuleError);
    expect(() => registry.get('nope' as never)).toThrow(/registered: audio/);
  });

  it('names "(none)" when nothing is registered', () => {
    const registry = createModuleRegistry();
    expect(() => registry.get('nope' as never)).toThrow(/registered: \(none\)/);
  });

  it('refuses to register the same service id twice', () => {
    const registry = createModuleRegistry();
    registry.registerService('audio', {});
    expect(() => {
      registry.registerService('audio', {});
    }).toThrow(/already registered/);
  });

  it('ignores a non-object init return value', async () => {
    const registry = createModuleRegistry();
    registry.register({
      id: 'nothing',
      init: () => undefined,
      dispose: () => undefined,
    });
    await registry.initAll(ctx);
    expect(registry.has('nothing')).toBe(false);
    expect(registry.tryGet('nothing')).toBeUndefined();
  });
});

describe('registration rules', () => {
  it('refuses duplicate module ids', () => {
    const registry = createModuleRegistry();
    registry.register(probe('a', 0, []));
    expect(() => {
      registry.register(probe('a', 1, []));
    }).toThrow(/already registered/);
  });

  it('refuses registration after initAll', async () => {
    const registry = createModuleRegistry();
    await registry.initAll(ctx);
    expect(() => {
      registry.register(probe('late', 0, []));
    }).toThrow(/after initAll/);
  });
});

describe('hooks', () => {
  it('collects only the modules that implement each hook, in run order', async () => {
    const registry = createModuleRegistry();
    registry.register({
      id: 'b',
      order: 10,
      init: () => undefined,
      fixedUpdate: () => undefined,
      update: () => undefined,
      dispose: () => undefined,
    });
    registry.register({
      id: 'a',
      order: 0,
      init: () => undefined,
      beginFrame: () => undefined,
      fixedUpdate: () => undefined,
      endFrame: () => undefined,
      dispose: () => undefined,
    });
    registry.register(probe('c', 20, []));

    await registry.initAll(ctx);

    expect(registry.beginFrameHooks.map((m) => m.id)).toEqual(['a']);
    expect(registry.fixedUpdateHooks.map((m) => m.id)).toEqual(['a', 'b']);
    expect(registry.updateHooks.map((m) => m.id)).toEqual(['b']);
    expect(registry.endFrameHooks.map((m) => m.id)).toEqual(['a']);
  });

  it('clears the hook lists on dispose', async () => {
    const registry = createModuleRegistry();
    registry.register({
      id: 'a',
      init: () => undefined,
      update: () => undefined,
      dispose: () => undefined,
    });
    await registry.initAll(ctx);
    expect(registry.updateHooks).toHaveLength(1);
    registry.disposeAll();
    expect(registry.updateHooks).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('wraps an init failure in a ModuleError naming the module', async () => {
    const registry = createModuleRegistry();
    registry.register({
      id: 'physics',
      init: () => {
        throw new Error('no wasm');
      },
      dispose: () => undefined,
    });

    await expect(registry.initAll(ctx)).rejects.toThrow(ModuleError);
    await expect(registry.initAll(ctx)).rejects.toThrow(/module "physics" failed to init/);
  });

  it('disposes every module even when one throws, then reports', async () => {
    const registry = createModuleRegistry();
    const good = vi.fn();
    registry.register({ id: 'a', order: 0, init: () => undefined, dispose: good });
    registry.register({
      id: 'b',
      order: 1,
      init: () => undefined,
      dispose: () => {
        throw new Error('leaky');
      },
    });

    await registry.initAll(ctx);
    expect(() => {
      registry.disposeAll();
    }).toThrow(AggregateError);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a module whose init never ran', async () => {
    const registry = createModuleRegistry();
    const laterDispose = vi.fn();
    registry.register({
      id: 'first',
      order: 0,
      init: () => {
        throw new Error('boom');
      },
      dispose: () => undefined,
    });
    registry.register({ id: 'second', order: 1, init: () => undefined, dispose: laterDispose });

    await expect(registry.initAll(ctx)).rejects.toThrow(ModuleError);
    registry.disposeAll();
    expect(laterDispose).not.toHaveBeenCalled();
  });
});
