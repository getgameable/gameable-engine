/**
 * What people say and the faces they say it with: the scripts from
 * `src/dialogue.json`, their phases and the expression presets. Data only;
 * `./dialogue.ts` walks it.
 */
import scriptDocument from '../dialogue.json';

/** Number of ARKit blendshape channels. The only length `arkit52` accepts. */
const ARKIT_COUNT = 52;

/** One thing somebody says. */
export interface DialogueLine {
  /** The words. */
  readonly text: string;
  /** Which entry of {@link FACES} the speaker wears while saying it. */
  readonly face: string;
}

/** A yes/no branch at the end of a script. */
export interface DialogueQuestion extends DialogueLine {
  /** What answering `1` gets you. */
  readonly yes: DialogueLine;
  /** What answering `2` gets you. */
  readonly no: DialogueLine;
}

/** One conversation. */
export interface DialogueScript {
  /** Name shown above the box. */
  readonly speaker: string;
  /** Said in order, one `E` press each. */
  readonly lines: readonly DialogueLine[];
  /** Optional branch, offered once the lines run out. */
  readonly question?: DialogueQuestion;
}

/**
 * Every script, keyed by name.
 *
 * The cast is deliberate and is the only one in this template. A JSON import is
 * structurally typed by the compiler from the file's literal contents, so one
 * script having a `question` and another not having one makes the two shapes
 * incompatible. Declaring the contract above and asserting it once here is
 * honest about where the boundary is — and `tests/game.test.ts` checks that the
 * file really does match.
 */
export const scripts = scriptDocument as unknown as Readonly<Record<string, DialogueScript>>;

/** Nobody is talking. */
export const PHASE_IDLE = 0;
/** Working through `lines`. */
export const PHASE_LINES = 1;
/** The question is on screen and `1` / `2` are live. */
export const PHASE_QUESTION = 2;
/** The answer to the question is on screen. */
export const PHASE_ANSWER = 3;

/**
 * Build one ARKit-52 expression vector.
 *
 * @param weights Channel index to weight; every other channel is 0.
 * @returns A 52-float vector.
 */
function expression(weights: Readonly<Record<number, number>>): Float32Array {
  const out = new Float32Array(ARKIT_COUNT);
  for (const key of Object.keys(weights)) {
    const index = Number(key);
    out[index] = weights[index] ?? 0;
  }
  return out;
}

/**
 * The expression presets, by name.
 *
 * Two of them, because two is what a template needs to show the shape. The
 * indices are ARKit's own channel order — `ARKIT_NAMES` in
 * `gameable/animation` is the canonical list — and the vectors are built once
 * at module scope, never per frame.
 */
export const FACES: Readonly<Record<string, Float32Array>> = {
  /** Resting face: every channel zero. */
  neutral: expression({}),
  /** A smile: mouth corners, a little cheek, a little eye. */
  smile: expression({ 5: 0.2, 12: 0.2, 23: 0.7, 24: 0.7, 47: 0.35, 48: 0.35 }),
};
