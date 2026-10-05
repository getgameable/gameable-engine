/**
 * `gameable/net/client` — the page side of multiplayer: a link to a room
 * (`RoomConnection`), the `net` service and module (`multiplayer()`), and the
 * client loop that shows the authority's world.
 *
 * @example
 * ```ts
 * import { createClientLoop, createLoopbackConnection, multiplayer } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 *
 * const feature = await multiplayer({ connection: createLoopbackConnection({ connect: () => loopbackPair()[0] }) });
 * ```
 */
export { attachRoomClient, type RoomClient, type RoomClientParts } from './attachRoomClient.js';
export { ClientLoop, createClientLoop, type ClientLoopOptions } from './ClientLoop.js';
export type { ClientLoopAdapter } from './ClientLoopAdapter.js';
export {
  createLoopbackConnection,
  LoopbackConnection,
  type ConnectionTimers,
  type LoopbackConnectionOptions,
} from './LoopbackConnection.js';
export { isWarningError } from './sessionErrors.js';
export { multiplayer, NetModule, type MultiplayerClientOptions } from './module.js';
export { createNetClient, NetClient } from './NetClient.js';
export type { NetClientOptions } from './NetClientOptions.js';
export { createNetOverlayLine, NetOverlayLine, showNetOnOverlay } from './NetOverlayLine.js';
export type {
  FramedRowSink,
  NetMessageSink,
  NetService,
  NetState,
  NetStats,
} from './NetService.js';
export type {
  ConnectionState,
  JoinRequest,
  RoomConnection,
  RoomConnectionEvents,
} from './RoomConnection.js';
