/**
 * One guest's pieces, made once by `createGuest` and shared by its exports:
 * the runtime, the context, the built-in systems, the resolved user systems
 * and the reused output record.
 */
import { DataFacade } from '../data';
import { NetFacade, PlayerSpawner } from '../net';
import { createRuntimeState } from '../runtimeState';
import { BuiltinSystems } from './BuiltinSystems';
import { createGameContext } from './context';
import type { GameContext, GameDefinition, System } from '../defineGame';
import type { RuntimeState } from '../state';
import type { FrameOutput, HostApi } from '../types';

/** What a guest's `init`, `tick` and the rest share. */
export interface GuestParts {
  readonly host: HostApi;
  readonly definition: GameDefinition;
  /** The entity ceiling the component stores are sized for. */
  readonly maxEntities: number;
  readonly rt: RuntimeState;
  readonly net: NetFacade;
  /** `ctx.data`. */
  readonly data: DataFacade;
  readonly ctx: GameContext;
  readonly spawner: PlayerSpawner;
  readonly builtins: BuiltinSystems;
  /** The user systems that run in this role, resolved once per `init`. */
  readonly systems: System[];
  /**
   * `"system[i]"` for each of `systems`, `i` its declaration index, built in
   * `init`. Formatting them inside the tick would allocate one string per
   * system per frame, which in QuickJS is one of the more expensive things a
   * guest can do on a hot path.
   */
  readonly systemLabels: string[];
  /** The user `update` hook, resolved once. */
  readonly update: GameDefinition['update'];
  /** True when the game turns on `features.multiplayer`. */
  readonly multiplayer: boolean;
  /** The single reused output record. Mutated, never rebuilt. */
  readonly output: FrameOutput;
}

/**
 * @param host The host services, in guest-side JS shapes.
 * @param definition The result of `defineGame`.
 * @param maxEntities The entity ceiling.
 * @returns A guest's pieces, before `init`.
 */
export function createGuestParts(
  host: HostApi,
  definition: GameDefinition,
  maxEntities: number,
): GuestParts {
  const rt = createRuntimeState(host, definition, maxEntities);
  const net = new NetFacade(rt);
  const data = new DataFacade(rt);
  const ctx = createGameContext(rt, definition, net, data);
  return {
    host,
    definition,
    maxEntities,
    rt,
    net,
    data,
    ctx,
    spawner: new PlayerSpawner(definition.player, ctx),
    builtins: new BuiltinSystems(rt, definition),
    systems: [],
    systemLabels: [],
    update: definition.update,
    multiplayer:
      definition.features?.multiplayer !== undefined && definition.features.multiplayer !== false,
    output: {
      transforms: new Float32Array(0),
      commands: rt.commands.list,
      localCommands: rt.localCommands.list,
      camera: rt.camera,
      hud: undefined,
    },
  };
}

/**
 * Run one user callback, converting a throw into a log line.
 *
 * The callback and its argument are passed separately so a tick builds no
 * closure: `guard(host, label, system, ctx)`, never `guard(host, label, () => ...)`.
 *
 * @param host Where the log line goes.
 * @param label What to name in the log.
 * @param fn The callback.
 * @param arg The single argument it takes.
 * @returns True when the callback completed.
 */
export function guard<T>(host: HostApi, label: string, fn: (arg: T) => void, arg: T): boolean {
  try {
    fn(arg);
    return true;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    host.log('error', `${label} threw: ${message}`);
    return false;
  }
}
