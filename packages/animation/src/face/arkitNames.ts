// Ported from aos-threejs-poc/src/lib/arkitNames.js @ cdd63b10
/**
 * ARKit blendshape names in the exact order the capture pipeline sends them
 * (indices 0-51).
 *
 * Lives in its own module — with no dependency on the face player or on three —
 * so pure-logic consumers and unit tests can read the canonical channel order
 * without pulling in a runtime. There is exactly one copy of the list.
 */

/** The 52 ARKit blendshape channel names, in wire order. */
export const ARKIT_NAMES = [
  'EyeBlinkLeft',
  'EyeLookDownLeft',
  'EyeLookInLeft',
  'EyeLookOutLeft',
  'EyeLookUpLeft',
  'EyeSquintLeft',
  'EyeWideLeft',
  'EyeBlinkRight',
  'EyeLookDownRight',
  'EyeLookInRight',
  'EyeLookOutRight',
  'EyeLookUpRight',
  'EyeSquintRight',
  'EyeWideRight',
  'JawForward',
  'JawLeft',
  'JawRight',
  'JawOpen',
  'MouthClose',
  'MouthFunnel',
  'MouthPucker',
  'MouthLeft',
  'MouthRight',
  'MouthSmileLeft',
  'MouthSmileRight',
  'MouthFrownLeft',
  'MouthFrownRight',
  'MouthDimpleLeft',
  'MouthDimpleRight',
  'MouthStretchLeft',
  'MouthStretchRight',
  'MouthRollLower',
  'MouthRollUpper',
  'MouthShrugLower',
  'MouthShrugUpper',
  'MouthPressLeft',
  'MouthPressRight',
  'MouthLowerDownLeft',
  'MouthLowerDownRight',
  'MouthUpperUpLeft',
  'MouthUpperUpRight',
  'BrowDownLeft',
  'BrowDownRight',
  'BrowInnerUp',
  'BrowOuterUpLeft',
  'BrowOuterUpRight',
  'CheekPuff',
  'CheekSquintLeft',
  'CheekSquintRight',
  'NoseSneerLeft',
  'NoseSneerRight',
  'TongueOut',
] as const;

/** How many ARKit channels there are; the width of every ARKit weight vector. */
export const ARKIT_COUNT = 52;

/** Index of `EyeBlinkLeft`, the left half of the procedural blink overlay. */
export const ARKIT_EYE_BLINK_LEFT = 0;

/** Index of `EyeBlinkRight`, the right half of the procedural blink overlay. */
export const ARKIT_EYE_BLINK_RIGHT = 7;

/**
 * Index of an ARKit channel by name, or `-1` when the name is not an ARKit one.
 *
 * @param name Channel name, case-sensitive, as it appears in {@link ARKIT_NAMES}.
 *
 * @returns The channel index in `[0, 52)`, or `-1`.
 */
export function arkitIndex(name: string): number {
  return (ARKIT_NAMES as readonly string[]).indexOf(name);
}
