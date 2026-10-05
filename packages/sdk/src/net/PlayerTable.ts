/**
 * Every player slot of one guest, and the `ctx.players` map over them.
 *
 * A room hands the guest every player's input each step, and `player-joined`
 * / `player-left` events. Each player id owns one {@link PlayerHandle}, made
 * in `init` (ids `0..net.maxPlayers`, default 16). `decode` copies the
 * incoming input into its slot exactly as the runtime copies
 * `frame-input.input`: the incoming lists are plain `Array`s in wasm mode, so
 * nothing is aliased, and nothing is allocated in the steady state.
 *
 * `ctx.players` holds every player who is connected (joined and not left) or
 * whose input is in this step, its `list` and its `host`. It is rebuilt only
 * when that set changes, never per tick.
 */
import { clearLanes, copyInput } from '../inputLanes';
import { PlayerHandle } from './PlayerHandle';
import { PlayerMap } from './PlayerMap';
import type { HostApi, GameEvent, PlayerInput } from '../types';

/** What spawns and despawns the entity a joining player gets. */
export interface PlayerSpawning {
  /**
   * @param player The joining player.
   * @returns The entity spawned for them, or 0.
   */
  spawn(player: number): number;
  /** @param entity The leaving player's entity. */
  despawn(entity: number): void;
}

/** One seat as a snapshot carries it. */
export interface PlayerRecord {
  id: number;
  connected: boolean;
  name: string;
  entity: number;
  data: unknown;
}

/** The slots, the map, and the bookkeeping that keeps the map stable. */
export class PlayerTable {
  /** Id to handle; `ctx.players`. */
  readonly map = new PlayerMap();
  private slots: PlayerHandle[] = [];
  // Unsigned: a player id (or the room's AUTHORITY_SENDER, 0xffffffff) must not read back as -1.
  private ids = new Uint32Array(0);
  // Last step's ids, so a seat that leaves the list (held, or gone) can be cleared.
  private prev = new Uint32Array(0);
  private count = 0;
  private dirty = false;
  private warnedCap = false;

  /** @param host Where the one over-the-cap warning goes. */
  constructor(private readonly host: HostApi) {}

  /**
   * Make the handles for ids `0..maxPlayers` and forget every player. Init only.
   *
   * @param maxPlayers The highest player id the room may use.
   * @param sensitivity Look sensitivity each handle's camera starts with.
   */
  configure(maxPlayers: number, sensitivity: number): void {
    this.slots = [];
    for (let id = 0; id <= maxPlayers; id += 1) this.slots.push(new PlayerHandle(id, sensitivity));
    this.ids = new Uint32Array(maxPlayers + 1);
    this.prev = new Uint32Array(maxPlayers + 1);
    this.count = 0;
    this.dirty = false;
    this.map.reset();
    this.warnedCap = false;
  }

  /**
   * @param player A player id.
   * @returns Its handle, or undefined past `net.maxPlayers`.
   */
  handle(player: number): PlayerHandle | undefined {
    const slot: PlayerHandle | undefined = this.slots[player];
    return slot;
  }

  /**
   * Copy this step's players into their slots. A seat that was listed last
   * step and is not now (the room holds it, or it left) reads as neutral
   * input: no key down, no edge, no mouse movement, until it is listed again.
   *
   * @param players `frame-input.players`.
   */
  decode(players: readonly PlayerInput[]): void {
    const slots = this.slots;
    const before = this.count;
    for (let i = 0; i < before; i += 1) {
      this.prev[i] = this.ids[i];
      slots[this.ids[i]].present = false;
    }
    let n = 0;
    for (let i = 0; i < players.length; i += 1) {
      const from = players[i];
      const slot = this.handle(from.player);
      if (slot === undefined) {
        this.warnCap(from.player);
        continue;
      }
      // A duplicated id cannot outgrow the table: every slot is listed once at most.
      if (n >= this.ids.length) continue;
      copyInput(slot.lanes, from.input);
      slot.seq = from.seq;
      slot.present = true;
      if (n >= this.count || this.ids[n] !== from.player) this.dirty = true;
      this.ids[n] = from.player;
      n += 1;
    }
    if (n !== this.count) this.dirty = true;
    this.count = n;
    for (let i = 0; i < before; i += 1) {
      const slot = slots[this.prev[i]];
      if (!slot.present) clearLanes(slot.lanes);
    }
  }

  /**
   * Apply this step's `player-joined` and `player-left` events.
   *
   * @param events `frame-input.events`.
   * @param spawning Spawns a joining player's entity; `null` where entities are not spawned.
   */
  applyEvents(events: readonly GameEvent[], spawning: PlayerSpawning | null): void {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.tag === 'player-joined') {
        const slot = this.handle(event.val.player);
        if (slot === undefined) {
          this.warnCap(event.val.player);
          continue;
        }
        slot.join(event.val.name, event.val.data);
        if (spawning !== null && slot.entity === 0) slot.setEntity(spawning.spawn(slot.id));
        this.dirty = true;
      } else if (event.tag === 'player-left') {
        const slot = this.handle(event.val.player);
        if (slot === undefined || !slot.connected) continue;
        if (spawning !== null && slot.entity !== 0) spawning.despawn(slot.entity);
        slot.leave();
        this.dirty = true;
      }
    }
  }

  /**
   * An entity was despawned: any player controlling it now controls none.
   * Walks the slots (at most `maxPlayers + 1`); allocates nothing.
   *
   * @param entity The despawned entity.
   */
  forgetEntity(entity: number): void {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i += 1) slots[i].forgetEntity(entity);
  }

  /** Integrate each present player's mouse into their own look angles. */
  integrateLooks(): void {
    for (let i = 0; i < this.count; i += 1) this.slots[this.ids[i]].integrateLook();
  }

  /**
   * Every seat that is taken or still has an entity, for `snapshot`.
   *
   * @returns One record per such seat; a fresh array, as a snapshot is.
   */
  save(): PlayerRecord[] {
    const out: PlayerRecord[] = [];
    for (const slot of this.slots) {
      if (!slot.connected && slot.entity === 0) continue;
      out.push({
        id: slot.id,
        connected: slot.connected,
        name: slot.name,
        entity: slot.entity,
        data: slot.data,
      });
    }
    return out;
  }

  /** @returns The host's seat (`ctx.players.host`), for `snapshot`. */
  get hostSeat(): number | undefined {
    return this.map.host;
  }

  /**
   * Put every seat back as `save` recorded it; seats it does not list are empty.
   *
   * @param records What `save` returned, or undefined for a snapshot that predates it.
   * @param host The host `hostSeat` recorded; undefined picks the lowest connected seat.
   */
  load(records: readonly PlayerRecord[] | undefined, host?: number): void {
    for (const slot of this.slots) slot.restoreSeat(false, '', 0, null);
    for (const r of records ?? []) {
      this.handle(r.id)?.restoreSeat(r.connected, r.name, r.entity, r.data);
    }
    this.map.restoreHost(host);
    this.dirty = true;
    this.refresh();
  }

  /** Rebuild `map` when a join, a leave or the input ids changed it. */
  refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.map.rebuild(this.slots, this.count > 0);
  }

  /** @param player The id past the cap. */
  private warnCap(player: number): void {
    if (this.warnedCap) return;
    this.warnedCap = true;
    this.host.log(
      'warn',
      `player ${String(player)} is past net.maxPlayers (${String(this.slots.length - 1)}); ` +
        'its input is ignored. Raise net.maxPlayers in the game options.',
    );
  }
}
