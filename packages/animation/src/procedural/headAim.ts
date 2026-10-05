// Ported from aos-threejs-poc/src/lib/headAim.js @ cdd63b10
/**
 * headAim — pure yaw math for the head look-at.
 *
 * Extracted from the POC's headFollowRuntime so the "clamp head yaw relative to
 * the body" decision is unit-testable without three or a render loop. No
 * imports.
 *
 * The bug it fixes: the head look-at used to clamp yaw against a FIXED world
 * forward (+Z). That is fine while the avatar stands still facing +Z, but
 * locomotion yaws the whole avatar to face the walk direction. With a
 * world-anchored clamp the head would aim at the camera regardless of where the
 * body points, so head-relative-to-torso could reach body-yaw + maxYaw — well
 * past a neck's range ("exorcist twist"). Clamping relative to the body's
 * current forward keeps the head within ±maxYaw of the torso no matter which
 * way the body faces.
 */

/** Two pi, hoisted so the wrap does not recompute it per call. */
const TWO_PI = Math.PI * 2;

/**
 * Wrap an angle into `(-π, π]`.
 *
 * @param angle Angle in radians.
 *
 * @returns The equivalent angle in `(-π, π]`.
 */
export function normalizeAngle(angle: number): number {
  let a = angle % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * Clamp the desired world yaw to within ±`maxYaw` of the body's forward yaw,
 * and return the result RELATIVE to the body (so the caller can smooth it and
 * then re-add `bodyYaw` to get the world-space look direction).
 *
 * @param rawYaw Desired look yaw in world space (radians; 0 = +Z).
 * @param bodyYaw Body forward yaw in world space (radians).
 * @param maxYaw Max head deviation from the body (radians, >= 0).
 *
 * @returns Clamped yaw relative to the body forward, in `[-maxYaw, maxYaw]`.
 */
export function clampYawToBody(rawYaw: number, bodyYaw: number, maxYaw: number): number {
  const rel = normalizeAngle(rawYaw - bodyYaw);
  return Math.max(-maxYaw, Math.min(maxYaw, rel));
}

/**
 * Clamp a pitch to `[-maxPitch, maxPitch]` after wrapping it.
 *
 * Pitch has no body-relative frame to fight over — the torso does not pitch in
 * locomotion — so this is the plain symmetric clamp the yaw path cannot use.
 *
 * @param rawPitch Desired look pitch in radians; positive looks up.
 * @param maxPitch Max head pitch (radians, >= 0).
 *
 * @returns The clamped pitch.
 */
export function clampPitch(rawPitch: number, maxPitch: number): number {
  const p = normalizeAngle(rawPitch);
  return Math.max(-maxPitch, Math.min(maxPitch, p));
}

/**
 * Move `current` toward `target` along the shortest arc, framerate-corrected.
 *
 * Exponential follow rather than a naive lerp: `e^(-rate·2dt)` is exactly
 * `(e^(-rate·dt))²`, so one 1/30 s step and two 1/60 s steps land in the same
 * place. A dt-naive lerp drifts with the frame rate, which showed up as the
 * head tracking visibly faster on a fast machine.
 *
 * @param current Current angle in radians.
 * @param target Target angle in radians.
 * @param rate Follow rate in 1/seconds; larger is snappier.
 * @param dt Delta time in seconds.
 *
 * @returns The new angle, wrapped into `(-π, π]`.
 */
export function approachAngle(current: number, target: number, rate: number, dt: number): number {
  if (dt <= 0 || rate <= 0) return normalizeAngle(current);
  const alpha = 1 - Math.exp(-rate * dt);
  return normalizeAngle(current + normalizeAngle(target - current) * alpha);
}

/**
 * World-space yaw of the direction `(dx, dz)`, matching three's +Z forward.
 *
 * @param dx World-space X offset from the head to the look target.
 * @param dz World-space Z offset from the head to the look target.
 *
 * @returns The yaw in radians, 0 when the target is dead ahead on +Z.
 */
export function yawTo(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/**
 * World-space pitch of the direction `(dx, dy, dz)`; positive looks up.
 *
 * @param dx World-space X offset from the head to the look target.
 * @param dy World-space Y offset from the head to the look target.
 * @param dz World-space Z offset from the head to the look target.
 *
 * @returns The pitch in radians.
 */
export function pitchTo(dx: number, dy: number, dz: number): number {
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  return Math.atan2(dy, horizontal);
}
