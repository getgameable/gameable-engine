/**
 * How often a room sends each player its transform rows:
 * `features.multiplayer.sendHz`, read in one place by Play Solo and the room
 * server alike.
 */
import type { GameDefinition } from '../defineGame';

/** Rows per second when the game declares no `sendHz`. */
export const DEFAULT_SEND_HZ = 20;

/** The highest rate: the simulation's own, one row per fixed step. */
const MAX_SEND_HZ = 60;

/**
 * The rows rate a game declares, checked: `features.multiplayer.sendHz`, from
 * 1 to 60 per second (60 is the simulation rate, so more would repeat rows).
 *
 * @param definition The `defineGame` result.
 * @returns The declared rate, or 20 when none is declared.
 * @throws {RangeError} When `sendHz` is declared but is not a number from 1 to 60.
 *
 * @example
 * ```ts
 * import { defineGame, roomSendHz } from 'gameable';
 *
 * roomSendHz(defineGame({ features: { multiplayer: { sendHz: 10 } } })); // 10
 * roomSendHz(defineGame({ features: { multiplayer: true } })); // 20
 * ```
 */
export function roomSendHz(definition: GameDefinition): number {
  const feature = definition.features?.multiplayer;
  if (feature === undefined || typeof feature === 'boolean') return DEFAULT_SEND_HZ;
  const sendHz: unknown = feature.sendHz;
  if (sendHz === undefined) return DEFAULT_SEND_HZ;
  if (typeof sendHz !== 'number' || !Number.isFinite(sendHz) || sendHz < 1 || sendHz > MAX_SEND_HZ) {
    throw new RangeError(
      `features.multiplayer.sendHz must be a number from 1 to ${String(MAX_SEND_HZ)}, got ${typeof sendHz === 'number' ? String(sendHz) : JSON.stringify(sendHz)}`,
    );
  }
  return sendHz;
}
