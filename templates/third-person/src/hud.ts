/**
 * The HUD: the interact prompt, the dialogue box, the key indicator and the
 * end-of-round line.
 *
 * `hud.set` compares the model against the previous one **one level deep**,
 * with `Object.is`. A nested object mutated in place therefore looks
 * unchanged and would never be sent. So this system keeps a flat mirror of the
 * handful of values it draws, compares that, and only builds the nested model
 * on the frames something actually moved — a few small objects a second rather
 * than one every frame.
 *
 * There is no crosshair. You are not aiming at anything.
 *
 * In a room each player gets their own HUD (`PlayerHandle.hud`): their prompt,
 * their pocket, their conversation. Only the end-of-round line is shared.
 */
import type { GameContext } from 'gameable';

import { eachActor, type Actor } from './systems/actors';
import { dialogueFor, PHASE_QUESTION } from './systems/dialogue';
import { interactFor, questState } from './systems/interact';
import { SeatStore } from './systems/seats';

/** The values one HUD last drew. */
interface Mirror {
  keys: number;
  prompt: string;
  state: string;
  speaker: string;
  say: string;
  phase: number;
  notice: string;
  message: string | null;
}

/**
 * Last drawn values, so an unchanged frame costs six comparisons.
 *
 * `message: null` means "never drawn", which `''` cannot, because an empty
 * message is the normal state while the round is still going.
 */
const mirror: Mirror = {
  keys: -1,
  prompt: '',
  state: '',
  speaker: '',
  say: '',
  phase: -1,
  notice: '',
  message: null,
};

/**
 * A rule read as a string, with a fallback.
 *
 * `ctx.rules` is whatever `defineGame` was handed, so the type is `unknown`
 * and a game that puts an object there gets its fallback rather than
 * `[object Object]` across the wire.
 *
 * @param value The rule value.
 * @param fallback What to use when the rule is missing or not a string.
 * @returns The line to draw.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * @param m One HUD's mirror, forgotten.
 */
function clearMirror(m: Mirror): void {
  m.keys = -1;
  m.prompt = '';
  m.state = '';
  m.speaker = '';
  m.say = '';
  m.phase = -1;
  m.notice = '';
  m.message = null;
}

/** Every player's mirror; seat 0's is the single player's. */
const mirrors = new SeatStore<Mirror>(mirror, () => ({ ...mirror, message: null }), clearMirror);

/**
 * Forget the last drawn values. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetHud(): void {
  mirrors.reset();
}

/**
 * Refresh every player's HUD when something they see changed.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function updateHud(ctx: GameContext): void {
  eachActor(ctx, drawFor);
}

/**
 * Refresh one player's HUD when something changed.
 *
 * @param ctx The frame context.
 * @param who The player.
 * @returns Nothing.
 */
function drawFor(ctx: GameContext, who: Actor): void {
  const mirror = mirrors.of(who);
  const dialogueState = dialogueFor(who);
  const { seat, pocket } = interactFor(who);
  const keys = pocket.keys;
  const prompt = dialogueState.active ? '' : seat.prompt;
  const state = who.motion;
  const speaker = dialogueState.speaker;
  const say = dialogueState.text;
  const phase = dialogueState.phase;
  const notice = seat.message;
  const message = questState.escaped ? text(ctx.rules.winMessage, 'You escaped') : '';

  if (
    keys === mirror.keys &&
    prompt === mirror.prompt &&
    state === mirror.state &&
    speaker === mirror.speaker &&
    say === mirror.say &&
    phase === mirror.phase &&
    notice === mirror.notice &&
    message === mirror.message
  ) {
    return;
  }
  mirror.keys = keys;
  mirror.prompt = prompt;
  mirror.state = state;
  mirror.speaker = speaker;
  mirror.say = say;
  mirror.phase = phase;
  mirror.notice = notice;
  mirror.message = message;

  const rows: Record<string, string> = { keys: String(keys), state };
  if (prompt !== '') rows.prompt = prompt;
  if (notice !== '') rows.notice = notice;
  if (dialogueState.active) {
    rows.speaker = speaker;
    rows.say = say;
    // The question itself is already in `say`; these are the two keys.
    if (phase === PHASE_QUESTION) {
      rows['1'] = 'yes';
      rows['2'] = 'no';
    } else {
      rows.more = 'E to continue';
    }
  }

  who.hud.set({ text: rows, crosshair: false, message });
}
