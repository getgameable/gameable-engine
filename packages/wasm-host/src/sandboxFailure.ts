/**
 * What a failing sandbox returns and reports: the inert frame a dead sandbox
 * hands back, and the error made from whatever the guest threw.
 */
import type { CameraState, FrameOutput } from '@gameable/sdk';

/**
 * The frame a dead sandbox returns.
 *
 * One all-zero row rather than an empty list: jco's list lifter rejects the
 * pointer QuickJS hands back for a zero-length `list<f32>`, so nothing in
 * gameable ever emits one.
 *
 * @returns A safe, inert frame output.
 */
export function emptyOutput(): FrameOutput {
  const camera: CameraState = {
    mode: 'first-person',
    projection: 'perspective',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    target: undefined,
    fovYDeg: 75,
    near: 0.1,
    far: 1000,
    follow: undefined,
    armLength: 0,
    offset: { x: 0, y: 0, z: 0 },
  };
  return {
    transforms: new Float32Array(12),
    commands: [],
    localCommands: [],
    camera,
    hud: undefined,
  };
}

/**
 * Turn whatever a component threw into an `Error` with the payload attached.
 *
 * jco raises a `ComponentError` whose `payload` is the WIT error record, and
 * QuickJS traps surface as plain `Error`s.
 *
 * @param err The thrown value.
 * @param what The call that failed.
 * @returns An error with a useful message.
 */
export function toError(err: unknown, what: string): Error {
  const payload = errorPayload(err);
  if (payload) {
    const out: Error & { payload?: unknown } = new Error(
      `${what} failed: ${payload.code}: ${payload.message}`,
    );
    out.payload = payload;
    return out;
  }
  if (err instanceof Error) return new Error(`${what} failed: ${err.message}`, { cause: err });
  return new Error(`${what} failed: ${String(err)}`);
}

/**
 * Pull a WIT `game-error` record out of whatever was thrown.
 *
 * jco wraps it in `ComponentError.payload`; direct mode throws the record
 * itself, because that is exactly what the guest threw.
 *
 * @param err The thrown value.
 * @returns The record, or null when this was an ordinary throw.
 */
function errorPayload(err: unknown): { code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const outer = err as Record<string, unknown>;
  const inner = outer.payload;
  const record = (typeof inner === 'object' && inner !== null ? inner : outer) as Record<
    string,
    unknown
  >;
  if (typeof record.code !== 'string') return null;
  return {
    code: record.code,
    message: typeof record.message === 'string' ? record.message : 'no message',
  };
}
