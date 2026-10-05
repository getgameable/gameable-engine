/**
 * The two-seat tiny game plus `defineMessage`, for the parity test that a
 * validated message reads and counts the same in direct and in wasm mode.
 * Built to wasm by `buildTinyGame({ game: 'votes' })`.
 *
 * As the authority it reads `vote` through its definition, broadcasts a
 * `tally` through `ctx.net.send(Tally, ...)`, and shows the voter, on their
 * own HUD, the running `dropped` and `received` counters.
 */
import { defineGame, defineMessage, hasKeys, type GameContext } from 'gameable';

import twoSeats from './twoSeats';

/** A vote names a seat. */
interface VotePayload {
  for: number;
}

/** A tally: who voted for whom, on which frame. */
interface TallyPayload {
  by: number;
  for: number;
  frame: number;
}

const hasFor = hasKeys('for');
const hasTally = hasKeys('by', 'for', 'frame');

/** A vote: a whole seat number, at most 32 bytes of JSON. */
export const Vote = defineMessage(
  'vote',
  (p): p is VotePayload => hasFor(p) && Number.isInteger(p.for) && (p.for as number) >= 0,
  { maxBytes: 32 },
);

/** The authority's answer to every vote. */
export const Tally = defineMessage(
  'tally',
  (p): p is TallyPayload =>
    hasTally(p) &&
    typeof p.by === 'number' &&
    typeof p.for === 'number' &&
    typeof p.frame === 'number',
);

/** Reused payload and HUD model: a system must not allocate. */
const tally: TallyPayload = { by: 0, for: 0, frame: 0 };
const counters: Record<string, number> = { dropped: 0, received: 0 };

/**
 * Answer every valid vote with a tally, and show the voter the counters.
 *
 * @param ctx The frame context.
 */
function countVotes(ctx: GameContext): void {
  const votes = ctx.net.messages(Vote);
  for (let i = 0; i < votes.length; i += 1) {
    const vote = votes[i];
    tally.by = vote.player;
    tally.for = vote.payload.for;
    tally.frame = ctx.frame;
    ctx.net.send(Tally, tally);
    counters.dropped = ctx.net.stats.dropped;
    counters.received = ctx.net.stats.received;
    ctx.players.get(vote.player)?.hud.set(counters);
  }
}

export default defineGame({
  ...twoSeats,
  systems: [...(twoSeats.systems ?? []), { on: 'authority', run: countVotes }],
});
