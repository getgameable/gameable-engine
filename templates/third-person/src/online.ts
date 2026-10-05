/**
 * The multiplayer half of the page, loaded only when `src/game.ts` declares
 * `features.multiplayer`. A page without it never downloads this file, the
 * room badge, or the client loop.
 *
 * - No `?room=`: Play Solo, the authority in this page (`src/solo.ts`), with
 *   a "Play with friends" button that makes a room.
 * - `?room=CODE` joins that room, `?room=new` makes one, `?room=quick` takes
 *   any open one, on the room server at `<page origin>/services/rooms/` (or,
 *   on a local page, `?rooms=<url>`, such as `gameable serve`'s).
 *
 * The badge in the corner shows the room code, a copy-link button, the
 * connection's state and why a join failed, and "Browse rooms" opens the
 * game's public rooms (code, players, phase) with a Join for each.
 */
import type { Engine } from 'gameable/core';
import { attachRoomClient } from 'gameable/net/client';
import { chooseRoom, roomMode, type ChosenRoom } from 'gameable/net/page';
import type { InPageAuthority } from 'gameable/net/solo';
import { DEFAULT_MAX_ENTITIES, type GameDefinition } from 'gameable';
import type { EngineAdapterHandle, GameSlot, Sandbox } from 'gameable/host';
import { listPublicRooms } from 'gameable/host/features';

import { GAME_NAME } from './session';

/** The page's room: the in-page authority under Play Solo, or a room server's. */
export type OnlineRoom = ChosenRoom<InPageAuthority>;

/**
 * Pick the room from the address, starting Play Solo's authority when there
 * is no `?room=`.
 *
 * @param definition The game.
 * @param seed The run seed.
 * @param warn Shows a warning (Play Solo's stale guest under `npm run dev`).
 * @returns The room; pass its `multiplayer` to the feature table.
 */
export function chooseOnlineRoom(
  definition: GameDefinition,
  seed: number,
  warn: (message: string) => void,
): Promise<OnlineRoom> {
  return chooseRoom(roomMode(location.search), {
    game: GAME_NAME,
    name: 'You',
    startSolo: async () => (await import('./solo')).startSolo(definition, seed, warn),
  });
}

/** What {@link attachOnline} wires together. */
export interface OnlineParts {
  engine: Engine;
  adapter: EngineAdapterHandle;
  sandbox: Sandbox;
  slot: GameSlot;
  definition: GameDefinition;
  seed: number;
  /** `features.multiplayer.predict`: the client loop predicts this player's own character body. */
  predict: boolean;
  /** Shows a failure on the page, and leaves the room. */
  fail: (error: unknown) => void;
}

/**
 * Run the game as a room's client (`attachRoomClient`): the client loop in
 * the game slot, which starts the join now that the page has loaded, Play
 * Solo's authority on this page's frames, and the room badge.
 *
 * @param room The chosen room.
 * @param parts The booted page.
 * @returns The entity this page's player controls, read live (0 before the welcome).
 */
export async function attachOnline(room: OnlineRoom, parts: OnlineParts): Promise<() => number> {
  const { engine, definition, fail } = parts;
  const net = engine.get('net');
  await attachRoomClient({
    engine,
    net,
    adapter: parts.adapter,
    sandbox: parts.sandbox,
    slot: parts.slot,
    room,
    loop: {
      seed: parts.seed,
      entityBase: definition.world?.maxEntities ?? DEFAULT_MAX_ENTITIES,
      predict: parts.predict,
    },
    onDead: (error) => {
      fail(error ?? new Error('the client loop stopped'));
    },
    // "Browse rooms": the public rooms of this game; the rooms client loads when it opens.
    badge: { browse: { game: GAME_NAME, list: listPublicRooms } },
  });
  return () => net.localEntity;
}
