/**
 * `NeutralInput` — the input a page sends when it stops sending (hidden,
 * blurred, closed): nothing held, not focused, and whatever was held in the
 * last frame sent coming up as `released` edges.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';

import type { InputSnapshotLike } from '../protocol/types.js';

/** The neutral snapshot, kept up to date with the last input sent. */
export class NeutralInput {
  /** The snapshot to encode; read it, never keep it. */
  readonly snapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: false,
  } satisfies InputSnapshotLike;

  /** The `seq` of the last input sent; the neutral frame repeats it. */
  seq = 0;

  /**
   * @param seq The input frame's seq.
   * @param sent The input frame just sent: its held keys and buttons are what a release lets go of.
   */
  remember(seq: number, sent: InputSnapshotLike): void {
    this.seq = seq;
    this.snapshot.released.set(sent.down);
    this.snapshot.mouse.released = sent.mouse.buttons;
  }

  /** The neutral frame went out: a second one releases nothing. */
  sent(): void {
    this.snapshot.released.fill(0);
    this.snapshot.mouse.released = 0;
  }
}
