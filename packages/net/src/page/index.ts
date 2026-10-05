/**
 * `gameable/net/page` — the boot logic both multiplayer pages share (the
 * third-person template and the mystery example): the `?room=` modes, the
 * choice between Play Solo and the room server, the room badge with its code
 * and copy-link button, the `?room=CODE` rewrite after a new room or a quick
 * match, the game's catalog name, the "Browse rooms" panel (a game's public
 * rooms, live), and `leaveRoom` for a boot that failed.
 * Colyseus-free, and free of the client loop (the CLI reads `catalogName`
 * here): the room server client is loaded by the feature table only when a
 * page joins one, and `gameable/net/client`'s `attachRoomClient` ends a
 * page's boot with the badge.
 *
 * @example
 * ```ts
 * import { catalogName, chooseRoom, createPageRoom, roomMode } from 'gameable/net/page';
 *
 * const mode = roomMode(location.search); // solo, join, new or quick
 * console.log(catalogName('@acme/my-game'), mode.kind); // 'my-game'
 * ```
 */
export { browseRows, type BrowseRow } from './browseRows.js';
export { catalogName } from './catalogName.js';
export {
  chooseRoom,
  type ChooseRoomOptions,
  type ChosenRoom,
  type PageRoomOptions,
  type SoloLink,
} from './chooseRoom.js';
export { leaveRoom } from './leaveRoom.js';
export {
  createPageRoom,
  PageRoom,
  type PageRoomBadgeOptions,
  type PageRoomBrowse,
  type PageRoomNet,
} from './PageRoom.js';
export { RoomBadge, type RoomBadgeActions, type RoomBadgeView } from './RoomBadge.js';
export { RoomBrowser, type RoomBrowserOptions } from './RoomBrowser.js';
export {
  PROBE_TIMEOUT_MS,
  probeRooms,
  roomsHealthUrl,
  type ProbeRoomsOptions,
} from './probeRooms.js';
export { friendsHref, rememberRoom, roomHref, type PageHistory } from './roomHref.js';
export type { LiveRoomList, PublicRoom, RoomListLoader } from './roomList.js';
export { roomMode, type RoomMode } from './roomMode.js';
export { roomsEndpoint } from './roomsEndpoint.js';
export { closeReasonText, netStatusText } from './statusText.js';
