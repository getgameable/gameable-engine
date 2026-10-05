/**
 * The end-to-end suite's way in: `window.__AOS_TEST__`, installed with
 * `?test=1`. Read-only: it reports the page's room and never drives the game.
 *
 * Host code, split out of `src/main.ts`.
 */
import type { NetService } from 'gameable/net/client';

/** One player in the room, as the server last listed them. */
export interface TestPlayer {
  id: number;
  name: string;
  /** False while the seat is held for a reconnect. */
  connected: boolean;
}

/** What the test hook exposes, when `?test=1` is on the URL. */
export interface TestHooks {
  /** @returns Where the page is in its room: `connecting`, `joined`, `reconnecting` or `closed`. */
  state(): string;
  /** @returns The room's code from the welcome, or null before it. */
  room(): string | null;
  /** @returns This page's seat, or -1 before the welcome. */
  localPlayer(): number;
  /** @returns Everyone in the room, held seats included, as plain copies. */
  players(): TestPlayer[];
}

declare global {
  interface Window {
    /** Installed with `?test=1`. */
    __AOS_TEST__?: TestHooks;
  }
}

/**
 * Install `window.__AOS_TEST__` over the page's `net` service.
 *
 * @param net The engine's `net` service.
 */
export function installTestHooks(net: NetService): void {
  window.__AOS_TEST__ = {
    state: () => net.state,
    room: () => net.room,
    localPlayer: () => net.localPlayer,
    players: () => net.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
  };
}
