/**
 * Sitting, on the authority. A `sit` message from a player beside a bench
 * sits them down (their character's state becomes `sit`, in
 * `src/systems/drive.ts`); `sit` again, or a movement key, stands them up.
 */
import type { GameContext } from 'gameable';

import { Sit } from '../messages';
import { MAX_PLAYERS, residents } from '../residents';
import { benchNear } from './interact';

/**
 * The `sit` system.
 *
 * @param ctx The frame context.
 */
export function sit(ctx: GameContext): void {
  const asks = ctx.net.messages(Sit);
  for (let i = 0; i < asks.length; i += 1) {
    const seat = asks[i].player;
    const entity = residents.entity[seat] ?? 0;
    if (entity === 0 || residents.car[seat] >= 0) continue;
    residents.bench[seat] = residents.bench[seat] !== 0 ? 0 : benchNear(ctx, entity);
  }
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    if (residents.bench[seat] === 0) continue;
    const move = ctx.players.get(seat)?.input.axis2('A', 'D', 'S', 'W');
    if (move !== undefined && (move.x !== 0 || move.y !== 0)) residents.bench[seat] = 0;
  }
}
