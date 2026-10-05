/**
 * `leaveRoom` — a multiplayer page whose boot failed, or whose client loop
 * died, gives up its seat at once instead of leaving a statue in the room
 * for as long as the tab stays open.
 */

/** The slice of an engine `leaveRoom` reads: its module registry. */
interface EngineLike {
  readonly modules: { tryGet(id: string): unknown };
}

/**
 * Leave the page's room, if the engine has one.
 *
 * @param engine The page's engine, or null when `createEngine` has not made it yet.
 * @param reason Why, as the room's leave carries it. Default `'crashed'`.
 * @returns True when there was a room to leave.
 *
 * @example
 * ```ts
 * import { leaveRoom } from 'gameable/net/page';
 * declare const engine: import('gameable/core').Engine | null;
 *
 * function crash(error: unknown): void {
 *   console.error(error);
 *   leaveRoom(engine);
 * }
 * ```
 */
export function leaveRoom(engine: EngineLike | null, reason = 'crashed'): boolean {
  const net = engine?.modules.tryGet('net') as { leave?: (reason?: string) => void } | undefined;
  if (typeof net?.leave !== 'function') return false;
  net.leave(reason);
  return true;
}
