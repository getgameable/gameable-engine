/**
 * The guest's `tick`, in the fixed order `runtime.ts` documents: decode the
 * frame, ingest the bodies, the built-in look and velocity systems, the user
 * systems and `update`, the camera rig, then pack the output.
 */
import { copyInput } from '../inputLanes';
import { checkRealm, setActiveRuntime } from '../state';
import { guard } from './parts';
import type { FrameInput, FrameOutput } from '../types';
import type { GuestParts } from './parts';

/** How many consecutive failing ticks before the guest declares itself dead. */
const FAILURE_LIMIT = 8;

/**
 * Decode `frame-input` into the runtime's preallocated storage.
 *
 * @param parts The guest.
 * @param frameInput The incoming record.
 */
function decode({ rt, spawner, net, data }: GuestParts, frameInput: FrameInput): void {
  rt.frame = Number(frameInput.frame);
  rt.dt = frameInput.dt;
  rt.elapsed = frameInput.elapsed;
  copyInput(rt, frameInput.input);
  rt.players.decode(frameInput.players);
  rt.contacts = frameInput.contacts;
  rt.events = frameInput.events;
  rt.players.applyEvents(rt.events, rt.net.role === 'authority' ? spawner : null);
  rt.players.refresh();
  net.beginTick();
  data.beginTick(rt.events);
}

/**
 * Run the user systems and `update`, and count a failing tick.
 *
 * @param parts The guest.
 */
function runUserCode(parts: GuestParts): void {
  const { rt, host, ctx, systems, systemLabels, update } = parts;
  let ok = true;
  for (let i = 0; i < systems.length; i += 1) {
    ok = guard(host, systemLabels[i], systems[i], ctx) && ok;
  }
  if (update) ok = guard(host, 'update()', update, ctx) && ok;

  if (ok) {
    rt.failures = 0;
  } else {
    rt.failures += 1;
    if (rt.failures >= FAILURE_LIMIT) {
      rt.dead = true;
      host.log(
        'error',
        `guest is dead: ${String(FAILURE_LIMIT)} consecutive failing ticks. Rebuild the sandbox.`,
      );
    }
  }
}

/**
 * The guest's WIT `tick`.
 *
 * @param parts The guest.
 * @param frameInput This step's `frame-input`.
 * @returns The reused `frame-output`; a dead guest's carries no new work.
 */
export function tickGuest(parts: GuestParts, frameInput: FrameInput): FrameOutput {
  const { rt, output } = parts;
  checkRealm(rt);
  if (rt.dead) {
    output.transforms = rt.packer.pack();
    output.commands = rt.commands.list;
    output.localCommands = rt.localCommands.list;
    output.hud = undefined;
    return output;
  }

  const previous = setActiveRuntime(rt);
  try {
    if (rt.carryCommands) {
      rt.carryCommands = false;
    } else {
      rt.commands.reset();
      rt.localCommands.reset();
    }
    rt.hud.pending = undefined;

    decode(parts, frameInput);
    rt.bodyIndex.ingest(frameInput.bodies);
    parts.builtins.look();
    parts.builtins.velocity();
    runUserCode(parts);
    parts.builtins.camera();

    output.transforms = rt.packer.pack();
    output.commands = rt.commands.list;
    output.localCommands = rt.localCommands.list;
    output.camera = rt.camera;
    output.hud = rt.hud.pending;
    return output;
  } finally {
    setActiveRuntime(previous);
  }
}
