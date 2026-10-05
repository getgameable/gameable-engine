/**
 * The vote after a tag-out: one pick per voter, changeable until it closes.
 * Authority state only, flat lanes by player id, so counting allocates nothing.
 */

/** Who voted for whom, while a vote is open. */
export class Ballot {
  /** `pick[voter]` is the player they voted for, or -1. */
  readonly pick: Int32Array;
  /** `ctx.elapsed` when the vote opened. */
  openedAt = 0;
  /**
   * Votes refused since `init`: from a player not in the round (a spectator,
   * someone tagged or voted out) or for someone not still in. The game's own
   * rule, so the game counts it; `ctx.net.stats.dropped` counts only payloads
   * that failed the message's check.
   */
  rejected = 0;

  /** @param seats Highest player id + 1. */
  constructor(seats: number) {
    this.pick = new Int32Array(seats).fill(-1);
  }

  /** Forget every pick (a new vote). `rejected` keeps counting. */
  clear(): void {
    this.pick.fill(-1);
  }

  /** Forget everything, `rejected` too. Call from `defineGame({ init })`. */
  reset(): void {
    this.clear();
    this.rejected = 0;
    this.openedAt = 0;
  }

  /**
   * Record a pick; a second one from the same voter replaces the first.
   *
   * @param voter The voter.
   * @param target Their pick.
   * @returns True when the pick changed.
   */
  cast(voter: number, target: number): boolean {
    if (this.pick[voter] === target) return false;
    this.pick[voter] = target;
    return true;
  }

  /**
   * A player left: their vote goes, and so do the votes for them.
   *
   * @param player The player who left.
   */
  forget(player: number): void {
    if (player < 0 || player >= this.pick.length) return;
    this.pick[player] = -1;
    for (let voter = 0; voter < this.pick.length; voter += 1) {
      if (this.pick[voter] === player) this.pick[voter] = -1;
    }
  }

  /**
   * @param target A player.
   * @returns How many voted for them.
   */
  count(target: number): number {
    let n = 0;
    for (let voter = 0; voter < this.pick.length; voter += 1) {
      if (this.pick[voter] === target) n += 1;
    }
    return n;
  }

  /** @returns How many have voted. */
  votes(): number {
    return this.pick.length - this.count(-1);
  }

  /**
   * @param need Votes a majority takes.
   * @returns The player with at least `need` votes, or -1.
   */
  winner(need: number): number {
    for (let target = 0; target < this.pick.length; target += 1) {
      if (this.count(target) >= need) return target;
    }
    return -1;
  }
}
