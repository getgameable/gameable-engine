/**
 * The physics world this game runs in, in one place.
 *
 * The page passes it to `physics()` in `src/main.ts`, `src/game.ts` reads its
 * gravity, and a room server (Task 3.11) must import this same module rather
 * than restate the numbers: the authority and the page simulating different
 * worlds is a desync nobody can see in a test. Plain data, so it is safe in
 * the wasm guest as well as on the host.
 */

/** Options for `gameable/physics`'s `physics()`, minus the page-only `wasmUrl`. */
export const PHYSICS_OPTIONS = {
  /** Metres per second squared, Y-up. */
  gravity: [0, -9.81, 0] as const,
};
