/**
 * What a client-role guest's frame does on its page.
 *
 * Everything a client guest emits is its own presentation, applied here and
 * sent nowhere, except `send`, which goes up to the authority as a `msg`:
 *
 * - its commands and local commands (sounds, HUD, local spawns, particles),
 *   with every entity and sound id moved into the client's own range by
 *   `LocalIds`, so they never land on an authority entity; physics commands
 *   are dropped, because the authority owns the simulation, except, on a
 *   page that predicts, the guest's own character body (`Predictor`);
 * - its transform rows, for its own entities, shifted the same way;
 * - its frame camera, unless the authority set this player's camera;
 * - its HUD, unless the authority set this player's HUD.
 *
 * A client guest never makes a shared entity: the SDK runs no level spawns
 * on a client.
 */
import type { Command, FrameOutput } from '@gameable/sdk';
import { applyCommand } from '@gameable/wasm-host';

import { COMMAND_ROUTES } from '../protocol/commandRoutes.js';

import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import type { LocalIds } from './LocalIds.js';
import type { NetService } from './NetService.js';
import type { Predictor } from './Predictor.js';
import type { ReplicaWriter } from './ReplicaWriter.js';

/** The commands a client guest may not apply itself: the authority's physics. */
const PHYSICS: ReadonlySet<string> = new Set(
  Object.entries(COMMAND_ROUTES).flatMap(([tag, route]) => (route.client === 'drop' ? [tag] : [])),
);

/**
 * @param adapter The page adapter.
 * @param command One client guest command.
 * @param net Where a `send` goes.
 * @param ids The id shifter.
 * @param local True for a local command: a `send` there never leaves the page.
 * @param predictor The page's prediction, or null: then every physics command is dropped.
 */
function applyOne(
  adapter: ClientLoopAdapter,
  command: Command,
  net: NetService,
  ids: LocalIds,
  local: boolean,
  predictor: Predictor | null,
): void {
  if (command.tag === 'send') {
    if (!local) net.sendJson(command.val.name, command.val.payload);
    return;
  }
  if (predictor !== null && PHYSICS.has(command.tag)) {
    predictor.command(command, ids);
    return;
  }
  const mapped = ids.map(command);
  if (mapped !== null) applyCommand(adapter, mapped);
}

/**
 * Apply one client guest frame.
 *
 * @param adapter The page adapter.
 * @param out The guest's frame.
 * @param net Where its sends go.
 * @param replica The authority's view, which wins for the camera and HUD.
 * @param ids Moves the guest's ids into the client's own range.
 * @param predictor The page's prediction, or null when it does not predict.
 */
export function applyGuestOutput(
  adapter: ClientLoopAdapter,
  out: FrameOutput,
  net: NetService,
  replica: ReplicaWriter,
  ids: LocalIds,
  predictor: Predictor | null = null,
): void {
  ids.begin();
  const rows = ids.mapTransforms(out.transforms);
  if (rows > 0) adapter.applyTransforms(ids.rows, rows);
  const commands = out.commands;
  for (let i = 0; i < commands.length; i += 1)
    applyOne(adapter, commands[i], net, ids, false, predictor);
  const local = out.localCommands;
  for (let i = 0; i < local.length; i += 1) applyOne(adapter, local[i], net, ids, true, predictor);
  replica.applyCamera(ids.mapCamera(out.camera));
  const hud = out.hud ?? undefined;
  if (hud !== undefined && !replica.hasHud) adapter.setHud(hud);
}
