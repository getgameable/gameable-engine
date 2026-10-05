// Ported from aos-threejs-poc/src/lib/GestureChannel.js @ cdd63b10
/**
 * GestureChannel — one-shot body-gesture layer.
 *
 * Plays a single body clip on top of whatever the base layer is driving, with a
 * short fade-in, hold, and fade-out. Used to layer gestures like "lean in",
 * "laugh", "sigh" onto the current locomotion / state-machine pose while the
 * face layer keeps running.
 *
 * Lifecycle per gesture:
 *
 * ```text
 * t = 0 ............... play() called, start = now
 * 0 .. fadeInMs ....... weight ramps 0 -> peakWeight
 * fadeInMs .. fadeOutFrom .. weight held at peakWeight
 * fadeOutFrom .. totalMs .. weight ramps peakWeight -> 0
 * t > totalMs ......... channel cleared; the action gets a final weight 0 + stop()
 * ```
 *
 * `apply(actions)` runs every frame AFTER the base layer's weight loop and
 * BEFORE `mixer.update(dt)`, so the gesture weight is not overwritten by the
 * base layer's per-frame weight reset. Only the WEIGHT is written every frame:
 * the blend mode, loop style and clamp flag are set on the frame the gesture
 * reaches its action and the blend mode is restored when the envelope ends.
 *
 * Three POC couplings are gone: the module singleton (one gesture per
 * character, not one per page), the `bodyClipLoader` JIT request (loading is
 * the caller's problem now — a clip is either registered or it is not), and the
 * `window.__DIRECT_PLAY__` probe, which is now the explicit
 * {@link GestureChannel.setExclusiveOverride} seam.
 */
import { type Clock, defaultClock } from '../clock';

/**
 * three's `AdditiveAnimationBlendMode`, as a number.
 *
 * Kept numeric rather than imported so this module stays three-free and can be
 * unit-tested against fake actions. The value is pinned by three's public enum.
 */
export const ADDITIVE_BLEND_MODE = 2501;

/** three's `LoopOnce`, as a number, for the same reason. */
export const LOOP_ONCE = 2200;

/** Default peak weight of a gesture over the base pose. */
const DEFAULT_PEAK_WEIGHT = 0.7;

/** Default fade-in and fade-out, in milliseconds. */
const DEFAULT_FADE_MS = 250;

/** The subset of three's `AnimationAction` the gesture channel drives. */
export interface GestureActionLike {
  /** Blend mode; set to {@link ADDITIVE_BLEND_MODE} while a gesture plays. */
  blendMode: number;
  /** Current loop style, if the implementation exposes one. */
  loop?: number;
  /** Whether the action holds its last frame when it finishes. */
  clampWhenFinished: boolean;
  /**
   * Set the loop style.
   *
   * @param mode Loop style, e.g. {@link LOOP_ONCE}.
   * @param count Repetition count.
   */
  setLoop(mode: number, count: number): void;
  /**
   * Set the effective blend weight.
   *
   * @param weight Weight in `[0, 1]`.
   */
  setEffectiveWeight(weight: number): void;
  /** @returns Whether the action is currently scheduled on the mixer. */
  isRunning(): boolean;
  /** Schedule the action on the mixer. */
  play(): void;
  /** Remove the action from the mixer. */
  stop(): void;
  /** Rewind the action to its start. */
  reset(): unknown;
}

/** Envelope overrides for a single gesture. */
export interface GestureOptions {
  /** Total envelope length, in milliseconds. */
  durationMs?: number;
  /** Weight held between the fades. */
  peakWeight?: number;
  /** Fade-in, in milliseconds. */
  fadeInMs?: number;
  /** Fade-out, in milliseconds. */
  fadeOutMs?: number;
}

/** A one-slot additive gesture layer. */
export interface GestureChannel {
  /**
   * Start a gesture, replacing whatever was in flight.
   *
   * @param clipName Name the clip was registered under.
   * @param options Envelope overrides; see {@link GestureOptions}.
   *
   * @returns Whether the gesture started; `false` when it was suppressed.
   */
  play(clipName: string, options?: GestureOptions): boolean;
  /**
   * Clear the channel, leaving the action's weight alone.
   *
   * The one thing it does write back is the blend mode, if this channel had
   * converted the action to additive — otherwise a borrowed base clip would
   * stay additive forever.
   */
  stop(): void;
  /** @returns Whether a gesture envelope is in flight. */
  isActive(): boolean;
  /** @returns The clip name of the in-flight gesture, or null. */
  activeClip(): string | null;
  /**
   * Declare that an exclusive body override owns the skeleton.
   *
   * A conversational override — generated locomotion, or a
   * performance-classified generated clip — already owns the skeleton
   * exclusively. The base layer zeroes any additive gesture weight while it is
   * active anyway, but STARTING a new envelope under one would leave it primed
   * to pop back in for the tail of its fade-out once the override releases.
   * So `play()` is suppressed while this is set. Dev/test one-shots (a prefab
   * Test button, a clip preview) must NOT set it, which is why this is an
   * explicit opt-in rather than "any clip is playing".
   *
   * @param active Whether an exclusive override currently owns the skeleton.
   */
  setExclusiveOverride(active: boolean): void;
  /**
   * Advance the envelope and write the gesture weight onto its action.
   *
   * @param actions Registered actions by clip name.
   */
  apply(actions: ReadonlyMap<string, GestureActionLike>): void;
}

/** Options for {@link createGestureChannel}. */
export interface GestureChannelOptions {
  /** Millisecond clock; defaults to {@link defaultClock}. */
  now?: Clock;
}

/** The in-flight gesture envelope. */
interface ActiveGesture {
  clipName: string;
  startTime: number;
  fadeInUntil: number;
  fadeOutFrom: number;
  endTime: number;
  peakWeight: number;
  /** The action once it has been resolved, so the blend mode can be restored. */
  action: GestureActionLike | null;
  /** The action's blend mode before this gesture converted it to additive. */
  previousBlendMode: number;
}

/**
 * Create a one-slot additive gesture channel.
 *
 * @param options See {@link GestureChannelOptions}.
 *
 * @returns A {@link GestureChannel}.
 */
export function createGestureChannel(options: GestureChannelOptions = {}): GestureChannel {
  const now = options.now ?? defaultClock;

  let active: ActiveGesture | null = null;
  let exclusiveOverride = false;

  /**
   * Put an action back the way the gesture found it.
   *
   * Only the blend mode is restored: a clip registered on the base layer that
   * a gesture borrowed would otherwise stay ADDITIVE for the rest of the
   * session, which reads as the character slowly deflating. Loop style and the
   * clamp flag are re-asserted by `applyWeights` on the base layer every frame
   * they matter, so they need no restore here.
   *
   * @param gesture The gesture that borrowed the action.
   */
  function restore(gesture: ActiveGesture): void {
    if (gesture.action === null) return;
    gesture.action.blendMode = gesture.previousBlendMode;
    gesture.action = null;
  }

  return {
    play(clipName: string, gestureOptions: GestureOptions = {}): boolean {
      if (clipName === '') return false;
      if (exclusiveOverride) return false;
      // Replacing an in-flight gesture: hand its action back before losing the
      // reference to it.
      if (active !== null) restore(active);

      const durationMs = gestureOptions.durationMs ?? 3000;
      const peakWeight = gestureOptions.peakWeight ?? DEFAULT_PEAK_WEIGHT;
      const fadeInMs = gestureOptions.fadeInMs ?? DEFAULT_FADE_MS;
      const fadeOutMs = gestureOptions.fadeOutMs ?? DEFAULT_FADE_MS;

      const t = now();
      active = {
        clipName,
        startTime: t,
        fadeInUntil: t + fadeInMs,
        fadeOutFrom: t + Math.max(fadeInMs, durationMs - fadeOutMs),
        endTime: t + durationMs,
        peakWeight,
        action: null,
        previousBlendMode: 0,
      };
      return true;
    },

    stop(): void {
      if (active !== null) restore(active);
      active = null;
    },

    isActive(): boolean {
      return active !== null;
    },

    activeClip(): string | null {
      return active === null ? null : active.clipName;
    },

    setExclusiveOverride(value: boolean): void {
      exclusiveOverride = value;
    },

    apply(actions: ReadonlyMap<string, GestureActionLike>): void {
      const a = active;
      if (a === null) return;
      const t = now();
      const action = actions.get(a.clipName);
      if (action === undefined) {
        // The clip is not registered on the mixer. Keep the channel alive in
        // case it lands mid-envelope; only give up once the envelope has
        // elapsed, at which point playing it would be pointless. An action that
        // was borrowed and has since been unregistered still gets its blend
        // mode back.
        if (t >= a.endTime) {
          restore(a);
          active = null;
        }
        return;
      }

      if (t >= a.endTime) {
        // Finished — zero it, hand the action back and clear the channel.
        if (action.isRunning()) action.stop();
        action.setEffectiveWeight(0);
        restore(a);
        active = null;
        return;
      }

      let weight: number;
      if (t < a.fadeInUntil) {
        weight = a.peakWeight * ((t - a.startTime) / (a.fadeInUntil - a.startTime));
      } else if (t < a.fadeOutFrom) {
        weight = a.peakWeight;
      } else {
        weight = a.peakWeight * (1 - (t - a.fadeOutFrom) / (a.endTime - a.fadeOutFrom));
      }

      // The gesture plays additively over the base state so the underlying base
      // clip still drives the resting pose; the gesture layers limb motion on
      // top. LoopOnce so it plays through exactly once over its duration.
      //
      // Written ONCE, on the frame this gesture first reaches its action, not
      // every frame: `setLoop` on a running action resets its loop counter and
      // its clamp state, which is the same steady-state rule `applyWeights`
      // documents for the base layer. The previous blend mode is remembered so
      // a base clip borrowed for a gesture is handed back unchanged.
      if (a.action !== action) {
        // A re-registered clip can hand back a different action object; give
        // the old one its blend mode back before adopting the new one.
        restore(a);
        a.action = action;
        a.previousBlendMode = action.blendMode;
        action.blendMode = ADDITIVE_BLEND_MODE;
        action.setLoop(LOOP_ONCE, 1);
        action.clampWhenFinished = true;
      }
      action.setEffectiveWeight(weight);
      if (!action.isRunning()) {
        action.reset();
        action.play();
      }
    },
  };
}
