/**
 * The words a page shows for its room's state and for why it closed.
 */
import type { NetState } from '../client/NetService.js';

/** Why a room closed, in words. Keys are `net.closeReason` values. */
const REASONS: Readonly<Partial<Record<string, string>>> = {
  full: 'the room is full',
  origin: 'the room server does not accept pages from this address',
  capacity: 'the room server is at capacity; try again soon',
  'no-room': 'no room has that code',
  'no-server': 'no room server answers at this address',
  busy: 'too many tries from this address; wait a moment',
  expired: 'the held seat expired',
  refused: 'the room server refused the join',
  lost: 'the connection was lost',
  left: 'you left the room',
  shutdown: 'the room server shut down',
  ended: 'the room ended',
  crashed: 'the room crashed',
  flood: 'this page sent too much, too fast',
  version: 'this page and the room server are different versions; reload the page',
  idle: 'the room heard nothing from this page for too long; reload to take your seat back',
};

/**
 * A close reason in words, with the reason code in brackets so a report can
 * quote it.
 *
 * @param reason `net.closeReason`.
 * @returns The sentence, or the reason itself when it has none.
 *
 * @example
 * ```ts
 * import { closeReasonText } from 'gameable/net/page';
 * closeReasonText('full'); // 'the room is full (full)'
 * ```
 */
export function closeReasonText(reason: string): string {
  const text = REASONS[reason];
  return text === undefined ? reason : `${text} (${reason})`;
}

/**
 * The status line for a room page.
 *
 * @param state `net.state`.
 * @param reason `net.closeReason`.
 * @param solo True when the authority runs in this page.
 * @returns `Connecting…`, `Joined`, `Playing solo`, `Reconnecting…` or `Lost: <why>`.
 *
 * @example
 * ```ts
 * import { netStatusText } from 'gameable/net/page';
 * netStatusText('closed', 'capacity', false); // 'Lost: the room server is at capacity; ...'
 * ```
 */
export function netStatusText(state: NetState, reason: string, solo: boolean): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'joined':
      return solo ? 'Playing solo' : 'Joined';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'closed':
      return `Lost: ${closeReasonText(reason === '' ? 'lost' : reason)}`;
  }
}
