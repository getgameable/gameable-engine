/**
 * The `ctx` a guest's systems, `init`, `update` and `shutdown` receive: live
 * getters over the runtime, so one object serves every tick.
 */
import { assetId } from '../assets';
import { audio } from '../audio';
import { camera } from '../camera';
import { character } from '../character';
import { hud } from '../hud';
import { input } from '../input';
import { physics } from '../physics';
import { despawn, spawn } from '../prefab';
import type { GameContext, GameDefinition } from '../defineGame';
import type { DataFacade } from '../data';
import type { NetFacade } from '../net';
import type { RuntimeState } from '../state';

/**
 * @param rt The runtime the getters read.
 * @param definition The game, for `ctx.rules`.
 * @param net The runtime's `ctx.net`.
 * @param data The runtime's `ctx.data`.
 * @returns The game context, built once per guest.
 */
export function createGameContext(
  rt: RuntimeState,
  definition: GameDefinition,
  net: NetFacade,
  data: DataFacade,
): GameContext {
  return {
    get world() {
      return rt.world;
    },
    get frame() {
      return rt.frame;
    },
    get dt() {
      return rt.dt;
    },
    get elapsed() {
      return rt.elapsed;
    },
    get rng() {
      return rt.rng;
    },
    input,
    physics,
    camera,
    hud,
    audio,
    character,
    get contacts() {
      return rt.contacts;
    },
    get events() {
      return rt.events;
    },
    get players() {
      return rt.players.map;
    },
    get localPlayer() {
      return rt.net.role === 'client' ? (rt.players.handle(rt.net.localPlayer) ?? null) : null;
    },
    net,
    data,
    playerEntity: (id: number) => rt.players.handle(id)?.entity ?? 0,
    get player() {
      return rt.player;
    },
    get rules() {
      return definition.rules ?? {};
    },
    get config() {
      return rt.config;
    },
    spawn,
    despawn,
    assetId,
  };
}
