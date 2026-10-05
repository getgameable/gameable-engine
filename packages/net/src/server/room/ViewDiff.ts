/**
 * `ViewDiff` — the entity half of a step's replication: what a player knows
 * against what the world record holds now.
 */
import type { Command } from '@gameable/sdk';
import type { EntityRecord, WorldRecord } from '@gameable/wasm-host/server';

import {
  characterStateCommand,
  pushIntroduction,
  pushVisualCommands,
  setAnimCommand,
  spawnCharacterCommand,
} from './entityCommands.js';
import type { KnownEntity } from './KnownEntities.js';
import type { PlayerView } from './PlayerView.js';
import type { Relevance } from './Relevance.js';

/** How deep a parent chain is followed before it is taken for a cycle. */
const MAX_DEPTH = 32;

/**
 * Compares one player's known entities with the live records and queues the
 * commands that close the gap, in order: despawns (gone, respawned, out of
 * range), then each newer change tick of what they still know, then
 * introductions of what they may now see, every parent before its children.
 * The caller aims {@link Relevance} at the player first.
 *
 * @example
 * ```ts
 * import { Relevance, ViewDiff } from 'gameable/net/server';
 *
 * const relevance = new Relevance(adapter.world, undefined);
 * const diff = new ViewDiff(adapter.world, relevance);
 * relevance.aim(view);
 * diff.step(view);
 * ```
 */
export class ViewDiff {
  private current: PlayerView | null = null;
  private readonly introduceEach = (record: EntityRecord): void => {
    const view = this.current;
    if (view !== null && view.known.get(record.entity) === undefined) this.introduce(view, record, 0);
  };

  /**
   * @param world The world record.
   * @param relevance Who may see what; aimed by the caller.
   */
  constructor(
    private readonly world: WorldRecord,
    private readonly relevance: Relevance,
  ) {}

  /**
   * Queue everything that changed for this player since their last step.
   *
   * @param view The player's view.
   */
  step(view: PlayerView): void {
    this.forgetStale(view);
    this.update(view);
    this.current = view;
    this.world.entities.forEach(this.introduceEach);
    this.current = null;
  }

  /**
   * Mark everything the player may see as known, without queueing commands,
   * for a welcome snapshot.
   *
   * @param view The player's view, just reset.
   * @returns The records, every parent before its children.
   */
  knowAll(view: PlayerView): EntityRecord[] {
    const order: EntityRecord[] = [];
    this.world.entities.forEach((record) => {
      this.visit(view, record, 0, order);
    });
    return order;
  }

  /** @param view The player's view. */
  private forgetStale(view: PlayerView): void {
    const list = view.known.list;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const known = list[i];
      const record = this.world.get(known.entity);
      if (record === known.record && this.relevance.relevant(record)) continue;
      view.pending.push({ tag: 'despawn', val: known.entity });
      view.known.remove(known);
    }
  }

  /** @param view The player's view. */
  private update(view: PlayerView): void {
    const since = view.lastSentTick;
    const list = view.known.list;
    for (let i = 0; i < list.length; i += 1) {
      const known = list[i];
      const record = known.record;
      if (record.serial <= since) continue;
      if (record.stateSerial > since) this.updateState(view, known);
      if (record.animSerial > since) push(view.pending, setAnimCommand(record));
      if (record.characterSerial > since) {
        const bundle = record.character?.bundle ?? 0;
        if (bundle !== 0 && bundle !== known.bundle) push(view.pending, spawnCharacterCommand(record));
        known.bundle = bundle;
        push(view.pending, characterStateCommand(record));
      }
      if (record.visual.serial > since) pushVisualCommands(record, since, view.pending);
    }
  }

  /**
   * Asset, parent and visibility: `set-asset`, `set-parent` (a new parent
   * introduced first), and a pending `VISIBLE` row (there is no command for it).
   *
   * @param view The player's view.
   * @param known What the player knows of the entity.
   */
  private updateState(view: PlayerView, known: KnownEntity): void {
    const record = known.record;
    const entity = record.entity;
    if (record.asset !== known.asset) {
      known.asset = record.asset;
      const asset = record.asset === undefined ? {} : { asset: record.asset };
      view.pending.push({ tag: 'set-asset', val: { entity, ...asset } });
    }
    if (record.parent !== known.parent) {
      const parent = this.parentToName(view, record, 0);
      if (parent !== known.parent) {
        known.parent = parent;
        const named = parent === undefined ? {} : { parent };
        view.pending.push({ tag: 'set-parent', val: { entity, ...named, keepWorldTransform: false } });
      }
    }
    if (record.visible && !known.visible) {
      known.visible = true;
      known.showPending = true;
    }
  }

  /**
   * @param view The player's view.
   * @param record A record the player does not know.
   * @param depth How far up a parent chain this call is.
   */
  private introduce(view: PlayerView, record: EntityRecord, depth: number): void {
    if (!this.relevance.relevant(record)) return;
    const parent = this.parentToName(view, record, depth);
    pushIntroduction(record, parent, view.pending);
    view.known.add(record).parent = parent;
  }

  /**
   * The parent a command may name: the record's own, introduced first when
   * the player does not know it yet; undefined at the root, or when the
   * parent is not live or not relevant.
   *
   * @param view The player's view.
   * @param record The child's record.
   * @param depth How far up a parent chain this call is.
   * @returns The parent id to name, or undefined.
   */
  private parentToName(view: PlayerView, record: EntityRecord, depth: number): number | undefined {
    const id = record.parent;
    if (id === undefined) return undefined;
    if (view.known.get(id) !== undefined) return id;
    const parent = this.world.get(id);
    if (parent === undefined || depth >= MAX_DEPTH) return undefined;
    this.introduce(view, parent, depth + 1);
    return view.known.get(id) === undefined ? undefined : id;
  }

  /**
   * The snapshot's twin of `introduce`: mark known, collect in order.
   *
   * @param view The player's view.
   * @param record A live record.
   * @param depth How far up a parent chain this call is.
   * @param order Where the records go, parents first.
   */
  private visit(view: PlayerView, record: EntityRecord, depth: number, order: EntityRecord[]): void {
    if (view.known.get(record.entity) !== undefined || !this.relevance.relevant(record)) return;
    const id = record.parent;
    const parent = id === undefined ? undefined : this.world.get(id);
    if (parent !== undefined && depth < MAX_DEPTH) this.visit(view, parent, depth + 1, order);
    order.push(record);
    const known = view.known.add(record);
    if (id !== undefined && view.known.get(id) === undefined) known.parent = undefined;
  }
}

/**
 * @param out A command list.
 * @param command A command, or null for none.
 */
function push(out: Command[], command: Command | null): void {
  if (command !== null) out.push(command);
}
