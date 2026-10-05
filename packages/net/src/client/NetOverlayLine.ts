/**
 * `NetOverlayLine` — the `net` lines of the F3 debug overlay: where the page
 * is in its room, who is there, the round trip, how fast rows arrive, how
 * often a predicting page's own body was corrected, and which entity this
 * page's player controls.
 */
import type { DebugOverlay } from '@gameable/core';

import type { NetService } from './NetService.js';

/** Shown in place of a room code before the welcome names one. */
const NO_ROOM = '----';

/**
 * Builds the overlay's `net` text from a `NetService`. The overlay calls
 * {@link NetOverlayLine.text} only when it redraws (four times a second by
 * default), so the rows rate is measured over the time between two redraws.
 *
 * @example
 * ```ts
 * import { createNetOverlayLine, type NetService } from 'gameable/net/client';
 * declare const net: NetService;
 * const line = createNetOverlayLine(net);
 * console.log(line.text());
 * // net    joined KQTX  players 2/6  rtt 34 ms
 * //        rows 20/s  stale 0  corrections 0  you entity 12, seat 0
 * ```
 */
export class NetOverlayLine {
  private lastRows: number;
  private lastAt: number;
  private rate = 0;

  /**
   * @param net The room service to read.
   * @param now The clock, in ms. Defaults to `performance.now`.
   */
  constructor(
    private readonly net: NetService,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.lastRows = net.stats.rowsFrames;
    this.lastAt = now();
  }

  /**
   * The current text, two lines. Bound, so it can be handed to the overlay as is.
   *
   * @returns The `net` lines, without a trailing newline.
   */
  readonly text = (): string => {
    const net = this.net;
    const at = this.now();
    const elapsed = at - this.lastAt;
    if (elapsed > 0) {
      this.rate = ((net.stats.rowsFrames - this.lastRows) * 1000) / elapsed;
      this.lastRows = net.stats.rowsFrames;
      this.lastAt = at;
    }
    let connected = 0;
    const players = net.players;
    for (let i = 0; i < players.length; i += 1) if (players[i].connected) connected += 1;
    const you = net.localEntity === 0 ? 'no entity' : `entity ${String(net.localEntity)}`;
    const seat = net.localPlayer < 0 ? 'no seat' : `seat ${String(net.localPlayer)}`;
    return (
      `net    ${net.state} ${net.room ?? NO_ROOM}  players ${String(connected)}/${String(net.maxPlayers)}` +
      `  rtt ${net.rtt.toFixed(0)} ms\n` +
      `       rows ${this.rate.toFixed(0)}/s  stale ${String(net.stats.staleRows)}` +
      `  corrections ${String(net.stats.corrections)}  you ${you}, ${seat}`
    );
  };
}

/**
 * Make the overlay's `net` lines for a room service.
 *
 * @param net The room service to read.
 * @param now The clock, in ms. Defaults to `performance.now`.
 * @returns The line builder; hand its `text` to `overlay.setExtra`.
 *
 * @example
 * ```ts
 * import type { DebugOverlay } from 'gameable/core';
 * import { createNetOverlayLine, type NetService } from 'gameable/net/client';
 * declare const net: NetService;
 * declare const overlay: DebugOverlay;
 * overlay.setExtra(createNetOverlayLine(net).text);
 * ```
 */
export function createNetOverlayLine(net: NetService, now?: () => number): NetOverlayLine {
  return new NetOverlayLine(net, now);
}

/**
 * Put the `net` lines on an engine's debug overlay, when it has one. A
 * headless engine, or a page built without `debug`, has none, and this does
 * nothing.
 *
 * @param engine The booted engine (`feature.bind`'s argument).
 * @param net The room service to show.
 * @returns True when the lines were added.
 *
 * @example
 * ```ts
 * import type { Engine } from 'gameable/core';
 * import { showNetOnOverlay, type NetService } from 'gameable/net/client';
 * declare const engine: Engine;
 * declare const net: NetService;
 * showNetOnOverlay(engine, net);
 * ```
 */
export function showNetOnOverlay(engine: object, net: NetService): boolean {
  const overlay = (engine as { overlay?: DebugOverlay | null }).overlay;
  if (overlay === undefined || overlay === null) return false;
  overlay.setExtra(createNetOverlayLine(net).text);
  return true;
}
