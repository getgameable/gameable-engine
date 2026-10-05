/**
 * How every WIT command crosses a room, decided once per tag.
 *
 * The table is a `Record` over the SDK's `CommandTag`, so a command added to
 * the WIT (and so to `CommandTag`) fails the typecheck here until someone
 * decides how it replicates and what a client guest's copy of it does. Without
 * it a new command would fall through the replicator's and `LocalIds`'s
 * `default` arms silently: dropped on the way to the clients, or applied with
 * a client's entity id unshifted. `commandRoutes.test.ts` checks the table
 * against those switches tag by tag.
 */
import type { CommandTag } from '@gameable/sdk';

/**
 * How the authority's command reaches the players.
 *
 * - `state`: rebuilt from the server's world record and sent reliably when it
 *   changes (and to a late joiner), not forwarded.
 * - `transient`: a one-shot the replicator copies and forwards
 *   (`copyTransient`).
 * - `per-player`: addressed to one player (or everyone), merged into each
 *   player's view.
 * - `authority`: applied on the authority (physics, data, its own presentation)
 *   and never sent to a client.
 */
export type WireRoute = 'state' | 'transient' | 'per-player' | 'authority';

/**
 * What `LocalIds.map` does with a client-role guest's own command.
 *
 * - `drop`: refused; the authority owns it (physics).
 * - `shift`: copied with its entity, sound or camera-follow id moved into the
 *   client's local range.
 * - `pass`: applied as it is; it names no id.
 */
export type ClientRoute = 'drop' | 'shift' | 'pass';

/** One command's routes. */
export interface CommandRoute {
  readonly wire: WireRoute;
  readonly client: ClientRoute;
}

/** Every WIT command's route; adding a WIT command fails the typecheck here. */
export const COMMAND_ROUTES = {
  spawn: { wire: 'state', client: 'shift' },
  despawn: { wire: 'state', client: 'shift' },
  'set-asset': { wire: 'state', client: 'shift' },
  'set-parent': { wire: 'state', client: 'shift' },
  'set-anim': { wire: 'state', client: 'shift' },
  'set-material-param': { wire: 'state', client: 'shift' },
  'add-body': { wire: 'authority', client: 'drop' },
  'remove-body': { wire: 'authority', client: 'drop' },
  'set-body-transform': { wire: 'authority', client: 'drop' },
  'set-body-velocity': { wire: 'authority', client: 'drop' },
  'apply-impulse': { wire: 'authority', client: 'drop' },
  'set-body-enabled': { wire: 'authority', client: 'drop' },
  'move-character': { wire: 'authority', client: 'drop' },
  'spawn-character': { wire: 'state', client: 'shift' },
  'set-character-state': { wire: 'state', client: 'shift' },
  'set-clip-weights': { wire: 'state', client: 'shift' },
  'set-expression': { wire: 'state', client: 'shift' },
  'look-at': { wire: 'state', client: 'shift' },
  say: { wire: 'transient', client: 'shift' },
  'play-sound': { wire: 'transient', client: 'shift' },
  'stop-sound': { wire: 'transient', client: 'shift' },
  'set-listener': { wire: 'transient', client: 'pass' },
  'load-asset': { wire: 'transient', client: 'pass' },
  'set-pointer-lock': { wire: 'authority', client: 'pass' },
  'set-time-scale': { wire: 'authority', client: 'pass' },
  // Not replicated today: a conversation runs where its guest runs.
  conversation: { wire: 'authority', client: 'shift' },
  send: { wire: 'per-player', client: 'pass' },
  'set-player-camera': { wire: 'per-player', client: 'shift' },
  'set-player-hud': { wire: 'per-player', client: 'pass' },
  'save-player-data': { wire: 'authority', client: 'pass' },
  'save-game-data': { wire: 'authority', client: 'pass' },
  exchange: { wire: 'authority', client: 'pass' },
  // Reaches each player as their frame's `entity` field, not as a command.
  'set-player-entity': { wire: 'per-player', client: 'pass' },
} as const satisfies Record<CommandTag, CommandRoute>;
