/**
 * `gameable/rooms/client` — the page side of a room on the Colyseus room
 * server: `multiplayer()` (net's loader with a `ColyseusConnection` as its
 * default), the connection itself, the SDK serializer for our frames, where
 * the server is, and `listRooms`, a game's public rooms, live.
 *
 * @example
 * ```ts
 * import { multiplayer } from 'gameable/rooms/client';
 *
 * // `?room=KQTX` joins that room, `?room=new` makes one, `?room=quick` or neither is a quick match.
 * const feature = await multiplayer({ game: 'party', name: 'Ana', maxPlayers: 6 });
 * ```
 */
export { GameableClientSerializer, type GameableFrameSink } from './GameableClientSerializer.js';
export {
  ColyseusConnection,
  createColyseusConnection,
  type ColyseusConnectionOptions,
} from './ColyseusConnection.js';
export { DeviceTokens } from './DeviceTokens.js';
export { roomsEndpoint } from './endpoint.js';
export { multiplayer, type PageLocation, type RoomsMultiplayerOptions } from './module.js';
export { listRooms, type ListRoomsOptions } from './listRooms.js';
export { leaveReason, refusalReason } from './reasons.js';
export { publicRoom } from './publicRoom.js';
export { RoomList } from './RoomList.js';
export { SeatClaim } from './SeatClaim.js';
export { MemorySeatLocks, type SeatLocks, webSeatLocks } from './SeatLocks.js';
export { type SavedSeat, type SeatStorage, SeatTokens } from './SeatTokens.js';
