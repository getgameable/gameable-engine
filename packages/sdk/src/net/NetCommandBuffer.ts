/**
 * The command buffer, plus the commands a room game sends to its players.
 *
 * A subclass rather than three more methods on `CommandBuffer`, which is
 * already the largest file in the SDK: the pooling is the base class's, the
 * net vocabulary is this one's.
 */
import { CommandBuffer } from '../commands';
import type {
  CameraState,
  ExchangeCmd,
  SaveGameDataCmd,
  SavePlayerDataCmd,
  SendCmd,
  SetPlayerCameraCmd,
  SetPlayerEntityCmd,
  SetPlayerHudCmd,
} from '../types';

/** @returns A fully shaped, empty `send` payload. */
const makeSend = (): SendCmd => ({ to: undefined, name: '', payload: '', reliable: true });

/** @returns A fully shaped `set-player-hud` payload. */
const makeSetPlayerHud = (): SetPlayerHudCmd => ({ player: 0, hud: '' });

/** @returns A fully shaped `set-player-entity` payload. */
const makeSetPlayerEntity = (): SetPlayerEntityCmd => ({ player: 0, entity: 0 });

/** @returns A fully shaped `save-player-data` payload. */
const makeSavePlayer = (): SavePlayerDataCmd => ({ player: 0, data: '' });

/** @returns A fully shaped `save-game-data` payload. */
const makeSaveGame = (): SaveGameDataCmd => ({ data: '' });

/** @returns A fully shaped `exchange` payload. */
const makeExchange = (): ExchangeCmd => ({ id: 0, a: 0, b: 0, give: '', take: '' });

/** The camera a fresh `set-player-camera` slot points at until it is written. */
const NO_CAMERA = {} as CameraState;

/** @returns A fully shaped `set-player-camera` payload. */
const makeSetPlayerCamera = (): SetPlayerCameraCmd => ({ player: 0, camera: NO_CAMERA });

/**
 * A `CommandBuffer` that also queues `send`, `set-player-hud`,
 * `set-player-camera`, `set-player-entity` and the store's
 * `save-player-data`, `save-game-data` and `exchange`.
 */
export class NetCommandBuffer extends CommandBuffer {
  /**
   * Bumped by every `reset`, so a per-player facade can tell "already queued
   * this tick" from "queued last tick" without a per-tick sweep.
   */
  generation = 0;

  /** Rewind for a new frame, keeping every pooled object. */
  override reset(): void {
    super.reset();
    this.generation += 1;
  }

  /**
   * Send a game message.
   *
   * @param to One player, or `undefined` for every player (or, on a client, the authority).
   * @param name The message name.
   * @param payload The JSON payload.
   * @param reliable Ordered and guaranteed when true.
   */
  send(to: number | undefined, name: string, payload: string, reliable: boolean): void {
    const c = this.take<SendCmd>('send', makeSend);
    c.to = to;
    c.name = name;
    c.payload = payload;
    c.reliable = reliable;
  }

  /**
   * Replace one player's HUD for this step.
   *
   * @param player The player id.
   * @param hud The HUD model as JSON.
   */
  setPlayerHud(player: number, hud: string): void {
    const c = this.take<SetPlayerHudCmd>('set-player-hud', makeSetPlayerHud);
    c.player = player;
    c.hud = hud;
  }

  /**
   * Tell the host which entity a player controls.
   *
   * @param player The player id.
   * @param entity The entity, or 0 for none.
   */
  setPlayerEntity(player: number, entity: number): void {
    const c = this.take<SetPlayerEntityCmd>('set-player-entity', makeSetPlayerEntity);
    c.player = player;
    c.entity = entity;
  }

  /**
   * Replace one player's camera for this step.
   *
   * @param player The player id.
   * @param camera The player's own camera record, which the slot points at
   *   (not a copy): it is read when the frame is returned, exactly as the
   *   frame's own `camera` is.
   */
  setPlayerCamera(player: number, camera: CameraState): void {
    const c = this.take<SetPlayerCameraCmd>('set-player-camera', makeSetPlayerCamera);
    c.player = player;
    c.camera = camera;
  }

  /**
   * Ask the room's store to keep one player's document.
   *
   * @param player The player id.
   * @param data The document as JSON.
   */
  savePlayerData(player: number, data: string): void {
    const c = this.take<SavePlayerDataCmd>('save-player-data', makeSavePlayer);
    c.player = player;
    c.data = data;
  }

  /**
   * Ask the room's store to keep the game's own document.
   *
   * @param data The document as JSON.
   */
  saveGameData(data: string): void {
    this.take<SaveGameDataCmd>('save-game-data', makeSaveGame).data = data;
  }

  /**
   * Ask the room's store for a trade between two players' documents.
   *
   * @param id The guest's id for it, echoed in the `exchange-result`.
   * @param a The first player.
   * @param b The second player.
   * @param give What a gives b, as JSON.
   * @param take What a takes from b, as JSON.
   */
  exchange(id: number, a: number, b: number, give: string, take: string): void {
    const c = this.take<ExchangeCmd>('exchange', makeExchange);
    c.id = id;
    c.a = a;
    c.b = b;
    c.give = give;
    c.take = take;
  }
}
