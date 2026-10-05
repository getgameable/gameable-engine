/**
 * Talking to people.
 *
 * A conversation is data: `src/dialogue.json` holds one entry per script, and
 * this system walks it. Lines advance on `E`; a script that ends in a
 * `question` offers two answers on `1` and `2`. Nothing here knows what the
 * lines say, which is the point — adding an NPC with something new to say is an
 * entry in that file and a prefab, and no change to this system.
 *
 * While a conversation is running `dialogueState.active` is true, and
 * `src/systems/locomotion.ts` reads it and stops driving the hero. You cannot
 * walk away mid-sentence.
 *
 * In a room every player has their own conversation (`dialogueOf(player)`;
 * `dialogueState` is seat 0's), advanced by their own keys, and only the one
 * talking is held still.
 *
 * Two commands go out that nothing draws yet. `character.lookAt` turns the
 * speaker's head and eyes towards the hero, and `character.setExpression`
 * hands it an ARKit-52 vector. `gameable/character` has not landed, so the
 * host warns once and the NPC stays a capsule — but the commands are real, they
 * are asserted in `tests/game.test.ts`, and nothing in this file changes when
 * the rig arrives.
 */
import { Transform, character, hasComponent, type GameContext } from 'gameable';

import { Guide } from '../prefabs';
import { eachActor, type Actor } from './actors';
import {
  FACES,
  PHASE_ANSWER,
  PHASE_IDLE,
  PHASE_LINES,
  PHASE_QUESTION,
  scripts,
  type DialogueLine,
} from './dialogueData';
import { SeatStore } from './seats';

export {
  FACES,
  PHASE_ANSWER,
  PHASE_IDLE,
  PHASE_LINES,
  PHASE_QUESTION,
  scripts,
  type DialogueLine,
  type DialogueQuestion,
  type DialogueScript,
} from './dialogueData';

/** How far above the hero capsule's origin an NPC aims its gaze, metres. */
const HERO_HEAD_OFFSET = 0.45;

/** Everything the conversation system remembers between frames, for one player. */
export interface DialogueState {
  active: boolean;
  npc: number;
  script: string;
  phase: number;
  line: number;
  speaker: string;
  text: string;
  answer: string;
  startedOn: number;
}

/** The single player's conversation (seat 0's in a room). */
export const dialogueState: DialogueState = {
  /** True while somebody is talking. `locomotion` reads this and freezes. */
  active: false,
  /** The NPC doing the talking, or 0. */
  npc: 0,
  /** Which script, by key in `src/dialogue.json`. */
  script: '',
  /** One of the `PHASE_*` constants. */
  phase: PHASE_IDLE,
  /** Index into `lines` while `phase` is `PHASE_LINES`. */
  line: 0,
  /** Name to draw above the box. */
  speaker: '',
  /** The words currently on screen. */
  text: '',
  /** Which answer was taken: `''`, `'yes'` or `'no'`. */
  answer: '',
  /** The frame the conversation started on, so one `E` cannot do two things. */
  startedOn: -1,
};

/** Reused look-at target: a system must not allocate. */
const gaze = { x: 0, y: 0, z: 0 };

/**
 * @param state One player's conversation.
 */
function clearDialogue(state: DialogueState): void {
  state.active = false;
  state.npc = 0;
  state.script = '';
  state.phase = PHASE_IDLE;
  state.line = 0;
  state.speaker = '';
  state.text = '';
  state.answer = '';
  state.startedOn = -1;
}

/** Every player's conversation; seat 0's is {@link dialogueState}. */
const dialogues = new SeatStore<DialogueState>(
  dialogueState,
  () => ({ ...dialogueState, active: false, npc: 0, phase: PHASE_IDLE, startedOn: -1 }),
  clearDialogue,
);

/**
 * End every conversation. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetDialogue(): void {
  dialogues.reset();
}

/**
 * A player's conversation, for the HUD and locomotion.
 *
 * @param player A player id; 0 is the single player.
 * @returns Their state, or undefined before they first did anything.
 */
export function dialogueOf(player: number): DialogueState | undefined {
  return dialogues.get(player);
}

/**
 * @param who A player.
 * @returns Their conversation.
 */
export function dialogueFor(who: Actor): DialogueState {
  return dialogues.of(who);
}

/**
 * Which script an NPC runs.
 *
 * @param ctx The frame context.
 * @param npc The NPC entity.
 * @returns A key into {@link scripts}.
 */
export function scriptOf(ctx: GameContext, npc: number): string {
  // `hasComponent` is bitecs', re-exported by the SDK: a bitmask test, not a
  // search. An NPC without the `Guide` tag is the wanderer.
  return hasComponent(ctx.world, npc, Guide) ? 'guide' : 'wanderer';
}

/**
 * Start a conversation. Called by `src/systems/interact.ts`.
 *
 * @param ctx The frame context.
 * @param npc The NPC to talk to.
 * @param state Whose conversation: the single player's by default.
 * @param hero Who the NPC looks at.
 * @returns Nothing.
 */
export function beginDialogue(
  ctx: GameContext,
  npc: number,
  state: DialogueState = dialogueState,
  hero: number = ctx.player,
): void {
  const key = scriptOf(ctx, npc);
  const script = scripts[key];
  if (script === undefined) return;

  state.active = true;
  state.npc = npc;
  state.script = key;
  state.phase = PHASE_LINES;
  state.line = 0;
  state.speaker = script.speaker;
  state.answer = '';
  state.startedOn = ctx.frame;
  show(state, script.lines[0], hero);
  ctx.audio.play('sfx.talk', { entity: npc, volume: 0.4 });
}

/**
 * Put a line on screen and set the speaker's face and gaze.
 *
 * @param state Whose conversation.
 * @param line The line, or undefined for an empty box.
 * @param hero Who is listening.
 * @returns Nothing.
 */
function show(state: DialogueState, line: DialogueLine | undefined, hero: number): void {
  state.text = line?.text ?? '';
  const npc = state.npc;
  if (npc === 0) return;

  const face = FACES[line?.face ?? 'neutral'] ?? FACES.neutral;
  character.setExpression(npc, 'arkit52', face);

  // Look the hero in the eye. The hero is frozen while this runs, so aiming
  // once per line is aiming continuously.
  gaze.x = Transform.x[hero] ?? 0;
  // The capsule's origin is its centre; the head is a little above that.
  gaze.y = (Transform.y[hero] ?? 0) + HERO_HEAD_OFFSET;
  gaze.z = Transform.z[hero] ?? 0;
  character.lookAt(npc, gaze, 1);
}

/**
 * Stop talking: release the speaker's head and drop its expression.
 *
 * @param state Whose conversation: the single player's by default.
 * @returns Nothing.
 */
export function endDialogue(state: DialogueState = dialogueState): void {
  const npc = state.npc;
  if (npc !== 0) {
    character.setExpression(npc, 'arkit52', FACES.neutral);
    character.lookAt(npc, null, 0);
  }
  state.active = false;
  state.npc = 0;
  state.phase = PHASE_IDLE;
  state.text = '';
  state.speaker = '';
}

/**
 * Advance one player's conversation, from their own keys.
 *
 * @param ctx The frame context.
 * @param who The player.
 * @returns Nothing.
 */
function advance(ctx: GameContext, who: Actor): void {
  const state = dialogues.of(who);
  if (!state.active) return;
  // `interact` consumed this frame's `E` to start the conversation; one press
  // must not also skip the first line.
  if (state.startedOn === ctx.frame) return;

  const script = scripts[state.script];
  if (script === undefined) {
    endDialogue(state);
    return;
  }

  if (state.phase === PHASE_QUESTION) {
    const question = script.question;
    if (question === undefined) {
      endDialogue(state);
      return;
    }
    if (who.input.pressed('1')) {
      state.answer = 'yes';
      state.phase = PHASE_ANSWER;
      show(state, question.yes, who.entity);
    } else if (who.input.pressed('2')) {
      state.answer = 'no';
      state.phase = PHASE_ANSWER;
      show(state, question.no, who.entity);
    }
    return;
  }

  if (!who.input.pressed('E')) return;

  if (state.phase === PHASE_ANSWER) {
    endDialogue(state);
    return;
  }

  const next = state.line + 1;
  if (next < script.lines.length) {
    state.line = next;
    show(state, script.lines[next], who.entity);
    return;
  }
  if (script.question !== undefined) {
    state.phase = PHASE_QUESTION;
    show(state, script.question, who.entity);
    return;
  }
  endDialogue(state);
}

/**
 * Advance every conversation that is running, each from its player's keys.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function dialogueSystem(ctx: GameContext): void {
  eachActor(ctx, advance);
}
