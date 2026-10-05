/**
 * The page's half: keys become ability messages, what the authority says
 * about this player plays a sound here, and the camera looks down on the
 * arena. Client only; it changes nothing anyone else sees.
 *
 * J punch, K dash, L slam. A `hit` is a confirmed hit, as the attacker or the
 * victim: the hit sound plays (the victim's red flash is the authority's, so
 * everyone sees it). A `ko` of this player stops its own prediction until
 * its `respawn`.
 */
import { quatFromYawPitch, type GameContext } from 'gameable';

import { fight, MAX_PLAYERS } from '../fight';
import { Dash, Hit, Ko, Punch, Respawn, Slam } from '../messages';

/** The fixed arena camera: high behind the south edge, looking at the middle. */
const EYE = { x: 0, y: 13, z: 11 };
const LOOK = { x: 0, y: 0, z: 0, w: 1 };
quatFromYawPitch(LOOK, 0, -Math.atan2(EYE.y, EYE.z));

/** Hits this page has been told about, as attacker or victim. Read by the tests. */
export const heard = { hits: 0, kos: 0 };

/** Forget what was heard. Call from `defineGame({ init })`. */
export function resetControls(): void {
  heard.hits = 0;
  heard.kos = 0;
}

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  ctx.camera.set(EYE, LOOK, 50);
  if (ctx.input.pressed('J')) ctx.net.send(Punch, null);
  if (ctx.input.pressed('K')) ctx.net.send(Dash, null);
  if (ctx.input.pressed('L')) ctx.net.send(Slam, null);

  const me = ctx.net.localPlayer;
  const hits = ctx.net.messages(Hit);
  for (let i = 0; i < hits.length; i += 1) {
    heard.hits += 1;
    ctx.audio.play('sfx.hit');
  }
  const kos = ctx.net.messages(Ko);
  for (let i = 0; i < kos.length; i += 1) {
    const victim = kos[i].payload.to;
    if (victim === me) heard.kos += 1;
    if (victim < MAX_PLAYERS) fight.out[victim] = 1;
  }
  const back = ctx.net.messages(Respawn);
  for (let i = 0; i < back.length; i += 1) {
    const seat = back[i].payload.player;
    if (seat < MAX_PLAYERS) fight.out[seat] = 0;
  }
}
