/**
 * The client's half: keys become messages to the authority, and what the
 * authority says about this player plays a sound on this page only. Q
 * shields your base, R rebirths.
 */
import type { GameContext } from 'gameable';

import { Rebirth, Shield } from '../messages';

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  // Solo runs every system, but there is nobody to send to.
  if (ctx.net.role === 'solo') return;
  if (ctx.input.pressed('KeyQ')) ctx.net.send(Shield, null);
  if (ctx.input.pressed('KeyR')) ctx.net.send(Rebirth, null);
  const me = ctx.net.localPlayer;
  const grabbed = ctx.net.messages<{ player: number }>('grabbed');
  for (let i = 0; i < grabbed.length; i += 1) {
    if (grabbed[i].payload.player === me) ctx.audio.play('sfx.grab');
  }
  const stolen = ctx.net.messages<{ thief: number; victim: number }>('stolen');
  for (let i = 0; i < stolen.length; i += 1) {
    const p = stolen[i].payload;
    if (p.thief === me || p.victim === me) ctx.audio.play('sfx.steal');
  }
}
