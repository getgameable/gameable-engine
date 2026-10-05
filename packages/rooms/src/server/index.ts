/**
 * `gameable/rooms/server` — the room server on Colyseus: one
 * `GameableColyseusRoom` for every game, our serializer and frames, seats and intake,
 * and `createRoomServer`, which hosts them.
 */
export { GameableColyseusRoom } from './GameableColyseusRoom.js';
export type {
  GameableCreateOptions,
  GameableRoomEntry,
  GameableRoomOptions,
} from './GameableRoomEntry.js';
export {
  GameableSerializer,
  createAosSerializer,
  type ReplicationSource,
} from './GameableSerializer.js';
export { GameableWire, createAosWire } from './GameableWire.js';
export * from './host/index.js';
export { IdleSeats } from './IdleSeats.js';
export {
  createRoomIntake,
  type InputOutcome,
  type IntakeCounts,
  RoomIntake,
  type TextOutcome,
} from './RoomIntake.js';
export { type ClientLookup, createRoomReplication, RoomReplication } from './RoomReplication.js';
export { createRoomInbound, RoomInbound } from './RoomInbound.js';
export { type CrashableRoom, RoomCrash } from './RoomCrash.js';
export { RoomLifecycle } from './RoomLifecycle.js';
export { type ListedRoom, RoomListing } from './RoomListing.js';
export { advanceRoom, buildRoomParts, type RoomParts } from './RoomParts.js';
export {
  ADMIT_REFUSED_CODE,
  type AdmittingRoom,
  admitJoin,
  type GameableJoinOptions,
  checkJoin,
  displayName,
  VERSION_REFUSED_CODE,
} from './RoomAdmission.js';
export { identifyJoin, joinAuth, type SeatAuth } from './RoomIdentify.js';
export { createRoomSeating, RoomSeating } from './RoomSeating.js';
export { SeatQuota } from './SeatQuota.js';
export { createSeatMap, type Seat, type SeatBudgets, SeatMap } from './SeatMap.js';
