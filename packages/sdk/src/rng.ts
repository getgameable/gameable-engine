/**
 * The deterministic random number generator every game shares.
 *
 * xoshiro128** over four `u32` words. Fast, allocation-free, and trivially
 * serialisable: the whole state is four integers, so `snapshot()` round-trips
 * it exactly.
 *
 * The generator is seeded in `init` from `env.seed()` and **never** at module
 * scope: `jco componentize` snapshots the QuickJS heap with Wizer at build
 * time, so anything derived from `Math.random()` or `Date.now()` at module
 * scope is frozen into the binary and identical on every run.
 */

/** Four-word xoshiro128** state, as it appears in a snapshot. */
export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

/** A seeded, serialisable random source. */
export interface Rng {
  /** Re-seed from a 32-bit integer. */
  seed(value: number): void;
  /** Next `u32`. */
  uint32(): number;
  /** Next float in `[0, 1)`. */
  float(): number;
  /** Next integer in `[0, n)`. Returns 0 when `n <= 0`. */
  int(n: number): number;
  /** Next float in `[min, max)`. */
  range(min: number, max: number): number;
  /** A uniformly chosen element, or `undefined` when the array is empty. */
  pick<T>(items: ArrayLike<T>): T | undefined;
  /** Copy the state out, into `out` when given. */
  save(out?: RngState): RngState;
  /** Overwrite the state. */
  load(state: RngState): void;
}

/**
 * splitmix32: expands one 32-bit seed into well-distributed state words.
 *
 * @param x The running seed word.
 * @returns The next state word.
 */
function splitmix32(x: number): number {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Create a seeded xoshiro128** generator.
 *
 * @param initialSeed A 32-bit seed. `0` is remapped so the state is never all zero.
 * @returns A generator whose whole state is four integers.
 */
export function createRng(initialSeed = 1): Rng {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;

  const seed = (value: number): void => {
    let x = value >>> 0;
    if (x === 0) x = 0x9e3779b9;
    s0 = splitmix32(x);
    s1 = splitmix32(s0);
    s2 = splitmix32(s1);
    s3 = splitmix32(s2);
    if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  };

  const uint32 = (): number => {
    const r = Math.imul(s1, 5) >>> 0;
    const result = Math.imul(((r << 7) | (r >>> 25)) >>> 0, 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = ((s3 << 11) | (s3 >>> 21)) >>> 0;
    return result;
  };

  seed(initialSeed);

  return {
    seed,
    uint32,
    float: () => uint32() / 4294967296,
    int: (n: number) => (n <= 0 ? 0 : Math.floor((uint32() / 4294967296) * n)),
    range: (min: number, max: number) => min + (uint32() / 4294967296) * (max - min),
    pick: <T>(items: ArrayLike<T>): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor((uint32() / 4294967296) * items.length)],
    save: (out?: RngState): RngState => {
      if (out) {
        out.s0 = s0;
        out.s1 = s1;
        out.s2 = s2;
        out.s3 = s3;
        return out;
      }
      return { s0, s1, s2, s3 };
    },
    load: (state: RngState): void => {
      s0 = state.s0 >>> 0;
      s1 = state.s1 >>> 0;
      s2 = state.s2 >>> 0;
      s3 = state.s3 >>> 0;
      if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
    },
  };
}
