// Ported from aos-threejs-poc/packages/avataros-character-runtime/src/applyWeights.js @ cdd63b10
/**
 * applyWeights — push evaluated clip weights onto mixer actions.
 *
 * Normal-blend path only. The additive/gesture path lives in the gesture
 * channel and runs after this, which is why this function is free to zero every
 * action it is not driving.
 *
 * three's loop constants are passed in as plain numbers rather than imported,
 * so this module stays three-free and can be unit-tested against fake actions.
 */

/** The subset of three's `AnimationAction` the base layer drives. */
export interface WeightedActionLike {
  /** Current loop style, if the implementation exposes one. */
  loop?: number;
  /** Whether the action holds its last frame when it finishes. */
  clampWhenFinished: boolean;
  /** Playback rate. */
  timeScale: number;
  /**
   * Set the loop style.
   *
   * @param mode Loop style.
   * @param count Repetition count.
   */
  setLoop(mode: number, count: number): void;
  /**
   * Set the effective blend weight.
   *
   * @param weight Weight in `[0, 1]`.
   */
  setEffectiveWeight(weight: number): void;
  /** @returns Whether the action is actively playing (not a paused final pose). */
  isRunning(): boolean;
  /** Scheduled includes a paused one-shot holding its final pose. */
  isScheduled?(): boolean;
  /** Schedule the action on the mixer. */
  play(): void;
  /** Remove the action from the mixer. */
  stop(): void;
}

/** three's loop constants, overridable so this module needs no three import. */
export interface LoopConstants {
  /** three's `LoopRepeat`. */
  loopRepeat?: number;
  /** three's `LoopOnce`. */
  loopOnce?: number;
}

/**
 * Apply evaluated weights to a set of mixer actions.
 *
 * Every action absent from `weights`, or at weight <= 0, is stopped (or zeroed
 * if it was not running). Present actions get their loop style, clamp flag and
 * time scale written ONLY when they change — the steady-state optimisation the
 * POC's GraphEvaluator carried, because `setLoop` on a running action resets
 * its loop counter and a per-frame write made long non-looping clips restart.
 *
 * @param weights Clip name to weight, or null to stop everything.
 * @param loop Clip name to loop flag; a missing entry means "loop".
 * @param speed Clip name to time scale; a missing entry means 1.
 * @param actions Registered actions by clip name.
 * @param constants three's loop constants; defaults match three r186.
 */
export function applyWeights(
  weights: ReadonlyMap<string, number> | null,
  loop: ReadonlyMap<string, boolean> | null,
  speed: ReadonlyMap<string, number> | null,
  actions: ReadonlyMap<string, WeightedActionLike>,
  constants: LoopConstants = {},
): void {
  const loopRepeat = constants.loopRepeat ?? 2201;
  const loopOnce = constants.loopOnce ?? 2200;

  for (const [clipName, action] of actions) {
    const w = weights?.get(clipName) ?? 0;
    if (w <= 0) {
      if (action.isRunning() || action.isScheduled?.() === true) action.stop();
      else action.setEffectiveWeight(0);
    }
  }

  if (weights === null) return;

  for (const [clipName, weight] of weights) {
    if (weight <= 0) continue;
    const action = actions.get(clipName);
    if (action === undefined) continue;

    const shouldLoop = loop?.get(clipName) !== false;
    const wantLoop = shouldLoop ? loopRepeat : loopOnce;
    if (action.loop !== wantLoop) action.setLoop(wantLoop, shouldLoop ? Infinity : 1);

    const wantClamp = !shouldLoop;
    if (action.clampWhenFinished !== wantClamp) action.clampWhenFinished = wantClamp;

    const wantSpeed = speed?.get(clipName) ?? 1;
    if (action.timeScale !== wantSpeed) action.timeScale = wantSpeed;

    action.setEffectiveWeight(weight);
    if (!action.isRunning()) action.play();
  }
}
