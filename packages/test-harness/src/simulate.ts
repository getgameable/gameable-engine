/**
 * Driving a guest for many frames, and hashing what comes back.
 *
 * `simulate` is the determinism and parity workhorse: the same script against
 * two guests must produce the same list of `hashFrameOutput` values, frame for
 * frame. A divergence is a bug in the engine, never a mode difference.
 */
import { hashFrameOutput } from './hash';
import { createFrameInput, createInputState, endFrame } from './frame-input';
import type { FrameInputOverrides, MutableInputState } from './frame-input';
import type { FrameOutput, HostFrameInput } from '@gameable/sdk';

/** Anything with the guest's per-frame entry point. */
export interface Tickable {
  tick(input: HostFrameInput): FrameOutput;
}

/**
 * A per-frame script. Mutate `input` in place, and optionally return fields to
 * merge into the frame.
 *
 * `void` in the return union is deliberate: a script that only mutates `input`
 * should not have to write `return undefined`.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type FrameScript = (frame: number, input: MutableInputState) => FrameInputOverrides | void;

/** How to run a simulation. */
export interface SimulateOptions {
  /** How many frames to run. */
  frames: number;
  /** Fixed timestep in seconds. Default `1 / 60`. */
  dt?: number;
  /**
   * Per-frame overrides. Mutate `input` (the same state object is reused and
   * its edges cleared between frames) or return fields to merge. A returned
   * `input` replaces it for that frame (the caller then owns its edges).
   */
  script?: FrameScript;
  /** Keep every `frame-output`. Off by default: outputs are reused objects. */
  keepOutputs?: boolean;
  /** Called with each `frame-output` right after its tick, before the input's edges clear. */
  onOutput?: (frame: number, output: FrameOutput) => void;
}

/** What a simulation produced. */
export interface SimulateResult {
  /** One `hashFrameOutput` per frame, in order. */
  hashes: number[];
  /** Combined hash of every frame. */
  hash: number;
  /** Commands seen per frame, by tag. */
  commandTags: string[][];
  /** Every HUD payload that crossed, with the frame it crossed on. */
  hud: { frame: number; json: string }[];
  /** Transform row counts per frame. */
  transformRows: number[];
  /** Outputs, when `keepOutputs` is set. */
  outputs: FrameOutput[];
}

/**
 * Run a guest for `frames` fixed steps.
 *
 * @param guest Anything with a `tick`, including a `Sandbox`.
 * @param options Frame count and the per-frame script.
 * @returns Hashes, command tags, HUD payloads and row counts.
 *
 * @example
 * ```ts
 * import { simulate, press } from 'gameable/test';
 *
 * const result = simulate(sandbox, {
 *   frames: 300,
 *   script: (frame, input) => {
 *     if (frame === 10) press(input, 'W');
 *   },
 * });
 * ```
 */
export function simulate(guest: Tickable, options: SimulateOptions): SimulateResult {
  const dt = options.dt ?? 1 / 60;
  const input = createInputState();
  const result: SimulateResult = {
    hashes: [],
    hash: 0x811c9dc5,
    commandTags: [],
    hud: [],
    transformRows: [],
    outputs: [],
  };

  for (let frame = 0; frame < options.frames; frame += 1) {
    const overrides = options.script?.(frame, input) ?? {};
    const frameInput = createFrameInput({
      ...overrides,
      frame,
      dt,
      elapsed: frame * dt,
      input: overrides.input ?? input,
    });
    const out = guest.tick(frameInput);

    const hash = hashFrameOutput(out);
    result.hashes.push(hash);
    result.hash = Math.imul(result.hash ^ hash, 0x01000193) >>> 0;
    result.commandTags.push(out.commands.map((c) => c.tag));
    result.transformRows.push(out.transforms.length / 12);
    if (out.hud !== undefined) result.hud.push({ frame, json: out.hud });
    if (options.keepOutputs) result.outputs.push(out);
    options.onOutput?.(frame, out);

    endFrame(input);
  }

  return result;
}
