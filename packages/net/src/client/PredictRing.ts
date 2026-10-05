/**
 * `PredictRing` — the last 64 fixed steps of a predicted body: for each input
 * `seq`, the move the client guest asked for and where the body ended up.
 */

/** Steps kept: about a second at 60 Hz, past any round trip worth predicting across. */
export const PREDICT_RING = 64;

/** Lanes per step: seq, position 3, move 3, jump, crouch, max slope. */
const LANES = 10;
const SEQ = 0;

/** Lane offsets within a step's slot, for {@link PredictRing.lanes}. */
export const RingLane = {
  /** Position x, y, z after the step. */
  POSITION: 1,
  /** Desired velocity x, y, z the guest asked for. */
  MOVE: 4,
  /** 1 when the step jumped. */
  JUMP: 7,
  /** 1 when it crouched. */
  CROUCH: 8,
  /** Max walkable slope, degrees. */
  SLOPE: 9,
} as const;

/**
 * One flat `Float64Array`, indexed by `seq % 64`, so recording a step and
 * replaying 64 allocate nothing: the predictor reads and writes
 * {@link PredictRing.lanes} at {@link PredictRing.slot} plus a
 * {@link RingLane} offset, and no number crosses a call boxed. A slot belongs
 * to a seq only while its seq lane says so; seq 0 is never used (a seat's
 * first input is 1).
 *
 * @example
 * ```ts
 * import { PredictRing, RingLane } from './PredictRing.js';
 *
 * const ring = new PredictRing();
 * ring.open(1);
 * ring.lanes[ring.slot(1) + RingLane.POSITION + 2] = -0.07; // z after seq 1
 * ring.has(1); // true
 * ```
 */
export class PredictRing {
  /** Every step's lanes, `slot(seq)` onwards. */
  readonly lanes = new Float64Array(PREDICT_RING * LANES);
  /** The newest seq opened, or 0 for none since the last clear. */
  newest = 0;

  /** Forget every step (a new welcome: the seat's seq starts again at 1). */
  clear(): void {
    this.lanes.fill(0);
    this.newest = 0;
  }

  /**
   * Start a step. Its move defaults to the step before's, walking on (the
   * character keeps the last velocity it was asked for), without that
   * step's jump or upward speed: a jump is an edge.
   *
   * @param seq The step's input seq.
   */
  open(seq: number): void {
    const at = this.slot(seq);
    const l = this.lanes;
    l[at + SEQ] = seq;
    if (this.has(seq - 1)) {
      const before = this.slot(seq - 1);
      l[at + RingLane.MOVE] = l[before + RingLane.MOVE];
      l[at + RingLane.MOVE + 2] = l[before + RingLane.MOVE + 2];
      l[at + RingLane.CROUCH] = l[before + RingLane.CROUCH];
      l[at + RingLane.SLOPE] = l[before + RingLane.SLOPE];
    } else {
      l[at + RingLane.MOVE] = 0;
      l[at + RingLane.MOVE + 2] = 0;
      l[at + RingLane.CROUCH] = 0;
      l[at + RingLane.SLOPE] = 45;
    }
    l[at + RingLane.MOVE + 1] = 0;
    l[at + RingLane.JUMP] = 0;
    this.newest = seq;
  }

  /**
   * @param seq A seq.
   * @returns True when the ring still holds that step.
   */
  has(seq: number): boolean {
    return seq > 0 && this.lanes[this.slot(seq) + SEQ] === seq;
  }

  /**
   * @param seq A seq.
   * @returns The offset of its slot in {@link PredictRing.lanes}.
   */
  slot(seq: number): number {
    return (((seq % PREDICT_RING) + PREDICT_RING) % PREDICT_RING) * LANES;
  }
}
