// The one error type a caller is expected to branch on.

/**
 * Thrown by `createCharacter` when the renderer is not on the WebGPU backend.
 *
 * Characters are a WebGPU-only feature by construction: the rig deform, the lift
 * and the decoders all run as compute on `renderer.backend.device`, and the WebGL
 * fallback backend has no device to borrow. There is no CPU path — the POC had
 * one and it cost seconds per frame, which reads as a hung avatar rather than as
 * a slow one. Check `engine.caps.characters` and substitute a placeholder.
 *
 * @example
 * ```ts
 * import { CharacterUnsupportedError, createCharacter } from 'gameable/character';
 *
 * try {
 *   await createCharacter(bundle, { renderer, scene, sink });
 * } catch (err) {
 *   if (err instanceof CharacterUnsupportedError) console.warn(err.reason);
 * }
 * ```
 */
export class CharacterUnsupportedError extends Error {
  override readonly name = 'CharacterUnsupportedError';
  /** Why the renderer could not host a character. */
  readonly reason: string;

  constructor(reason: string) {
    super(`Splat characters require the WebGPU backend: ${reason}`);
    this.reason = reason;
  }
}
