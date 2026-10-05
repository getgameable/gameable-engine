/**
 * `PageRoom` — a multiplayer page's room on screen: it redraws the badge when
 * `net` says its state, room or close reason changed, and writes `?room=CODE`
 * into the address once a new room or a quick match has its code. Both happen
 * as the change arrives, so a tab that draws no frames (hidden, or reloaded
 * before it was ever shown) still has the right address. Given a room list,
 * it also holds the "Browse rooms" panel.
 */
import type { NetService } from '../client/NetService.js';
import { RoomBadge } from './RoomBadge.js';
import { RoomBrowser } from './RoomBrowser.js';
import type { RoomListLoader } from './roomList.js';
import { probeRooms } from './probeRooms.js';
import { friendsHref, rememberRoom, roomHref, type PageHistory } from './roomHref.js';
import type { RoomMode } from './roomMode.js';
import { roomsEndpoint } from './roomsEndpoint.js';
import { netStatusText } from './statusText.js';

/**
 * The slice of the `net` service the badge reads. Without `onChange` the
 * badge only moves when `frame()` is called.
 */
export type PageRoomNet = Pick<NetService, 'state' | 'room' | 'closeReason'> &
  Partial<Pick<NetService, 'onChange'>>;

/**
 * The "Browse rooms" panel's source: the game, and how to open its live list.
 *
 * @example
 * ```ts
 * import type { PageRoomBrowse } from 'gameable/net/page';
 * import { listPublicRooms } from 'gameable/host/features';
 *
 * const browse: PageRoomBrowse = { game: 'my-game', list: listPublicRooms };
 * ```
 */
export interface PageRoomBrowse {
  /** The game's catalog name (`catalogName`). */
  readonly game: string;
  /** Opens the list. Called when the panel opens, so a page loads the room server client only then. */
  readonly list: RoomListLoader;
}

/**
 * Options for {@link createPageRoom}. Everything but `net` and `mode`
 * defaults to the browser's own.
 *
 * @example
 * ```ts
 * import type { PageRoomBadgeOptions } from 'gameable/net/page';
 * declare const options: PageRoomBadgeOptions;
 * console.log(options.mode.kind);
 * ```
 */
export interface PageRoomBadgeOptions {
  /** The page's `net` service (`engine.get('net')`). */
  readonly net: PageRoomNet;
  /** The mode the page booted in. */
  readonly mode: RoomMode;
  /** Default `document`. */
  readonly document?: Document;
  /** Default `window`: its address and history. */
  readonly page?: PageHistory;
  /** Copy text to the clipboard. Default `navigator.clipboard.writeText`. */
  readonly copy?: (text: string) => Promise<void>;
  /** Go to an address. Default `location.assign`. */
  readonly navigate?: (href: string) => void;
  /**
   * Is there a room server? Asked once on a solo page, which offers "Play
   * with friends" only on yes. Default `probeRooms(roomsEndpoint(location.href))`:
   * its `/health`, about 1.5 s at most.
   */
  readonly probe?: () => Promise<boolean>;
  /**
   * The public room list. With it the badge gains "Browse rooms", shown on a
   * solo page when the probe says yes (with "Play with friends"), and on a
   * room page at once.
   */
  readonly browse?: PageRoomBrowse;
}

/**
 * The room badge and the address it keeps up to date. It listens to
 * `net.onChange`; {@link frame} does the same check by hand (it compares three
 * fields and writes nothing while they are unchanged), for a `net` without one.
 *
 * @example
 * ```ts
 * import { createPageRoom, roomMode } from 'gameable/net/page';
 * declare const net: import('gameable/net/client').NetService;
 * const room = createPageRoom({ net, mode: roomMode(location.search) });
 * room.frame();
 * ```
 */
export class PageRoom {
  /** How many times the badge was redrawn. */
  renders = 0;
  readonly #net: PageRoomNet;
  readonly #mode: RoomMode;
  readonly #page: PageHistory;
  readonly #badge: RoomBadge;
  readonly #browser: RoomBrowser | null;
  #state = '';
  #code: string | null = null;
  #reason = '';
  #disposed = false;
  readonly #off: () => void;

  /** @param options See {@link PageRoomBadgeOptions}. */
  constructor(options: PageRoomBadgeOptions) {
    this.#net = options.net;
    this.#mode = options.mode;
    this.#page = options.page ?? window;
    const copy = options.copy ?? ((text: string) => navigator.clipboard.writeText(text));
    const navigate =
      options.navigate ??
      ((href: string) => {
        window.location.assign(href);
      });
    const doc = options.document ?? document;
    const browse = options.browse;
    this.#browser =
      browse === undefined
        ? null
        : new RoomBrowser(doc, {
            game: browse.game,
            list: browse.list,
            endpoint: () => roomsEndpoint(this.#page.location.href),
            href: () => this.#page.location.href,
            navigate,
          });
    const toggle =
      this.#browser === null
        ? {}
        : {
            browse: () => {
              this.#toggleBrowser();
            },
          };
    this.#badge = new RoomBadge(
      doc,
      options.mode.kind === 'solo'
        ? {
            playWithFriends: () => {
              navigate(friendsHref(this.#page.location.href));
            },
            ...toggle,
          }
        : {
            copyLink: () => {
              this.#copyLink(copy);
            },
            ...toggle,
          },
    );
    this.frame();
    this.#off =
      options.net.onChange?.(() => {
        this.frame();
      }) ?? (() => undefined);
    if (options.mode.kind === 'solo') {
      const probe = options.probe ?? (() => probeRooms(roomsEndpoint(this.#page.location.href)));
      void probe().then((yes) => {
        if (!this.#disposed) this.#badge.offerFriends(yes);
      });
    }
  }

  /** Redraw on a change, and remember a new or quick-matched room's code. */
  frame(): void {
    const { state, room, closeReason } = this.#net;
    if (state === this.#state && room === this.#code && closeReason === this.#reason) return;
    this.#state = state;
    this.#code = room;
    this.#reason = closeReason;
    const solo = this.#mode.kind === 'solo';
    this.#badge.show({
      state,
      code: solo || room === null ? '' : room,
      status: netStatusText(state, closeReason, solo),
    });
    this.renders += 1;
    if (state === 'joined') rememberRoom(this.#mode, room, this.#page);
  }

  /** Take the badge off the page. */
  dispose(): void {
    this.#disposed = true;
    this.#off();
    this.#browser?.dispose();
    this.#badge.dispose();
  }

  #toggleBrowser(): void {
    const browser = this.#browser;
    if (browser === null) return;
    if (browser.isOpen) browser.close();
    else void browser.open();
  }

  #copyLink(copy: (text: string) => Promise<void>): void {
    if (this.#code === null) return;
    copy(roomHref(this.#page.location.href, this.#code)).catch((error: unknown) => {
      console.warn('copy link: the clipboard refused', error);
    });
  }
}

/**
 * Put the room badge on the page.
 *
 * @param options The `net` service, the boot mode, and optional browser stand-ins.
 * @returns The room; it follows `net` on its own. `dispose()` it when done.
 *
 * @example
 * ```ts
 * import { createPageRoom, roomMode } from 'gameable/net/page';
 * declare const engine: import('gameable/core').Engine;
 * const room = createPageRoom({ net: engine.get('net'), mode: roomMode(location.search) });
 * ```
 */
export function createPageRoom(options: PageRoomBadgeOptions): PageRoom {
  return new PageRoom(options);
}
