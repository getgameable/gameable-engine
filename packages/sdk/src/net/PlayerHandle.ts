/**
 * One player of a room, as `ctx.players` hands it out.
 *
 * Every handle is made in `init`, one per slot (`0..net.maxPlayers`), with its
 * input, camera and HUD facades already built, so a join, a leave and a tick
 * allocate nothing here. A handle is reused when a seat is taken again.
 */
import { createCameraFacade, makeCameraState, resetCameraState } from '../camera';
import { createHudFacade } from '../hud';
import { createInputFacade } from '../input';
import { clearLanes, makeLanes } from '../inputLanes';
import { requireRuntime, type HudState, type LookState } from '../state';
import type { NetCommandBuffer } from './NetCommandBuffer';

/**
 * @param value A parsed `player-joined` data.
 * @returns True for the room's `{ doc, savedAt, now }` envelope.
 */
function isEnvelope(value: unknown): value is { doc: unknown; savedAt?: unknown; now?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'doc' in value &&
    'savedAt' in value
  );
}

/**
 * One player: who they are, the entity `definition.player` spawned for them,
 * and facades that read their input and write their own camera and HUD.
 *
 * @example
 * ```ts
 * for (const [id, p] of ctx.players) {
 *   if (p.input.pressed('Space')) jump(p.entity);
 *   p.hud.set({ name: p.name, id });
 * }
 * ```
 */
export class PlayerHandle {
  /** The decoded input this handle's `input` reads. Internal. */
  readonly lanes = makeLanes();
  /** This player's keys, mouse and gamepads, read like `input`. */
  readonly input = createInputFacade(() => this.lanes, { x: 0, y: 0 });
  /** This player's camera: every write queues one `set-player-camera` per tick. */
  readonly camera = createCameraFacade({
    camera: () => this.cameraState,
    look: () => this.lookState,
    touch: () => {
      this.touchCamera();
    },
  });
  /** This player's HUD: a changed model queues a `set-player-hud`. */
  readonly hud = createHudFacade({
    state: () => this.hudState,
    emit: (json) => {
      requireRuntime().commands.setPlayerHud(this.id, json);
    },
  });

  /** The input sequence number this step consumed. */
  seq = 0;
  /** In this step's `frame-input.players`. Internal. */
  present = false;

  private readonly cameraState = makeCameraState();
  private readonly lookState: LookState;
  private readonly hudState: HudState = { last: null, pending: undefined };
  private cameraBuffer: NetCommandBuffer | null = null;
  private cameraGeneration = -1;
  private nameValue = '';
  private connectedValue = false;
  private entityValue = 0;
  private dataValue: unknown = null;
  private savedAtValue: number | null = null;
  private joinedAtValue: number | null = null;
  private hostValue = false;

  /**
   * @param id The player id this slot belongs to.
   * @param sensitivity Radians of look per pixel, as `player.sensitivity`.
   */
  constructor(
    readonly id: number,
    sensitivity: number,
  ) {
    this.lookState = { yaw: 0, pitch: 0, sensitivity };
  }

  /** @returns The display name the room gave at join, or `''`. */
  get name(): string {
    return this.nameValue;
  }

  /** @returns True between this player's `player-joined` and `player-left`. */
  get connected(): boolean {
    return this.connectedValue;
  }

  /**
   * @returns The entity this player controls: the one `definition.player`
   *   spawned at join, or the last one `possess`ed; 0 for none (also after
   *   that entity is despawned).
   */
  get entity(): number {
    return this.entityValue;
  }

  /**
   * Make this player control another entity: a respawn, a vehicle, a class
   * swap. On the authority it queues a `set-player-entity`, so the room
   * follows the player there (relevancy) and their client learns which
   * entity is theirs. Despawning the entity later leaves the player with
   * none until the next `possess`.
   *
   * @param entity The entity, or 0 to control none.
   *
   * @example
   * ```ts
   * const body = ctx.spawn(Avatar, spawnPoint);
   * ctx.players.get(id)?.possess(body);
   * ```
   */
  possess(entity: number): void {
    this.entityValue = entity;
    requireRuntime().commands.setPlayerEntity(this.id, entity);
  }

  /**
   * The possessed entity was despawned: the player controls none. The host
   * clears its own mapping on the despawn, so nothing is sent.
   *
   * @param entity A despawned entity.
   */
  forgetEntity(entity: number): void {
    if (entity !== 0 && this.entityValue === entity) this.entityValue = 0;
  }

  /**
   * @returns True for the host (`ctx.players.host`): the first joiner, until
   *   they leave; then the lowest seat still joined.
   */
  get isHost(): boolean {
    return this.hostValue;
  }

  /**
   * Whether this seat is the host; set when `ctx.players` is rebuilt. Game
   * code must not call it: it would only fake `isHost`, never move the host.
   *
   * @internal
   * @param host True for the host's seat.
   */
  markHost(host: boolean): void {
    this.hostValue = host;
  }

  /**
   * @returns The player's document: the one the room loaded at join, then
   *   whatever `ctx.data.save` or a finished exchange made it; `null` for none.
   */
  get data(): unknown {
    return this.dataValue;
  }

  /**
   * @returns When the store last wrote the document handed over at join, in
   *   ms since the epoch by the server's clock, or `null` when there was none.
   *   Offline time is `joinedAt - savedAt`.
   */
  get savedAt(): number | null {
    return this.savedAtValue;
  }

  /**
   * @returns The server's clock when the room loaded this player's document,
   *   in ms since the epoch, or `null` when the room has no store. The guest
   *   has no clock of its own (`now-ms` counts from engine start), so this is
   *   the one wall time it gets: add `ctx.elapsed` since the join to it.
   */
  get joinedAt(): number | null {
    return this.joinedAtValue;
  }

  /**
   * Replace the document `data` reads; `ctx.data` calls it. Sends nothing.
   *
   * @internal
   * @param data The new document.
   */
  setData(data: unknown): void {
    this.dataValue = data;
  }

  /**
   * The player took this seat. Parses the saved document: a join-tick allocation.
   *
   * @param name The display name.
   * @param data The room's `{ doc, savedAt, now }` as JSON, when it has a
   *   store (a bare document is taken as the doc).
   */
  join(name: string, data: string | null | undefined): void {
    if (!this.connectedValue) this.freshSeat();
    this.nameValue = name;
    this.connectedValue = true;
    this.dataValue = null;
    this.savedAtValue = null;
    this.joinedAtValue = null;
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (isEnvelope(parsed)) {
      this.dataValue = parsed.doc;
      this.savedAtValue = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
      this.joinedAtValue = typeof parsed.now === 'number' ? parsed.now : null;
    } else {
      this.dataValue = parsed;
    }
  }

  /** The player left; the caller has already despawned {@link PlayerHandle.entity}. */
  leave(): void {
    this.connectedValue = false;
    this.entityValue = 0;
    this.nameValue = '';
    this.dataValue = null;
    this.savedAtValue = null;
    this.joinedAtValue = null;
    clearLanes(this.lanes);
  }

  /**
   * Overwrite who holds this seat from a snapshot. The caller rebuilds the map.
   *
   * @param connected Joined and not left.
   * @param name The display name.
   * @param entity The player's entity in the restored world, or 0.
   * @param data The saved document, already parsed.
   */
  restoreSeat(connected: boolean, name: string, entity: number, data: unknown): void {
    this.connectedValue = connected;
    this.nameValue = name;
    this.entityValue = entity;
    this.dataValue = data;
    this.hudState.last = null;
    this.cameraBuffer = null;
  }

  /**
   * Integrate this step's mouse movement into the look angles, as the
   * built-in accumulator does for the local player. Allocates nothing.
   */
  integrateLook(): void {
    const mouse = this.lanes.mouse;
    if (!mouse.locked) return;
    const look = this.lookState;
    look.yaw -= mouse.dx * look.sensitivity;
    look.pitch -= mouse.dy * look.sensitivity;
    const limit = Math.PI / 2 - 0.001;
    if (look.pitch > limit) look.pitch = limit;
    else if (look.pitch < -limit) look.pitch = -limit;
  }

  /**
   * A new occupant inherits nothing: no HUD seen, default camera, level look,
   * and no input unless theirs already arrived this step.
   */
  private freshSeat(): void {
    this.hudState.last = null;
    this.cameraBuffer = null;
    resetCameraState(this.cameraState);
    this.lookState.yaw = 0;
    this.lookState.pitch = 0;
    if (!this.present) clearLanes(this.lanes);
  }

  /**
   * The authority spawned this player's entity at join: possess it (which
   * tells the host). Nothing is sent for 0 (a game with no player prefab).
   *
   * @param entity The entity spawned for this player, or 0.
   */
  setEntity(entity: number): void {
    if (entity === 0) this.entityValue = 0;
    else this.possess(entity);
  }

  /** Queue this player's camera once per command buffer per tick. */
  private touchCamera(): void {
    const buffer = requireRuntime().commands;
    if (buffer === this.cameraBuffer && buffer.generation === this.cameraGeneration) return;
    buffer.setPlayerCamera(this.id, this.cameraState);
    this.cameraBuffer = buffer;
    this.cameraGeneration = buffer.generation;
  }
}
