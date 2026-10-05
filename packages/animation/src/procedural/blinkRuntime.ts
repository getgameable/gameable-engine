// Ported from aos-threejs-poc/src/lib/blinkRuntime.js @ cdd63b10
/**
 * blinkRuntime — procedural blink controller.
 *
 * Overlays a blink envelope on the ARKit blink channels (`EyeBlinkLeft` = 0,
 * `EyeBlinkRight` = 7) after the face clips have been blended, so a clip that
 * already holds the eyes half-closed is added to rather than replaced.
 *
 * Two changes from the POC. The module singleton is gone — it made two
 * characters in one scene share one blink phase, and it made the scheduler
 * un-resettable between tests — so this is a factory. And `performance.now()`
 * is injected as `now()`, which is what makes the envelope deterministic under
 * a fake clock.
 *
 * Defaults match Unreal's DynamicBlinkSM timing.
 */
import { ARKIT_EYE_BLINK_LEFT, ARKIT_EYE_BLINK_RIGHT } from '../face/arkitNames';
import { type Clock, defaultClock } from '../clock';

/** Blink scheduler and envelope shape. */
export interface BlinkConfig {
  /** Shortest gap between blinks, in seconds. */
  minInterval: number;
  /** Longest gap between blinks, in seconds. */
  maxInterval: number;
  /** Lid close ramp, in milliseconds. */
  closeMs: number;
  /** Fully-closed hold, in milliseconds. */
  holdMs: number;
  /** Lid open ramp, in milliseconds. */
  openMs: number;
}

/** The Unreal DynamicBlinkSM timings the POC shipped with. */
export const BLINK_DEFAULTS: Readonly<BlinkConfig> = Object.freeze({
  minInterval: 2.0,
  maxInterval: 6.0,
  closeMs: 80,
  holdMs: 40,
  openMs: 100,
});

/** A live procedural-blink channel. */
export interface BlinkRuntime {
  /** The timings currently in force. */
  readonly config: Readonly<BlinkConfig>;
  /**
   * Replace the timings.
   *
   * Last-writer-wins, and a PARTIAL patch falls back to the defaults for the
   * fields it omits rather than to the previous write — the graph node that
   * drives this re-sends its whole node data every frame, so "keep the previous
   * value" would make a field that was cleared in the editor stick forever.
   *
   * @param patch Fields to set; omitted fields revert to {@link BLINK_DEFAULTS}.
   */
  setConfig(patch: Partial<BlinkConfig>): void;
  /**
   * The current blink weight, advancing the scheduler.
   *
   * Call at most once per frame — it advances blink timing.
   *
   * @param gate Sentinel weight from the caller; 0 disables the channel.
   *
   * @returns The envelope value times `gate`, in `[0, 1]`.
   */
  currentWeight(gate?: number): number;
  /**
   * Advance the scheduler and add the blink onto an ARKit-52 weight vector.
   *
   * @param out ARKit-52 weight vector, written in place and clamped to 1.
   * @param gate Sentinel weight from the caller; 0 disables the channel.
   *
   * @returns The blink weight that was applied.
   */
  applyToArkit(out: Float32Array, gate?: number): number;
  /** Clear the in-flight blink and reschedule; used when a character is swapped. */
  reset(): void;
}

/** Options for {@link createBlinkRuntime}. */
export interface BlinkRuntimeOptions {
  /** Millisecond clock; defaults to {@link defaultClock}. */
  now?: Clock;
  /** Uniform `[0, 1)` source for the inter-blink delay; defaults to `Math.random`. */
  random?: () => number;
  /** Initial timings; omitted fields take their {@link BLINK_DEFAULTS} value. */
  config?: Partial<BlinkConfig>;
}

/**
 * Create a procedural blink channel.
 *
 * @param options See {@link BlinkRuntimeOptions}.
 *
 * @returns A {@link BlinkRuntime} owning its own phase and scheduler.
 */
export function createBlinkRuntime(options: BlinkRuntimeOptions = {}): BlinkRuntime {
  const now = options.now ?? defaultClock;
  const random = options.random ?? Math.random;

  const config: BlinkConfig = {
    minInterval: options.config?.minInterval ?? BLINK_DEFAULTS.minInterval,
    maxInterval: options.config?.maxInterval ?? BLINK_DEFAULTS.maxInterval,
    closeMs: options.config?.closeMs ?? BLINK_DEFAULTS.closeMs,
    holdMs: options.config?.holdMs ?? BLINK_DEFAULTS.holdMs,
    openMs: options.config?.openMs ?? BLINK_DEFAULTS.openMs,
  };

  /**
   * Draw the next inter-blink delay.
   *
   * @returns Milliseconds until the next blink starts.
   */
  function randomDelay(): number {
    return (config.minInterval + random() * (config.maxInterval - config.minInterval)) * 1000;
  }

  // `blinking` is a flag rather than a `blinkStart === 0` sentinel: an injected
  // clock legitimately starts at 0, and the POC's sentinel made the first blink
  // of a run silently never fire under one.
  let blinking = false;
  let blinkStart = 0;
  let nextBlinkAt = now() + randomDelay();

  /**
   * The close / hold / open envelope.
   *
   * @param elapsed Milliseconds since the blink started.
   *
   * @returns The envelope value in `[0, 1]`.
   */
  function envelope(elapsed: number): number {
    const { closeMs, holdMs, openMs } = config;
    if (elapsed < closeMs) return elapsed / closeMs;
    if (elapsed < closeMs + holdMs) return 1;
    const totalMs = closeMs + holdMs + openMs;
    if (elapsed < totalMs) return 1 - (elapsed - closeMs - holdMs) / openMs;
    return 0;
  }

  /**
   * Advance the scheduler and read the current weight.
   *
   * @param gate Sentinel weight from the caller.
   *
   * @returns The envelope value times `gate`.
   */
  function currentWeight(gate = 1): number {
    if (gate <= 0) return 0;
    const t = now();
    if (!blinking && t >= nextBlinkAt) {
      blinking = true;
      blinkStart = t;
    }
    if (!blinking) return 0;
    const elapsed = t - blinkStart;
    const totalMs = config.closeMs + config.holdMs + config.openMs;
    if (elapsed >= totalMs) {
      blinking = false;
      nextBlinkAt = t + randomDelay();
      return 0;
    }
    return envelope(elapsed) * gate;
  }

  return {
    get config(): Readonly<BlinkConfig> {
      return config;
    },
    setConfig(patch: Partial<BlinkConfig>): void {
      config.minInterval = patch.minInterval ?? BLINK_DEFAULTS.minInterval;
      config.maxInterval = patch.maxInterval ?? BLINK_DEFAULTS.maxInterval;
      config.closeMs = patch.closeMs ?? BLINK_DEFAULTS.closeMs;
      config.holdMs = patch.holdMs ?? BLINK_DEFAULTS.holdMs;
      config.openMs = patch.openMs ?? BLINK_DEFAULTS.openMs;
    },
    currentWeight,
    applyToArkit(out: Float32Array, gate = 1): number {
      const w = currentWeight(gate);
      if (w <= 0) return 0;
      out[ARKIT_EYE_BLINK_LEFT] = Math.min(1, out[ARKIT_EYE_BLINK_LEFT] + w);
      out[ARKIT_EYE_BLINK_RIGHT] = Math.min(1, out[ARKIT_EYE_BLINK_RIGHT] + w);
      return w;
    },
    reset(): void {
      blinking = false;
      blinkStart = 0;
      nextBlinkAt = now() + randomDelay();
    },
  };
}
