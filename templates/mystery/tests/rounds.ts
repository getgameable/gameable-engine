/**
 * Rooms already part-way through a round, for the lobby, vote and chat tests.
 */
import { round } from '../src/round';
import { AUTHORITY, boot, joined, message, spread, touch, type Room } from './room';

/**
 * @param n How many.
 * @returns `0 .. n - 1`.
 */
export function seats(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * A room of `n` in the lobby.
 *
 * @param n Players.
 * @returns The room.
 */
export function lobby(n: number): Room {
  const room = boot(AUTHORITY);
  room.step(seats(n).map(joined));
  return room;
}

/**
 * A room of `n`, dealt by the host, spread out and past the grace period.
 *
 * @param n Players.
 * @returns The room and the crew's ids.
 */
export function dealt(n: number): { room: Room; crew: number[] } {
  const room = lobby(n);
  room.step([message(0, 'start')]);
  spread(room, seats(n));
  for (let i = 0; i < 60 * 4; i += 1) room.step();
  return { room, crew: seats(n).filter((id) => id !== round.it) };
}

/**
 * A room of `n` where "it" has just tagged the first crew member: the vote is open.
 *
 * @param n Players.
 * @returns The room, the tagged player, and the crew still in.
 */
export function voting(n: number): { room: Room; tagged: number; crew: number[] } {
  const { room, crew } = dealt(n);
  touch(room, round.it, crew[0]);
  room.step();
  return { room, tagged: crew[0], crew: crew.slice(1) };
}

/**
 * @param voter Who votes.
 * @param target Their pick.
 * @returns The `vote` message, as the page sends it.
 */
export function vote(voter: number, target: number): ReturnType<typeof message> {
  return message(voter, 'vote', { for: target });
}
