/**
 * `ReplicaWriter` — the authority's world, applied to the page's adapter
 * inside a fixed step: a new welcome's rebuild, the queued commands in order,
 * then the queued rows, blended across the send interval by a
 * `RowInterpolator`. It also keeps this player's own camera and HUD as the
 * authority last set them, because the room sends them only when they change
 * and the page must keep showing them in between.
 */
import type { CameraState, Command, SpawnCmd } from '@gameable/sdk';
import { applyCommand } from '@gameable/wasm-host';

import type { PlayerRow } from '../protocol/types.js';
import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import type { FramedRowSink, NetService } from './NetService.js';
import { RowInterpolator } from './RowInterpolator.js';

/** Applies the `net` service's queues to an adapter. */
export class ReplicaWriter {
  /** The rows sink: each decoded row goes into the interpolator, tagged with its frame. */
  readonly sink: FramedRowSink;
  /** Each entity's last two rows; writes the blend every step. */
  readonly motion = new RowInterpolator();
  /** Where each rows frame's player trailer goes (the predictor); null ignores it. */
  onPlayer: ((row: PlayerRow) => void) | null = null;
  /** The entities the authority introduced and has not taken away, in spawn order. */
  private readonly known = new Set<number>();
  private camera: CameraState | null = null;
  private hud: string | null = null;
  private welcomes = 0;
  private rowsFrame = 0;
  private warnedRange = false;
  private readonly pose = new Float32Array(10);

  /**
   * @param adapter Where the world is drawn.
   * @param net Where it comes from.
   * @param entityBase Where client-local entity ids start; an authority id at or past it is warned about.
   */
  constructor(
    private readonly adapter: ClientLoopAdapter,
    private readonly net: NetService,
    private readonly entityBase = Number.MAX_SAFE_INTEGER,
  ) {
    const position = new Float32Array(3);
    const rotation = new Float32Array(4);
    const scale = new Float32Array(3);
    this.sink = {
      position,
      rotation,
      scale,
      beginFrame: (frame) => {
        this.rowsFrame = frame;
      },
      row: (entity, flags) => {
        this.motion.push(entity, flags, this.rowsFrame, position, rotation, scale);
      },
      player: (row) => {
        this.onPlayer?.(row);
      },
    };
  }

  /** @returns True when the authority has set this player's camera since the last welcome. */
  get hasCamera(): boolean {
    return this.camera !== null;
  }

  /** @returns True when the authority has set this player's HUD since the last welcome. */
  get hasHud(): boolean {
    return this.hud !== null;
  }

  /**
   * Apply everything that arrived since the last step.
   *
   * @returns True when a new welcome rebuilt the world (the caller restarts
   *   its input sequence).
   */
  apply(): boolean {
    const net = this.net;
    const rebuilt = net.welcomes !== this.welcomes;
    if (rebuilt) this.rebuild(net.welcomes);
    net.drainCommands(this.onCommand);
    net.drainRows(this.sink);
    this.motion.step(this.adapter);
    return rebuilt;
  }

  /**
   * Show the step's camera: the authority's for this player when it has set
   * one, else the client guest's own.
   *
   * @param guest The client guest's frame camera, if a guest runs.
   */
  applyCamera(guest: CameraState | undefined): void {
    const camera = this.camera ?? guest;
    if (camera !== undefined) this.adapter.setCamera(camera);
  }

  /** @param welcomes The welcome count now: take the old world down first. */
  private rebuild(welcomes: number): void {
    this.welcomes = welcomes;
    // Children were introduced after their parents, so they go first. A
    // reconnect is rare; this one allocation is its cost.
    const old = Array.from(this.known).reverse();
    this.known.clear();
    for (const entity of old) this.adapter.despawn(entity);
    this.motion.clear();
    this.camera = null;
    this.hud = null;
  }

  /**
   * One authority command, bound once so a drain allocates no closure.
   *
   * @param command The command.
   */
  private readonly onCommand = (command: Command): void => {
    switch (command.tag) {
      case 'spawn':
        this.known.add(command.val.entity);
        this.introduce(command.val);
        break;
      case 'despawn':
        this.known.delete(command.val);
        this.motion.remove(command.val);
        break;
      case 'set-player-camera':
        // The room sends this player's only; the page adapter's own player id
        // is fixed when it is made, before the seat is known, so it is kept here.
        if (command.val.player === this.net.localPlayer) this.camera = command.val.camera;
        return;
      case 'set-player-hud':
        if (command.val.player !== this.net.localPlayer || command.val.hud === this.hud) return;
        this.hud = command.val.hud;
        this.adapter.setHud(this.hud);
        return;
      case 'set-player-entity':
        // "Which entity is mine" arrives in each frame's `entity` field.
        return;
      default:
        break;
    }
    applyCommand(this.adapter, command);
  };

  /** @param spawn A replicated spawn: its pose is where the entity blends from. */
  private introduce(spawn: SpawnCmd): void {
    if (spawn.entity > this.entityBase && !this.warnedRange) {
      this.warnedRange = true;
      console.warn(
        `gameable: the authority spawned entity ${String(spawn.entity)}, past the client's local id ` +
          `base ${String(this.entityBase)}; pass the game's world.maxEntities as the client loop's entityBase`,
      );
    }
    const pose = this.pose;
    const { position: p, rotation: r, scale: k } = spawn;
    pose[0] = p.x;
    pose[1] = p.y;
    pose[2] = p.z;
    pose[3] = r.x;
    pose[4] = r.y;
    pose[5] = r.z;
    pose[6] = r.w;
    pose[7] = k.x;
    pose[8] = k.y;
    pose[9] = k.z;
    this.motion.spawn(spawn.entity, pose);
  }
}
