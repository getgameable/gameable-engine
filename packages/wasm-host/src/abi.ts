/**
 * Making direct mode a faithful simulator of the canonical ABI.
 *
 * Everything the WIT contract calls `f32` is rounded on its way through a wasm
 * component. Direct mode calls the guest in the host's own realm, where a
 * number is an `f64`, so without this the two modes integrate with slightly
 * different values and drift apart over a few hundred frames — exactly the
 * divergence the parity test exists to catch.
 *
 * The guest side rounds what it *emits* (see `packages/sdk/src/commands.ts`).
 * This module rounds what it *receives*. Between them, `mode: 'direct'` and
 * `mode: 'wasm'` are bit-identical.
 */
import type { HostFrameInput, InputState } from '@gameable/sdk';

const f = Math.fround;

/**
 * Round the `f32` lanes of one `input-state` in place: the mouse and the gamepad axes.
 *
 * @param state The input to normalise.
 */
function quantizeInputState(state: InputState): void {
  const m = state.mouse;
  m.x = f(m.x);
  m.y = f(m.y);
  m.dx = f(m.dx);
  m.dy = f(m.dy);
  m.wheel = f(m.wheel);

  const pads = state.gamepads;
  for (let i = 0; i < pads.length; i += 1) {
    const axes = pads[i].axes;
    if (axes instanceof Float32Array) continue;
    const mutable = axes as unknown as number[];
    for (let a = 0; a < mutable.length; a += 1) mutable[a] = f(mutable[a]);
  }
}

/**
 * Round every `f32` field of a `frame-input` in place.
 *
 * `bodies` is already a `Float32Array`, so it needs nothing. `frame` is a
 * `u64` and `focused` a `bool`; only the timing, mouse, gamepad, event and
 * contact floats can differ.
 *
 * @param input The frame input to normalise. Mutated in place where it can be,
 *   which is every field the host encoder owns.
 * @returns The same object.
 *
 * @example
 * ```ts
 * import { quantizeInput } from 'gameable/host';
 *
 * sandbox.tick(quantizeInput(encoder.encode(args)));
 * ```
 */
export function quantizeInput(input: HostFrameInput): HostFrameInput {
  input.dt = f(input.dt);
  input.elapsed = f(input.elapsed);

  quantizeInputState(input.input);
  // Every player in a room carries the same f32 mouse and gamepad lanes.
  const players = input.players;
  for (let i = 0; i < players.length; i += 1) quantizeInputState(players[i].input);

  for (const event of input.events) {
    // `resized` is the only host event carrying an `f32`; width and height are
    // `u32` and everything else in the variant is integers, ids and booleans.
    if (event.tag === 'resized') event.val.devicePixelRatio = f(event.val.devicePixelRatio);
  }

  for (const c of input.contacts) {
    c.point.x = f(c.point.x);
    c.point.y = f(c.point.y);
    c.point.z = f(c.point.z);
    c.normal.x = f(c.normal.x);
    c.normal.y = f(c.normal.y);
    c.normal.z = f(c.normal.z);
    c.impulse = f(c.impulse);
  }

  return input;
}

/**
 * Round a `game-config`'s floats. There are none today, but the seed must be a
 * `bigint` and the counts integers; this is the hook if the record grows.
 *
 * @param seed The seed as the host holds it.
 * @returns The same value, as a `bigint`.
 *
 * @example
 * ```ts
 * import { quantizeSeed } from 'gameable/host';
 *
 * const seed = quantizeSeed(0x5eed1234n);
 * ```
 */
export function quantizeSeed(seed: bigint | number): bigint {
  return typeof seed === 'bigint' ? BigInt.asUintN(64, seed) : BigInt(Math.trunc(seed));
}
