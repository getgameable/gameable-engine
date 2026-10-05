/**
 * Which server `error` codes end a session and which only warn.
 */

/**
 * Whether a server `error` code is a warning: the room said it, and the page
 * keeps its seat. Today that is `budget` alone: the room sends it when the
 * page runs out of text budget, drops the frames, and keeps it seated
 * (Task 4.2). When the room does close the page for abuse, the close itself
 * says so (`budget` as the close reason, or a 4002 on Colyseus). Every other
 * code (`room`, `full`, `seat`, `origin`, `version`, `ended`) is followed by
 * the close and ends the session.
 *
 * @param code An `error` frame's `code`.
 * @returns True when the session goes on.
 *
 * @example
 * ```ts
 * import { isWarningError } from 'gameable/net/client';
 *
 * isWarningError('budget'); // true
 * isWarningError('full'); // false
 * ```
 */
export function isWarningError(code: string): boolean {
  return code === 'budget';
}
