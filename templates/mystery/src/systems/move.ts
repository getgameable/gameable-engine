/**
 * Walk every player: camera-relative WASD, Shift to run, a follow camera each.
 *
 * Authority only, because the authority owns the bodies. In a room each
 * player is driven from their own `ctx.players` handle (their input, their
 * look angles, their camera); in solo the one player is `ctx.player`, driven
 * from `ctx.input` and `ctx.camera`. A player who is out stands still.
 */
import { markMoved, Transform, TRANSFORM_FLAGS, type GameContext } from 'gameable';

import { num } from '../lobby';
import { MAX_SEATS, PHASE_LIVE, round } from '../round';

/** The parts of an input facade this system reads. Both `ctx.input` and a player's fit. */
type Controls = Pick<GameContext['input'], 'axis2' | 'isDown'>;
/** The parts of a camera facade this system writes. Both `ctx.camera` and a player's fit. */
type Rig = Pick<GameContext['camera'], 'follow' | 'look'>;

/** Reused follow options. */
const follow = { yaw: 0, pitch: 0, distance: 4.5, height: 0.4 };

/**
 * Drive one player's body and camera for this step. Allocates nothing.
 *
 * @param ctx The frame context.
 * @param entity The player's entity.
 * @param input Their controls.
 * @param camera Their camera.
 * @param frozen True for a player who is out.
 */
function drive(
  ctx: GameContext,
  entity: number,
  input: Controls,
  camera: Rig,
  frozen: boolean,
): void {
  const look = camera.look;
  look.pitch = Math.max(-1.15, Math.min(0.6, look.pitch));
  follow.yaw = look.yaw;
  follow.pitch = look.pitch;
  follow.distance = num(ctx.rules.cameraDistance, 4.5);
  follow.height = num(ctx.rules.cameraHeight, 0.4);
  camera.follow(entity, follow);

  const move = input.axis2('A', 'D', 'S', 'W');
  const mx = frozen ? 0 : move.x;
  const my = frozen ? 0 : move.y;
  const length = Math.hypot(mx, my);
  const speed = input.isDown('Shift') ? num(ctx.rules.runSpeed, 4) : num(ctx.rules.walkSpeed, 1.6);
  const sin = Math.sin(look.yaw);
  const cos = Math.cos(look.yaw);
  // The camera sits on +Z at yaw zero: W travels away from it, D to its right.
  const vx = length > 0 ? ((mx * cos - my * sin) / length) * speed : 0;
  const vz = length > 0 ? ((-mx * sin - my * cos) / length) * speed : 0;
  ctx.physics.moveCharacter(entity, vx, 0, vz, false);

  if (length > 0) {
    const half = Math.atan2(vx, vz) * 0.5;
    Transform.qx[entity] = Transform.qz[entity] = 0;
    Transform.qy[entity] = Math.sin(half);
    Transform.qw[entity] = Math.cos(half);
    markMoved(entity, TRANSFORM_FLAGS.ROTATION);
  }
  const state = length === 0 ? 'idle' : input.isDown('Shift') ? 'run' : 'walk';
  ctx.character.setState(entity, state, vx, 0, vz, true);
}

/**
 * The `move` system.
 *
 * @param ctx The frame context.
 */
export function move(ctx: GameContext): void {
  if (ctx.net.role === 'solo') {
    if (ctx.player !== 0) drive(ctx, ctx.player, ctx.input, ctx.camera, false);
    return;
  }
  for (let id = 0; id < MAX_SEATS; id += 1) {
    const handle = ctx.players.get(id);
    const entity = ctx.playerEntity(id);
    if (handle === undefined || entity === 0) continue;
    // Out stands still while the round runs; between rounds everyone walks.
    const out = round.phase === PHASE_LIVE && round.playing[id] === 1 && round.out[id] === 1;
    drive(ctx, entity, handle.input, handle.camera, out);
  }
}
