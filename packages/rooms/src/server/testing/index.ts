/**
 * `gameable/rooms/testing` — a player over `@colyseus/sdk` for tests outside
 * this package (`gameable serve`'s, the container smoke test), which may not
 * import Colyseus themselves: everything that touches it lives here.
 */
export { TestPlayer } from './TestPlayer.js';
export { TestReplica } from './TestReplica.js';
