/**
 * Which body clips play, and at what weight: the clip fading in, the one fading out, and the
 * looping clip a one-shot returns to. Kept apart from the loader so it can be tested without a GPU.
 */

/** One clip's weight this frame, as `@gameable/animation`'s `setState` takes it. */
export interface ClipRequest {
  name: string;
  weight: number;
  /** Set on the frame a clip starts: play it from this time (seconds). */
  time?: number;
}

/** What the drive knows of a clip. */
export interface ClipInfo {
  /** Seconds. */
  readonly duration: number;
  /** Whether it loops unless the caller says otherwise. */
  readonly loop: boolean;
}

/** How long a clip takes to cross-fade in, unless the caller says otherwise (seconds). */
export const DEFAULT_FADE = 0.25;

/** The drive. */
export interface ClipDrive {
  /** The clip playing now (the one fading in, during a fade); `''` before the first `play`. */
  readonly current: string;
  /**
   * Play a clip. Playing the clip that is already playing does nothing: a one-shot runs to its
   * end (and returns as it would have), a looping clip keeps looping.
   *
   * @param name A clip `clips` has.
   * @param options Fade time (seconds) and looping.
   * @param options.fade Cross-fade length, seconds.
   * @param options.loop Loop, overriding the clip's own setting.
   * @returns Whether it started.
   * @throws {Error} When there is no clip by that name.
   */
  play(name: string, options?: { fade?: number; loop?: boolean }): boolean;
  /**
   * Advance the fade and the one-shot's return.
   *
   * @param dt Seconds.
   * @returns Nothing.
   */
  update(dt: number): void;
}

/**
 * Make a drive over a character's clips.
 *
 * @param clips Every clip by name.
 * @param send Called with this frame's requests whenever they change (the array is reused).
 * @returns The drive.
 * @example
 * ```ts
 * const drive = createClipDrive(clips, (requests) => animator.setState({ ...state, clips: requests }));
 * drive.play('idle');
 * // each frame: drive.update(dt)
 * ```
 */
export function createClipDrive(
  clips: ReadonlyMap<string, ClipInfo>,
  send: (requests: readonly ClipRequest[]) => void,
): ClipDrive {
  const incoming: ClipRequest = { name: '', weight: 1 };
  const outgoing: ClipRequest = { name: '', weight: 0 };
  const requests: ClipRequest[] = [];
  let current = '';
  // Whether the clip playing now loops, as it was played (the caller's `loop`, else the clip's).
  let currentLoops = false;
  let previous = '';
  let fadeTime = 0;
  let fadeLength = 0;
  let elapsed = 0;
  let oneShotLength = 0;
  let returnTo = '';
  // The one-shot's own fade, used again for the way back.
  let returnFade = DEFAULT_FADE;

  const drive = (): void => {
    const t = fadeLength > 0 ? Math.min(1, fadeTime / fadeLength) : 1;
    incoming.name = current;
    incoming.weight = t;
    requests.length = 0;
    requests.push(incoming);
    if (previous !== '' && previous !== current && t < 1) {
      outgoing.name = previous;
      outgoing.weight = 1 - t;
      requests.push(outgoing);
    }
    send(requests);
  };

  const self: ClipDrive = {
    get current() {
      return current;
    },
    play(name, options = {}) {
      const entry = clips.get(name);
      if (!entry) {
        throw new Error(
          `GameableCharacter.play: no clip "${name}"; this character has ${[...clips.keys()].join(', ')}`,
        );
      }
      // Already playing: a restart cross-faded from itself would fade the clip in from nothing
      // (the rest pose shows for a few frames) and cut it short. Left as it is.
      if (name === current) return false;
      const loop = options.loop ?? entry.loop;
      if (!loop && currentLoops) returnTo = current;
      else if (loop) returnTo = '';
      previous = current;
      current = name;
      currentLoops = loop;
      fadeLength = previous === '' ? 0 : Math.max(0, options.fade ?? DEFAULT_FADE);
      if (!loop) returnFade = Math.max(0, options.fade ?? DEFAULT_FADE);
      fadeTime = 0;
      elapsed = 0;
      oneShotLength = loop ? 0 : entry.duration;
      // Restart the clip from its first frame.
      incoming.time = 0;
      drive();
      delete incoming.time;
      return true;
    },
    update(dt) {
      if (fadeTime < fadeLength) {
        fadeTime += dt;
        drive();
      }
      elapsed += dt;
      // Back to the looping clip, fading as the one-shot faded in, so the fade ends with it.
      if (oneShotLength > 0 && elapsed >= oneShotLength - returnFade && returnTo !== '') {
        const back = returnTo;
        returnTo = '';
        self.play(back, { fade: returnFade, loop: true });
      }
    },
  };
  return self;
}
