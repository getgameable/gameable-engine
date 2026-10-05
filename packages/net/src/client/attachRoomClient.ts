/**
 * `attachRoomClient` — the end of a multiplayer page's boot, one helper for
 * every page so the copies cannot drift. It lives in the client entry, not
 * `gameable/net/page`, which stays free of the client loop (the CLI reads
 * `catalogName` from it): the client loop into the game slot
 * (which starts the join, after the page has loaded), Play Solo's authority
 * on the page's frames, and the room badge.
 */
import type { HostContext } from '@gameable/core';
import type { GameSlot, LoopEngine, Sandbox } from '@gameable/wasm-host';

import type { ChosenRoom, SoloLink } from '../page/chooseRoom.js';
import { createPageRoom, type PageRoom, type PageRoomBadgeOptions } from '../page/PageRoom.js';
import { createClientLoop, type ClientLoop, type ClientLoopOptions } from './ClientLoop.js';
import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import type { NetService } from './NetService.js';

/**
 * What {@link attachRoomClient} wires together: the booted page.
 *
 * @example
 * ```ts
 * import type { RoomClientParts } from 'gameable/net/client';
 * declare const parts: RoomClientParts;
 * console.log(parts.room.mode.kind);
 * ```
 */
export interface RoomClientParts {
  /** The page's engine, booted with the `multiplayer` feature. */
  readonly engine: LoopEngine & { readonly ctx: HostContext };
  /** Its `net` service (`engine.get('net')`). */
  readonly net: NetService;
  /** Where the authority's world is drawn (the page's `EngineAdapterHandle`). */
  readonly adapter: ClientLoopAdapter;
  /** The client-role guest, or null to only show the authority's world. */
  readonly sandbox: Sandbox | null;
  /** The game slot the page booked in `createEngine`. */
  readonly slot: Pick<GameSlot, 'attach'>;
  /** The room `chooseRoom` picked. */
  readonly room: Pick<ChosenRoom<SoloLink>, 'mode' | 'solo'>;
  /** The client loop's seed and `entityBase` (`world.maxEntities`). */
  readonly loop?: Omit<ClientLoopOptions, 'onDead'>;
  /** Called once if the client loop dies. */
  readonly onDead: (error: Error | null) => void;
  /** The badge's browser stand-ins (tests). */
  readonly badge?: Omit<PageRoomBadgeOptions, 'net' | 'mode'>;
}

/**
 * What {@link attachRoomClient} made.
 *
 * @example
 * ```ts
 * import type { RoomClient } from 'gameable/net/client';
 * declare const client: RoomClient;
 * client.dispose();
 * ```
 */
export interface RoomClient {
  /** The client loop, in the game slot. */
  readonly loop: ClientLoop;
  /** The room badge; it follows `net` on its own. */
  readonly badge: PageRoom;
  /** Take the badge down and stop driving Play Solo. The slot and the engine are the page's. */
  dispose(): void;
}

/**
 * Run the page as a room's client: the client loop in the slot (attaching it
 * starts the join, so the seat is taken only once the page has loaded), Play
 * Solo's authority stepping on the page's frames, and the badge.
 *
 * @param parts The booted page.
 * @returns The loop and the badge.
 *
 * @example
 * ```ts
 * import { attachRoomClient } from 'gameable/net/client';
 *
 * const client = await attachRoomClient({
 *   engine, net: engine.get('net'), adapter, sandbox, slot, room,
 *   loop: { seed: 7, entityBase: 4096 },
 *   onDead: (error) => console.error(error),
 * });
 * ```
 */
export async function attachRoomClient(parts: RoomClientParts): Promise<RoomClient> {
  const { engine, net, room } = parts;
  const loop = createClientLoop(engine, parts.adapter, net, parts.sandbox, {
    ...parts.loop,
    onDead: parts.onDead,
  });
  await parts.slot.attach(loop, engine.ctx);
  // The authority ticks on this page's frames, after each of its steps.
  const undrive = room.solo?.drive?.(engine);
  const badge = createPageRoom({ ...parts.badge, net, mode: room.mode });
  return {
    loop,
    badge,
    dispose: () => {
      badge.dispose();
      undrive?.();
    },
  };
}
