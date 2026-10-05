/**
 * The door, shared by everyone: one player with the key unlocks it, it slides
 * for all, and the round is won for all once it has finished sliding.
 */
import { Transform, type GameContext } from 'gameable';

import { interactables } from '../prefabs';

/** Where the door's state lives (`interactState`, in `./interact`). */
export interface DoorTrack {
  /** The door entity, found during `init`. */
  door: number;
  /** How far the door has slid, in metres. */
  doorSlid: number;
}

/**
 * Slide the door, once it has been unlocked.
 *
 * `physics.teleport` is the right call for a kinematic body: it becomes a
 * `set-body-transform`, which the host applies to the Jolt body, and the body
 * rows come back next frame with the door where it now is.
 *
 * @param ctx The frame context.
 * @param track The door and how far it has slid.
 * @param round Where "escaped" is recorded.
 * @param round.escaped True once the door has finished sliding.
 * @returns Nothing.
 */
export function slideDoor(ctx: GameContext, track: DoorTrack, round: { escaped: boolean }): void {
  const door = track.door;
  if (door === 0 || interactables.used[door] !== 1) return;

  const travel = Number(ctx.rules.doorTravel ?? 2.4);
  if (track.doorSlid >= travel) {
    if (!round.escaped) round.escaped = true;
    return;
  }

  const speed = Number(ctx.rules.doorSpeed ?? 1.6);
  track.doorSlid = Math.min(travel, track.doorSlid + speed * ctx.dt);
  ctx.physics.teleport(
    door,
    (Transform.x[door] ?? 0) + speed * ctx.dt,
    Transform.y[door] ?? 0,
    Transform.z[door] ?? 0,
  );
}
