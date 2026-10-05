/**
 * ARKit-52 weights, by position or by name, into the animator's order.
 *
 * Apple spells the blendshapes in camelCase (`jawOpen`, `eyeBlinkLeft`); this repository's
 * table (`gameable/animation`'s `ARKIT_NAMES`) spells them in PascalCase (`JawOpen`). Names
 * are matched without regard to case, so both work. A face tracker's output needs a look first:
 * MediaPipe's face landmarker lists a `_neutral` category before the 52 (not an ARKit name, so it
 * throws, and its array is one longer), so pass its categories by name, without that one.
 */
import { ARKIT_NAMES } from '@gameable/animation';

/**
 * A weight as the face takes it: within [0, 1], anything else (NaN, a string) 0. ARKit weights
 * are 0..1; the face table plays its linear part unclamped, so a 2 would drive the face twice as
 * far as it was fitted for and tear the mouth.
 *
 * @param x The weight given.
 * @returns It, clamped.
 */
const unit = (x: unknown): number => (typeof x === 'number' && x > 0 ? (x < 1 ? x : 1) : 0);

/** Lower-cased name to index in `ARKIT_NAMES`. */
const INDEX = new Map<string, number>(ARKIT_NAMES.map((name, i) => [name.toLowerCase(), i]));

/**
 * Write weights into `out` (52 floats, zeroed first), each clamped to [0, 1].
 *
 * @param weights 52 numbers in ARKit order, or `{ name: weight }` for any subset.
 * @param out Where to write, `ARKIT_NAMES.length` long.
 * @returns `out`.
 * @throws {Error} For a name that is not one of the 52.
 */
export function writeArkitWeights(
  weights: ArrayLike<number> | Readonly<Record<string, number>>,
  out: Float32Array,
): Float32Array {
  out.fill(0);
  if (typeof (weights as ArrayLike<number>).length === 'number') {
    const list = weights as ArrayLike<number>;
    for (let i = 0; i < Math.min(out.length, list.length); i++) out[i] = unit(list[i]);
    return out;
  }
  for (const [name, value] of Object.entries(weights as Record<string, number>)) {
    const i = INDEX.get(name.toLowerCase());
    if (i === undefined) {
      throw new Error(
        `GameableCharacter.setExpression: "${name}" is not one of ARKit's 52 blendshapes ` +
          '(for example jawOpen, eyeBlinkLeft, mouthSmileRight)',
      );
    }
    out[i] = unit(value);
  }
  return out;
}
