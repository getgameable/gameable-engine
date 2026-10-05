/**
 * `PlayerCommands` — what the page does with the net and data commands.
 *
 * A page shows exactly one player: `localPlayer` (0 in a single-player game).
 * A `set-player-camera` or `set-player-hud` for that player is applied as the
 * frame's own camera or HUD; one for anyone else is not this page's to show
 * and is dropped. A `send` goes to the `send` sink when the page has one (the
 * client transport, phase 3) and is dropped otherwise. The data commands need
 * the room's store, which only an authority has, so the page warns once each.
 *
 * A player's own camera and HUD win over the frame's for that step: once a
 * `set-player-camera` (or `set-player-hud`) for the local player has been
 * applied, {@link PlayerCommands.ownsCamera} (or `ownsHud`) is true and the
 * adapter skips the frame's `setCamera` (or `setHud`) until
 * {@link PlayerCommands.beginStep}, which the adapter's `beginFixedStep` calls.
 */
import type { CameraState } from '@gameable/sdk';

import type { EngineAdapter } from './EngineAdapter';

/** The adapter methods this class answers for. */
export type PlayerCommandMethods = Pick<
  EngineAdapter,
  | 'send'
  | 'setPlayerCamera'
  | 'setPlayerHud'
  | 'savePlayerData'
  | 'saveGameData'
  | 'exchange'
  | 'setPlayerEntity'
>;

/**
 * The page adapter options this class reads.
 *
 * @example
 * ```ts
 * const adapter = createEngineAdapter(engine, {
 *   localPlayer: 2,
 *   send: (to, name, payload, reliable) => transport.send(name, payload, reliable),
 * });
 * ```
 */
export interface PlayerCommandOptions {
  /** The player this page shows. Defaults to 0, the single-player player. */
  localPlayer?: number;
  /**
   * Where the guest's `send` commands go: the client transport. Without one
   * they are dropped. Called during `applyOutput`; copy what you keep.
   *
   * @param to The addressee, or undefined for the authority / everyone.
   * @param name Message name.
   * @param payload JSON payload.
   * @param reliable Whether it must arrive.
   */
  send?: (to: number | undefined, name: string, payload: string, reliable: boolean) => void;
}

/** The two page-adapter methods a local player's view is applied through. */
export interface LocalView {
  /** The adapter's own `setCamera`. */
  setCamera(camera: CameraState): void;
  /** The adapter's own `setHud`. */
  setHud(json: string | undefined): void;
}

/**
 * The page's half of the net and data commands.
 *
 * @example
 * ```ts
 * // Inside createEngineAdapter:
 * const players = new PlayerCommands(options, warn);
 * const adapter = { ...players.methods, setCamera, setHud };
 * players.show(adapter);
 * players.setPlayerHud(0, '{"hp":3}'); // shown: player 0 is this page's player
 * players.setPlayerHud(4, '{"hp":1}'); // dropped
 * ```
 */
export class PlayerCommands {
  /** The seven adapter methods, bound once, to spread into the adapter. */
  readonly methods: PlayerCommandMethods = {
    send: (to, name, payload, reliable) => {
      this.send(to, name, payload, reliable);
    },
    setPlayerCamera: (player, camera) => {
      this.setPlayerCamera(player, camera);
    },
    setPlayerHud: (player, hud) => {
      this.setPlayerHud(player, hud);
    },
    savePlayerData: () => {
      this.savePlayerData();
    },
    saveGameData: () => {
      this.saveGameData();
    },
    exchange: () => {
      this.exchange();
    },
    // The page's player is its own; a client learns its entity from the room's frames.
    setPlayerEntity: () => undefined,
  };

  /** True from a local `set-player-camera` until the next step: the frame camera is skipped. */
  ownsCamera = false;
  /** True from a local `set-player-hud` until the next step: the frame HUD is skipped. */
  ownsHud = false;

  private readonly localPlayer: number;
  private view: LocalView | null = null;

  /**
   * @param options The local player id and the send sink.
   * @param warn The adapter's warn-once sink, keyed on the message.
   */
  constructor(
    private readonly options: PlayerCommandOptions,
    private readonly warn: (key: string) => void,
  ) {
    this.localPlayer = options.localPlayer ?? 0;
  }

  /**
   * Say where the local player's camera and HUD are applied: the adapter itself.
   *
   * @param view The adapter's own `setCamera` / `setHud`.
   */
  show(view: LocalView): void {
    this.view = view;
  }

  /** A new step: the frame's camera and HUD apply again until a player's own one arrives. */
  beginStep(): void {
    this.ownsCamera = false;
    this.ownsHud = false;
  }

  /**
   * @param to The addressee, or undefined.
   * @param name Message name.
   * @param payload JSON payload.
   * @param reliable Whether it must arrive.
   */
  send(to: number | undefined, name: string, payload: string, reliable: boolean): void {
    this.options.send?.(to, name, payload, reliable);
  }

  /**
   * @param player The player the camera is for.
   * @param camera The camera; applied only for the local player.
   */
  setPlayerCamera(player: number, camera: CameraState): void {
    if (player !== this.localPlayer) return;
    // Open the gate for this write, then shut it on the frame camera that follows.
    this.ownsCamera = false;
    this.view?.setCamera(camera);
    this.ownsCamera = true;
  }

  /**
   * @param player The player the HUD is for.
   * @param hud HUD JSON; applied only for the local player.
   */
  setPlayerHud(player: number, hud: string): void {
    if (player !== this.localPlayer) return;
    this.ownsHud = false;
    this.view?.setHud(hud);
    this.ownsHud = true;
  }

  /** A page has no store: warn once. */
  savePlayerData(): void {
    this.warn('gameable: save-player-data needs a room store; there is no store on the page');
  }

  /** A page has no store: warn once. */
  saveGameData(): void {
    this.warn('gameable: save-game-data needs a room store; there is no store on the page');
  }

  /** A page has no store: warn once. */
  exchange(): void {
    this.warn('gameable: exchange needs a room store; there is no store on the page');
  }
}
