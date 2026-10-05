/**
 * The fight's state, one flat lane per seat: health, cooldowns, facing,
 * knockback, knockouts and the round. Typed arrays made once at module
 * scope, so a system reads and writes numbers and allocates nothing.
 *
 * The authority owns all of it. A player's page keeps only `out[seat]` for
 * itself (from the `ko` and `respawn` messages), so its prediction stands
 * still while it is knocked out.
 *
 * Module state is frozen into the wasm component: `reset()` runs in `init`.
 */

/** Seats in a room. Must match `features.multiplayer.maxPlayers` in `src/game.ts`. */
export const MAX_PLAYERS = 4;

/** The room's phase word for the public room list (`ctx.net.setPhase`). */
export const PHASE_FIGHTING = 'fighting';
/** The phase word between a round's winner and the next round. */
export const PHASE_ROUND_OVER = 'round-over';

/** Where each seat starts, and comes back after a knockout: x, y, z. */
export const SPAWNS: readonly (readonly [number, number, number])[] = [
  [-3, 1.2, 0],
  [3, 1.2, 0],
  [0, 1.2, -3],
  [0, 1.2, 3],
];

/** Everything per seat, and the round. */
class Fight {
  /** Health left. */
  readonly hp = new Float32Array(MAX_PLAYERS);
  /** Seconds until each ability is ready again: punch, dash, slam. */
  readonly punchReady = new Float32Array(MAX_PLAYERS);
  readonly dashReady = new Float32Array(MAX_PLAYERS);
  readonly slamReady = new Float32Array(MAX_PLAYERS);
  /** The direction the fighter last moved in, unit length on the ground. */
  readonly faceX = new Float32Array(MAX_PLAYERS);
  readonly faceZ = new Float32Array(MAX_PLAYERS);
  /** Knockback velocity, metres per second; it decays to nothing. */
  readonly knockX = new Float32Array(MAX_PLAYERS);
  readonly knockZ = new Float32Array(MAX_PLAYERS);
  /** Seconds of dash left. */
  readonly dashing = new Float32Array(MAX_PLAYERS);
  /** Seconds of red left after a hit. */
  readonly flash = new Float32Array(MAX_PLAYERS);
  /** 1 while knocked out. */
  readonly out = new Uint8Array(MAX_PLAYERS);
  /** Seconds until a knocked-out fighter is back. */
  readonly respawnIn = new Float32Array(MAX_PLAYERS);
  /** Knockouts this round. */
  readonly kos = new Uint8Array(MAX_PLAYERS);
  /** Rounds won since the seat was taken. */
  readonly wins = new Uint8Array(MAX_PLAYERS);
  /** `PHASE_FIGHTING` or `PHASE_ROUND_OVER`. */
  phase = PHASE_FIGHTING;
  /** Seconds left of `round-over`. */
  roundOverIn = 0;
  /** The last round's winner, or -1. */
  winner = -1;

  /** Everything back to a fresh room. Call from `defineGame({ init })`. */
  reset(): void {
    for (let seat = 0; seat < MAX_PLAYERS; seat += 1) this.clearSeat(seat);
    this.phase = PHASE_FIGHTING;
    this.roundOverIn = 0;
    this.winner = -1;
  }

  /**
   * A seat taken or left starts again: full health, nothing on cooldown, no wins.
   *
   * @param seat The seat.
   * @param maxHp Full health.
   */
  clearSeat(seat: number, maxHp = 100): void {
    this.revive(seat, maxHp);
    this.kos[seat] = 0;
    this.wins[seat] = 0;
  }

  /**
   * Back on their feet with full health, facing the middle.
   *
   * @param seat The seat.
   * @param maxHp Full health.
   */
  revive(seat: number, maxHp: number): void {
    const at = SPAWNS[seat];
    const length = Math.hypot(at[0], at[2]) || 1;
    this.hp[seat] = maxHp;
    this.punchReady[seat] = this.dashReady[seat] = this.slamReady[seat] = 0;
    this.faceX[seat] = -at[0] / length;
    this.faceZ[seat] = -at[2] / length;
    this.knockX[seat] = this.knockZ[seat] = 0;
    this.dashing[seat] = this.flash[seat] = 0;
    this.out[seat] = 0;
    this.respawnIn[seat] = 0;
  }
}

/** The one fight. */
export const fight = new Fight();

/**
 * A rule from `defineGame({ rules })`, with its default.
 *
 * @param value `ctx.rules.<name>`.
 * @param fallback The default when the rule is missing or not a number.
 * @returns The number.
 */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
