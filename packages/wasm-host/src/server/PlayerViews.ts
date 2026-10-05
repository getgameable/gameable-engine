/**
 * `PlayerViews` — what each player is shown beyond the shared world.
 *
 * One {@link PerPlayerOutput} per player id, indexed by the id itself and made
 * the first time a command names that player. A player's own camera or HUD
 * (`set-player-camera` / `set-player-hud`) wins over the frame's for that tick.
 * The ownership flags clear on `rewind`. The guest's camera and its
 * `send` records are pooled objects it rewrites every tick, so both are copied
 * field by field into storage this class owns: a tick allocates nothing once
 * every player has been seen and the send pool has grown to the busiest tick.
 */
import type { CameraState, SendCmd, Vec3 } from '@gameable/sdk';
import { MAX_PLAYER_ID } from '@gameable/sdk/wire';

import { copyQuat, copyVec } from './copies';
import type { PerPlayerOutput } from './types';
import type { WarnOnce } from './WarnOnce';

/** One player's view, with the camera storage it copies into. */
class PlayerView implements PerPlayerOutput {
  camera: CameraState | undefined = undefined;
  hud: string | undefined = undefined;
  cameraSource: 'none' | 'frame' | 'player' = 'none';
  readonly sends: SendCmd[] = [];
  /** A `set-player-camera` named this player this tick: the frame camera does not apply. */
  ownsCamera = false;
  /** A `set-player-hud` named this player this tick: the frame HUD does not apply. */
  ownsHud = false;

  private readonly own: CameraState = {
    mode: 'first-person',
    projection: 'perspective',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    target: undefined,
    fovYDeg: 60,
    near: 0.1,
    far: 1000,
    follow: undefined,
    armLength: 0,
    offset: { x: 0, y: 0, z: 0 },
  };
  private readonly ownTarget: Vec3 = { x: 0, y: 0, z: 0 };

  /** @param player The player id. */
  constructor(readonly player: number) {}

  /** @param camera The guest's camera, copied. */
  copyCamera(camera: CameraState): void {
    const own = this.own;
    own.mode = camera.mode;
    own.projection = camera.projection;
    copyVec(own.position, camera.position);
    copyQuat(own.rotation, camera.rotation);
    own.target = camera.target === undefined ? undefined : copyVec(this.ownTarget, camera.target);
    own.fovYDeg = camera.fovYDeg;
    own.near = camera.near;
    own.far = camera.far;
    own.follow = camera.follow;
    own.armLength = camera.armLength;
    copyVec(own.offset, camera.offset);
    this.camera = own;
  }
}

/**
 * The per-player outputs, and the tick's broadcast sends.
 *
 * @example
 * ```ts
 * // Internal to the server adapter:
 * const views = new PlayerViews(new WarnOnce(console.warn));
 * views.setPlayerHud(2, '{"role":"murderer"}');
 * console.log(views.list[2].hud);
 * ```
 */
export class PlayerViews {
  /** One entry per player id, `list[id]`; player 0 always exists. */
  readonly list: PerPlayerOutput[] = [new PlayerView(0)];
  /** This tick's sends with no `to`: every player's. Cleared by {@link PlayerViews.rewind}. */
  readonly broadcasts: SendCmd[] = [];
  /** Every send of the tick, in emission order, each with its `to`. */
  readonly log: SendCmd[] = [];

  private readonly views: PlayerView[] = this.list as PlayerView[];
  private readonly pool: SendCmd[] = [];
  private used = 0;

  /** @param warnings Where a refused player id is reported, once. */
  constructor(private readonly warnings: WarnOnce) {}

  /** Start a tick: every player's sends, and the broadcasts, are spent. */
  rewind(): void {
    for (let i = 0; i < this.views.length; i += 1) {
      const view = this.views[i];
      view.sends.length = 0;
      view.ownsCamera = false;
      view.ownsHud = false;
    }
    this.broadcasts.length = 0;
    this.log.length = 0;
    this.used = 0;
  }

  /** @param camera The guest's frame camera: player 0's, unless player 0 has their own this tick. */
  setCamera(camera: CameraState): void {
    const view = this.views[0];
    if (view.ownsCamera) return;
    view.copyCamera(camera);
    if (view.cameraSource !== 'player') view.cameraSource = 'frame';
  }

  /** @param json HUD JSON for player 0, or `undefined` for "unchanged"; a player-0 `set-player-hud` wins. */
  setHud(json: string | undefined): void {
    const view = this.views[0];
    if (json !== undefined && !view.ownsHud) view.hud = json;
  }

  /**
   * @param player The player.
   * @param camera The guest's camera for them, copied.
   */
  setPlayerCamera(player: number, camera: CameraState): void {
    const view = this.view(player);
    if (view === undefined) return;
    view.copyCamera(camera);
    view.ownsCamera = true;
    view.cameraSource = 'player';
  }

  /**
   * @param player The player.
   * @param hud Their HUD JSON.
   */
  setPlayerHud(player: number, hud: string): void {
    const view = this.view(player);
    if (view === undefined) return;
    view.hud = hud;
    view.ownsHud = true;
  }

  /**
   * Keep a pooled copy of a `send`: on `sends` of its addressee, or on
   * {@link PlayerViews.broadcasts} when it names none.
   *
   * @param to The addressee, or undefined for every player.
   * @param name Message name.
   * @param payload JSON payload.
   * @param reliable Whether it must arrive.
   */
  send(to: number | undefined, name: string, payload: string, reliable: boolean): void {
    const target = to === undefined ? this.broadcasts : this.view(to)?.sends;
    if (target === undefined) return;
    let copy = this.pool[this.used] as SendCmd | undefined;
    if (copy === undefined) {
      copy = { to: undefined, name: '', payload: '', reliable: false };
      this.pool.push(copy);
    }
    this.used += 1;
    copy.to = to;
    copy.name = name;
    copy.payload = payload;
    copy.reliable = reliable;
    target.push(copy);
    this.log.push(copy);
  }

  /**
   * @param player A player id.
   * @returns Its view, made (with every lower id) the first time; undefined past the ceiling.
   */
  private view(player: number): PlayerView | undefined {
    // Past the SDK's player-id ceiling: refused rather than grown into, a typo, not a room.
    if (player > MAX_PLAYER_ID) {
      this.warnings.warn('gameable:player-id', () => {
        return `gameable: player ${String(player)} is past ${String(MAX_PLAYER_ID)}; its view is ignored`;
      });
      return undefined;
    }
    while (this.views.length <= player) this.views.push(new PlayerView(this.views.length));
    return this.views[player];
  }
}
