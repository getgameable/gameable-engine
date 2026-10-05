/**
 * The untyped service lookup both the adapter and the host loop go through.
 */
import type { Engine } from '@gameable/core';

/**
 * Look a service up without the typed table.
 *
 * `engine.get` is typed through `EngineServices`, which only knows about
 * packages that have been imported for their side effects. This package
 * imports none of them, so it goes through the untyped escape hatch and
 * asserts the shape it knows.
 *
 * @param engine The engine.
 * @param id Service id.
 * @returns The service, or null when the module was not registered.
 */
export function lookup(engine: Engine, id: string): unknown {
  return engine.modules.tryGet(id) ?? null;
}
