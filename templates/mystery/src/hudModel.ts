/**
 * What one player's HUD says, phase by phase. Built only on the ticks that
 * player's view changed (`src/hud.ts` decides when).
 *
 * The role is the secret: each "it" sees `role: it` (and, with more than one,
 * the others in `with`), everyone else `role: crew`, and nobody's HUD names
 * "it" until the round is over. `time` is the round clock. Chat lines are plain
 * text rows; the page's HUD draws every value with `textContent`.
 */
import type { GameContext } from 'gameable';

import { CHAT_LINES, chatLog, ghostLog } from './chat';
import { nameOf, num } from './lobby';
import {
  MAX_PLAYERS,
  MAX_SEATS,
  OUT_TAGGED,
  OUT_VOTED,
  PHASE_OVER,
  PHASE_VOTE,
  PHASE_WAITING,
  WINNER_CREW,
  WINNER_TIME,
  WINNER_VOTE,
  round,
} from './round';
import { readyCount } from './systems/ready';

/** What every HUD this tick shares. */
export interface HudView {
  /** The seated players, ascending. */
  ids: Int32Array;
  /** How many of `ids` are set. */
  n: number;
  /** The host's id. */
  host: number;
  /** True during a grace period. */
  grace: boolean;
  /** Whole seconds left on the round clock; 0 between rounds. */
  left: number;
}

/**
 * Add the chat rows (`chat 1` oldest .. `chat 3` newest) to a text block. A
 * ghost (`round.ghost`) reads every line; anyone else, every line but a
 * ghost's.
 *
 * @param id The player whose HUD this is.
 * @param text The block.
 * @returns The same block.
 */
function withChat(id: number, text: Record<string, string>): Record<string, string> {
  const log = round.ghost(id) ? ghostLog : chatLog;
  for (let i = 0; i < CHAT_LINES; i += 1) {
    const line = log.lines[i];
    if (line !== '') text[`chat ${String(i + 1)}`] = line;
  }
  return text;
}

/**
 * @param ctx The frame context.
 * @param id The player.
 * @param view This tick's shared view.
 * @returns The lobby HUD, before a round or after one.
 */
function lobby(ctx: GameContext, id: number, view: HudView): Record<string, unknown> {
  const min = num(ctx.rules.minPlayers, 3);
  const ready = `${String(readyCount(view.ids, view.n))}/${String(view.n)}`;
  let line = round.ready[id] === 1 ? 'ready · waiting for the others' : 'press R when ready';
  if (id === view.host) line += ' · G starts now';
  if (view.n < min) line = `waiting for players (${String(view.n)}/${String(min)})`;
  if (round.phase === PHASE_WAITING) {
    const players = `${String(view.n)}/${String(MAX_PLAYERS)}`;
    return { text: withChat(id, { players, ready }), message: line };
  }
  const name = round.itName === '' ? `#${String(round.it + 1)}` : round.itName;
  const was = round.itCount > 1 ? 'were it' : 'was it';
  const it = round.isIt(id);
  let result = it ? 'you got everyone' : `${name} ${was}`;
  if (round.winner === WINNER_CREW) result = `${name} ${was} and left: the crew wins`;
  if (round.winner === WINNER_VOTE) {
    result = it ? 'voted out: the crew wins' : `${name} ${was} and voted out: the crew wins`;
  }
  if (round.winner === WINNER_TIME) result = `time is up: the crew wins · ${name} ${was}`;
  const alive = String(round.aliveCount());
  return { text: withChat(id, { alive, ready }), message: `${result} · ${line}` };
}

/**
 * @param ctx The frame context.
 * @returns Who can be voted for, as `key name` pairs: `1 You · 3 Sam`.
 */
function candidates(ctx: GameContext): string {
  let list = '';
  for (let id = 0; id < MAX_PLAYERS; id += 1) {
    if (!round.alive(id)) continue;
    if (list !== '') list += ' · ';
    list += `${String(id + 1)} ${nameOf(ctx, id)}`;
  }
  return list;
}

/**
 * @param ctx The frame context.
 * @param id The player.
 * @returns Their HUD while the vote is open.
 */
function voting(ctx: GameContext, id: number): Record<string, unknown> {
  const alive = round.aliveCount();
  const text: Record<string, string> = {
    role: round.isIt(id) ? 'it' : 'crew',
    alive: String(alive),
    votes: `${String(round.ballot.votes())}/${String(alive)}`,
  };
  let message = 'who is it? press 1-6 to vote';
  if (round.out[id] === OUT_TAGGED) message = 'tagged out · they are voting';
  if (round.out[id] === OUT_VOTED) message = 'voted out · they are voting';
  if (round.alive(id)) {
    const pick = round.ballot.pick[id];
    text['vote for'] = candidates(ctx);
    text['your vote'] = pick < 0 ? 'none yet' : `${String(pick + 1)} ${nameOf(ctx, pick)}`;
  }
  return { text: withChat(id, text), message };
}

/**
 * One player's HUD model.
 *
 * @param ctx The frame context.
 * @param id The player.
 * @param view This tick's shared view.
 * @returns The model.
 */
export function model(ctx: GameContext, id: number, view: HudView): Record<string, unknown> {
  if (round.phase === PHASE_WAITING || round.phase === PHASE_OVER) return lobby(ctx, id, view);
  const alive = String(round.aliveCount());
  if (round.playing[id] !== 1) {
    const message =
      round.phase === PHASE_VOTE ? 'watching: they are voting' : 'watching: next round soon';
    return { text: withChat(id, { alive }), message };
  }
  if (round.phase === PHASE_VOTE) return voting(ctx, id);
  const it = round.isIt(id);
  const some = round.itCount > 1 ? `${String(round.itCount)} of you are it` : 'one of you is it';
  let message = '';
  if (round.out[id] === OUT_TAGGED) message = 'tagged out';
  else if (round.out[id] === OUT_VOTED) message = 'voted out';
  else if (view.grace) message = it ? 'you are it: tag everyone' : `${some}. run`;
  const text: Record<string, string> = {
    role: it ? 'it' : 'crew',
    alive,
    time: `${String(view.left)}s`,
  };
  if (it && round.itCount > 1) text.with = partners(ctx, id);
  return { text: withChat(id, text), message };
}

/**
 * @param ctx The frame context.
 * @param id An "it".
 * @returns The other "it"s, as every HUD names a player: `#3 Sam`.
 */
function partners(ctx: GameContext, id: number): string {
  let list = '';
  for (let other = 0; other < MAX_SEATS; other += 1) {
    if (other === id || !round.isIt(other)) continue;
    if (list !== '') list += ' · ';
    list += `#${String(other + 1)} ${nameOf(ctx, other)}`;
  }
  return list;
}
