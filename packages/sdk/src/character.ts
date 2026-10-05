/**
 * The splat-character facade.
 *
 * A character is an entity with a `Character` component and a bundle asset.
 * The guest never touches vertices or blendshapes: it states intent
 * (`'run'`, look at this point, say this line) and the host's animator and rig
 * backend do the work.
 */
import { Character } from './ecs';
import { assetId } from './assets';
import { requireRuntime } from './state';
import type { ExpressionSpace, Vec3 } from './types';

/** Coefficient counts each expression space expects. */
export const EXPRESSION_DIMS: Readonly<Record<ExpressionSpace, number>> = Object.freeze({
  arkit52: 52,
  gnm: 387,
  gnm68: 68,
});

/**
 * The character facade.
 *
 * @example
 * ```ts
 * import { character } from 'gameable';
 *
 * character.setState(npc, 'walk', 0, 0, 1.4, true);
 * character.lookAt(npc, { x: 0, y: 1.6, z: 0 });
 * ```
 */
export const character = {
  /**
   * Drive the locomotion state machine.
   *
   * @param entity Entity with a `Character` component.
   * @param state State name, for example `'idle' | 'walk' | 'run'`.
   * @param vx World-space velocity x, drives the locomotion blend.
   * @param vy World-space velocity y.
   * @param vz World-space velocity z.
   * @param grounded Whether the character is on the ground.
   * @returns Nothing.
   */
  setState(
    entity: number,
    state: string,
    vx: number,
    vy: number,
    vz: number,
    grounded = true,
  ): void {
    requireRuntime().commands.setCharacterState(entity, state, vx, vy, vz, grounded);
  },

  /**
   * Set explicit per-clip weights on the body layer.
   *
   * @param entity Entity with a `Character` component.
   * @param clips Clip names.
   * @param weights Positional weights; must be the same length as `clips`.
   * @param timeScale Playback rate for the whole layer. Default 1.
   * @returns Nothing.
   */
  setClipWeights(
    entity: number,
    clips: readonly string[],
    weights: readonly number[] | Float32Array,
    timeScale = 1,
  ): void {
    requireRuntime().commands.setClipWeights(entity, clips, weights, timeScale);
  },

  /**
   * Set facial expression coefficients.
   *
   * @param entity Entity with a `Character` component.
   * @param space Coordinate space: 52 ARKit, 387 GNM, or the 68-float view.
   * @param weights Coefficients; length must match the space.
   * @returns Nothing.
   */
  setExpression(
    entity: number,
    space: ExpressionSpace,
    weights: readonly number[] | Float32Array,
  ): void {
    const rt = requireRuntime();
    const expected = EXPRESSION_DIMS[space];
    if (weights.length !== expected) {
      rt.host.log(
        'warn',
        `setExpression(${String(entity)}, '${space}') expects ${String(expected)} weights, got ${String(weights.length)}`,
      );
      return;
    }
    rt.commands.setExpression(entity, space, weights);
  },

  /**
   * Aim the head and eyes at a world point.
   *
   * @param entity Entity with a `Character` component.
   * @param target The point, or `null` to release and return to the idle.
   * @param weight Blend weight in 0..1. Default 1.
   * @returns Nothing.
   */
  lookAt(entity: number, target: Vec3 | null, weight = 1): void {
    requireRuntime().commands.lookAt(entity, target, weight);
  },

  /**
   * Speak a line.
   *
   * @param entity Entity with a `Character` component.
   * @param text Subtitle text; the host decides whether to show it.
   * @param voice Manifest string id or handle of a voice line.
   * @param visemes Viseme track as JSON, matching the bundle's space.
   * @returns Nothing.
   */
  say(entity: number, text: string, voice?: string | number, visemes?: string): void {
    const rt = requireRuntime();
    const id = typeof voice === 'string' ? assetId(voice) : voice;
    rt.commands.say(entity, text, id, visemes);
  },

  /**
   * The character bundle handle attached to an entity, or 0.
   *
   * @param entity Entity id.
   * @returns The bundle asset handle.
   */
  bundleOf(entity: number): number {
    return Character.bundle[entity] ?? 0;
  },
};
