// Ported from aos-threejs-poc/src/lib/FaceClipPlayer.js @ cdd63b10
/**
 * faceClipPlayer — the frame-blending core of the POC's FaceClipPlayer.
 *
 * A face clip is per-frame ARKit-52 blendshape weights. Given a set of
 * `{ clipName: weight }` drives, this returns the blended 52-element ARKit
 * vector for the current time.
 *
 * Everything around the blender is gone: the asset-manager fetches, the gesture
 * tag table, the retrying network loader and the `window.__FACE_CLIP_PLAYER__`
 * hook. Clips are handed in with {@link FaceClipPlayer.addFaceClip}; the engine
 * decides where the JSON came from.
 *
 * Frames are normalised into flat typed arrays on add rather than kept as an
 * array of objects, so the hot loop indexes two `Float32Array`s instead of
 * chasing one object per frame. The blend itself is the POC's, including the
 * details that cost real debugging:
 *
 *  - playback is wall-clock from the moment a clip first goes non-zero, not a
 *    per-frame accumulator, so two clips at the same weight stay in phase;
 *  - the frame cursor walks FORWARD from the last frame index and only resets
 *    when time wraps, which is what keeps a 600-frame clip off an O(n) scan;
 *  - frames are interpolated, especially across the loop boundary where the
 *    raw values can jump;
 *  - a clip whose weight drops to zero is stopped, so it restarts from frame 0
 *    next time rather than resuming mid-expression.
 */
import { type Clock, defaultClock } from '../clock';
import { ARKIT_COUNT } from './arkitNames';

/** One authored frame of a face clip. */
export interface FaceClipFrame {
  /** Seconds from the clip start. Defaults to `index / fps` when omitted. */
  timeCode?: number;
  /** ARKit-52 weights for this frame; shorter arrays are zero-padded. */
  blendshapeWeights: ArrayLike<number>;
}

/** A face clip as authored: `{ fps, frames }`. */
export interface FaceClipData {
  /** Sample rate, used only to synthesise `timeCode` when frames omit it. */
  fps?: number;
  /** Frames in time order. */
  frames: readonly FaceClipFrame[];
}

/** A live face-clip blender. */
export interface FaceClipPlayer {
  /**
   * Register a face clip.
   *
   * @param name Runtime key the drive weights address it by.
   * @param clip The clip data; see {@link FaceClipData}.
   */
  addFaceClip(name: string, clip: FaceClipData): void;
  /**
   * @param name Runtime key.
   *
   * @returns Whether a clip is registered under `name`.
   */
  hasClip(name: string): boolean;
  /**
   * Point a second key at an already-registered clip — no copy.
   *
   * Frame data is SHARED, unlike a body-clip alias, which has to clone because
   * three caches one action per clip object. Face clips are read-only weight
   * tables with no per-clip playback state on them (that lives per key), so two
   * keys over one table is correct here and costs nothing.
   *
   * @param alias The new key.
   * @param sourceName The key that already resolves.
   *
   * @returns Whether `alias` now resolves.
   */
  aliasClip(alias: string, sourceName: string): boolean;
  /**
   * Start a clip's playback clock if it is not already running.
   *
   * @param name Runtime key.
   */
  play(name: string): void;
  /**
   * Stop a clip, so it restarts from frame 0 next time it is driven.
   *
   * @param name Runtime key.
   */
  stop(name: string): void;
  /**
   * Blend every driven clip into one ARKit-52 vector.
   *
   * @param weights Drive weights by clip name; null or empty means nothing plays.
   *
   * @returns A reused 52-element buffer, or null when nothing is driven. Do not
   *   retain it across frames — it is overwritten in place.
   */
  getBlendedWeights(weights: ReadonlyMap<string, number> | null): Float32Array | null;
  /** Drop every clip and every playback cursor. */
  reset(): void;
}

/** Options for {@link createFaceClipPlayer}. */
export interface FaceClipPlayerOptions {
  /** Millisecond clock; defaults to {@link defaultClock}. */
  now?: Clock;
}

/** A clip normalised into flat arrays. */
interface NormalisedClip {
  /** Frame times in seconds, ascending. */
  times: Float32Array;
  /** `frameCount * 52` weights, frame-major. */
  values: Float32Array;
  /** Number of frames. */
  frameCount: number;
  /** Time of the last frame; the loop length. */
  duration: number;
}

/** Per-key playback cursor. */
interface PlaybackCursor {
  /** Clock reading when the clip started. */
  startTime: number;
  /** Frame index the forward walk resumes from. */
  lastFrameIdx: number;
}

/**
 * Flatten authored frames into typed arrays.
 *
 * @param clip The authored clip.
 *
 * @returns The normalised form used by the hot loop.
 */
function normalise(clip: FaceClipData): NormalisedClip {
  const frames = clip.frames;
  const frameCount = frames.length;
  const fps = clip.fps !== undefined && clip.fps > 0 ? clip.fps : 30;
  const times = new Float32Array(frameCount);
  const values = new Float32Array(frameCount * ARKIT_COUNT);
  for (let f = 0; f < frameCount; f += 1) {
    const frame = frames[f];
    times[f] = frame.timeCode ?? f / fps;
    const src = frame.blendshapeWeights;
    const limit = Math.min(src.length, ARKIT_COUNT);
    const base = f * ARKIT_COUNT;
    for (let i = 0; i < limit; i += 1) values[base + i] = src[i];
  }
  const duration = frameCount > 0 ? times[frameCount - 1] : 0;
  return { times, values, frameCount, duration };
}

/**
 * Create a face-clip blender.
 *
 * @param options See {@link FaceClipPlayerOptions}.
 *
 * @returns A {@link FaceClipPlayer}.
 */
export function createFaceClipPlayer(options: FaceClipPlayerOptions = {}): FaceClipPlayer {
  const now = options.now ?? defaultClock;

  const clips = new Map<string, NormalisedClip>();
  const active = new Map<string, PlaybackCursor>();

  // Reusable output buffer — zero-filled each frame instead of allocated.
  const result = new Float32Array(ARKIT_COUNT);

  /**
   * Start a clip's cursor if it has none.
   *
   * @param name Runtime key.
   */
  function play(name: string): void {
    if (!clips.has(name)) return;
    if (!active.has(name)) active.set(name, { startTime: now(), lastFrameIdx: 0 });
  }

  return {
    addFaceClip(name: string, clip: FaceClipData): void {
      clips.set(name, normalise(clip));
    },

    hasClip(name: string): boolean {
      return clips.has(name);
    },

    aliasClip(alias: string, sourceName: string): boolean {
      if (alias === '' || alias === sourceName) return false;
      if (clips.has(alias)) return true; // idempotent
      const source = clips.get(sourceName);
      if (source === undefined) return false;
      clips.set(alias, source);
      return true;
    },

    play,

    stop(name: string): void {
      active.delete(name);
    },

    getBlendedWeights(weights: ReadonlyMap<string, number> | null): Float32Array | null {
      result.fill(0);
      if (weights === null || weights.size === 0) {
        active.clear();
        return null;
      }

      const t0 = now();
      let hasAny = false;

      for (const [name, weight] of weights) {
        if (weight <= 0) continue;
        const clip = clips.get(name);
        if (clip === undefined || clip.frameCount === 0) continue;

        play(name);
        const cursor = active.get(name);
        if (cursor === undefined) continue;

        // Seek to the current frame from elapsed wall clock, looping.
        const elapsed = (t0 - cursor.startTime) / 1000;
        const duration = clip.duration;
        const t = duration > 0 ? elapsed % duration : 0;

        // Walk forward from the last frame; reset to 0 when time wrapped.
        let frameIdx = cursor.lastFrameIdx;
        if (frameIdx >= clip.frameCount || clip.times[frameIdx] > t) frameIdx = 0;
        while (frameIdx < clip.frameCount - 1 && clip.times[frameIdx + 1] <= t) frameIdx += 1;
        cursor.lastFrameIdx = frameIdx;

        // Interpolate to the next frame — especially across the loop boundary,
        // where the raw values can jump.
        const nextIdx = (frameIdx + 1) % clip.frameCount;
        const tA = clip.times[frameIdx];
        const tB = nextIdx > frameIdx ? clip.times[nextIdx] : duration;
        const frac = tB > tA ? (t - tA) / (tB - tA) : 0;
        const baseA = frameIdx * ARKIT_COUNT;
        const baseB = nextIdx * ARKIT_COUNT;
        if (frac > 0 && frac < 1) {
          for (let i = 0; i < ARKIT_COUNT; i += 1) {
            const a = clip.values[baseA + i];
            result[i] += (a + (clip.values[baseB + i] - a) * frac) * weight;
          }
        } else {
          for (let i = 0; i < ARKIT_COUNT; i += 1) result[i] += clip.values[baseA + i] * weight;
        }
        hasAny = true;
      }

      // Stop clips no longer driven, so they restart from frame 0 next time.
      for (const name of active.keys()) {
        const w = weights.get(name) ?? 0;
        if (w <= 0) active.delete(name);
      }

      return hasAny ? result : null;
    },

    reset(): void {
      clips.clear();
      active.clear();
      result.fill(0);
    },
  };
}
