/**
 * The client's half: keys become messages to the authority, and what the
 * authority says about this player plays a sound on this page only. E gathers
 * at a tree, B builds a wall.
 */
import type { GameContext } from 'gameable';

import { Build, Gather } from '../messages';

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  // Solo runs every system, but there is nobody to send to.
  if (ctx.net.role === 'solo') return;
  if (ctx.input.pressed('KeyE')) ctx.net.send(Gather, null);
  if (ctx.input.pressed('KeyB')) ctx.net.send(Build, null);
  if (ctx.net.messages('wood').length > 0) ctx.audio.play('sfx.chop');
  const downed = ctx.net.messages<{ player: number }>('downed');
  for (let i = 0; i < downed.length; i += 1) {
    if (downed[i].payload.player === ctx.net.localPlayer) ctx.audio.play('sfx.hit');
  }
}
