/**
 * Applying `frame-output` to the engine.
 *
 * Order is part of the contract: transforms first, then commands front to
 * back, then — on an adapter that `appliesLocal` — the local commands, then
 * the camera, then the HUD. Commands are pooled objects owned by
 * the guest — read them, never retain them.
 */
import { TRANSFORM_STRIDE } from '@gameable/sdk';
import type { Command, FrameOutput } from '@gameable/sdk';
import type { EngineAdapter } from './adapter/EngineAdapter';

/**
 * Dispatch one command to the adapter.
 *
 * The switch is exhaustive over `Command['tag']`; adding a case to the WIT
 * variant without adding one here is a compile error, which is exactly what
 * should happen.
 *
 * @param adapter The engine.
 * @param command The command.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { applyCommand } from 'gameable/host';
 *
 * for (const command of out.commands) applyCommand(adapter, command);
 * ```
 */
export function applyCommand(adapter: EngineAdapter, command: Command): void {
  switch (command.tag) {
    case 'spawn': {
      const c = command.val;
      adapter.spawn(c.entity, c.asset, c.position, c.rotation, c.scale, {
        parent: c.parent,
        visible: c.visible,
        name: c.name,
      });
      return;
    }
    case 'despawn':
      adapter.despawn(command.val);
      return;
    case 'set-asset':
      adapter.setAsset(command.val.entity, command.val.asset);
      return;
    case 'set-parent':
      adapter.setParent(command.val.entity, command.val.parent, command.val.keepWorldTransform);
      return;
    case 'set-anim': {
      const c = command.val;
      adapter.setAnim(c.entity, c.clip, c.looping, c.speed, c.fadeMs, c.weight);
      return;
    }
    case 'set-material-param':
      adapter.setMaterialParam(command.val.entity, command.val.name, command.val.value);
      return;
    case 'add-body':
      adapter.addBody(command.val);
      return;
    case 'remove-body':
      adapter.removeBody(command.val);
      return;
    case 'set-body-transform': {
      const c = command.val;
      adapter.setBodyTransform(c.body, c.position, c.rotation, c.teleport);
      return;
    }
    case 'set-body-velocity':
      adapter.setBodyVelocity(command.val.body, command.val.linear, command.val.angular);
      return;
    case 'apply-impulse':
      adapter.applyImpulse(command.val.body, command.val.impulse, command.val.atPoint);
      return;
    case 'set-body-enabled':
      adapter.setBodyEnabled(command.val.body, command.val.enabled);
      return;
    case 'move-character': {
      const c = command.val;
      adapter.moveCharacter(c.body, c.desiredVelocity, c.jump, c.crouch, c.maxSlopeDeg);
      return;
    }
    case 'spawn-character': {
      const c = command.val;
      adapter.spawnCharacter(c.entity, c.bundle, c.position, c.rotation);
      return;
    }
    case 'set-character-state': {
      const c = command.val;
      adapter.setCharacterState(c.entity, c.state, c.velocity, c.grounded);
      return;
    }
    case 'set-clip-weights': {
      const c = command.val;
      adapter.setClipWeights(c.entity, c.clips, c.weights, c.timeScale);
      return;
    }
    case 'set-expression':
      adapter.setExpression(command.val.entity, command.val.space, command.val.weights);
      return;
    case 'look-at':
      adapter.lookAt(command.val.entity, command.val.target, command.val.weight);
      return;
    case 'conversation': {
      adapter.conversation(command.val);
      break;
    }
    case 'say': {
      const c = command.val;
      adapter.say(c.entity, c.text, c.audio, c.visemes);
      return;
    }
    case 'play-sound': {
      const c = command.val;
      adapter.playSound(
        c.sound,
        c.asset,
        c.entity,
        c.position,
        c.volume,
        c.pitch,
        c.looping,
        c.bus,
      );
      return;
    }
    case 'stop-sound':
      adapter.stopSound(command.val.sound, command.val.fadeMs);
      return;
    case 'set-listener': {
      const c = command.val;
      adapter.setListener(c.position, c.rotation, c.velocity);
      return;
    }
    case 'load-asset':
      adapter.loadAsset(command.val.asset, command.val.priority);
      return;
    case 'set-pointer-lock':
      adapter.setPointerLock(command.val);
      return;
    case 'set-time-scale':
      adapter.setTimeScale(command.val);
      return;
    case 'send': {
      const c = command.val;
      adapter.send(c.to ?? undefined, c.name, c.payload, c.reliable);
      return;
    }
    case 'set-player-camera':
      adapter.setPlayerCamera(command.val.player, command.val.camera);
      return;
    case 'set-player-hud':
      adapter.setPlayerHud(command.val.player, command.val.hud);
      return;
    case 'save-player-data':
      adapter.savePlayerData(command.val.player, command.val.data);
      return;
    case 'save-game-data':
      adapter.saveGameData(command.val.data);
      return;
    case 'exchange':
      adapter.exchange(command.val);
      return;
    case 'set-player-entity':
      adapter.setPlayerEntity(command.val.player, command.val.entity);
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled command ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Apply a whole `frame-output`.
 *
 * @param adapter The engine.
 * @param out The guest's output for this frame.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { applyOutput } from 'gameable/host';
 *
 * applyOutput(adapter, sandbox.tick(input));
 * ```
 */
export function applyOutput(adapter: EngineAdapter, out: FrameOutput): void {
  const rows = (out.transforms.length / TRANSFORM_STRIDE) | 0;
  adapter.applyTransforms(out.transforms, rows);
  // An index loop, not `for...of`: this runs once per fixed step and an
  // iterator object per frame is exactly the kind of allocation AGENTS rule 2
  // is about.
  const commands = out.commands;
  for (let i = 0; i < commands.length; i += 1) applyCommand(adapter, commands[i]);
  // The authority's own: applied here, after the shared ones, and never seen by
  // the replicator, which reads `out.commands` alone.
  if (adapter.appliesLocal) {
    const local = out.localCommands;
    adapter.localScope?.(true);
    for (let i = 0; i < local.length; i += 1) applyCommand(adapter, local[i]);
    adapter.localScope?.(false);
  }
  adapter.setCamera(out.camera);
  adapter.setHud(out.hud ?? undefined);
}
