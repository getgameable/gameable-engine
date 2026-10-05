/**
 * `Predictor` — client-side prediction of this page's own character body,
 * and reconciliation with the authority (Tasks 8.2 and 8.3).
 *
 * The client guest walks its own character body, the first `character`
 * `add-body` it sends, in the page's Jolt world (the level's static
 * colliders and that body, nothing else). Each fixed step the predictor
 * records the guest's `move-character` and, after the physics step, where
 * the body ended up, in a 64-step ring keyed by input `seq`; it writes that
 * position onto the authority's entity for this player (`net.localEntity`),
 * whose rows then no longer move it.
 *
 * Each rows frame's trailer says where the authority had the body after the
 * input `seq` it names. More than 2 cm from the ring's position at that seq
 * is a misprediction: the body is put where the authority says (position and
 * velocity) and every later step is replayed, the recorded move then
 * `world.step(fixedDt)`, so the body is back at "now" with the error gone.
 * That is one `corrections` on the overlay. A trailer that says `TELEPORT`,
 * names another entity, or is the first since the body appeared snaps the
 * same way without counting. A trailer for a seq the page has not sent yet
 * (the old seat's numbering, after a reconnect) is ignored.
 */
import type { EngineEventMap, Events } from '@gameable/core';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, Command, MoveCharacterCmd } from '@gameable/sdk';

import { PlayerRowFlag, RowFlag } from '../protocol/constants.js';
import type { PlayerRow } from '../protocol/types.js';
import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import type { LocalIds } from './LocalIds.js';
import type { NetService } from './NetService.js';
import { PREDICT_RING, PredictRing, RingLane } from './PredictRing.js';
import type { ReplicaWriter } from './ReplicaWriter.js';

/** Metres of disagreement with the authority that count as a misprediction. */
export const CORRECTION_METRES = 0.02;

/** The predicted body and the authority's view of it. */
export class Predictor {
  /** The predicted body's id, or 0 before the guest added one. */
  body = 0;
  /** True once a trailer has placed the body where the authority has it. */
  synced = false;
  /** The guest's own entity the body drives (its id, not the page's). */
  private guestEntity = 0;
  private trailerEntity = 0;
  private seq = 0;
  private pending = false;
  private readonly last = {
    entity: 0,
    seq: 0,
    flags: 0,
    position: [0, 0, 0] as [number, number, number],
    velocity: [0, 0, 0] as [number, number, number],
  };
  private readonly ring = new PredictRing();
  private readonly pose = new Float32Array(7);
  private readonly rotation: [number, number, number, number] = [0, 0, 0, 1];
  private readonly still: [number, number, number] = [0, 0, 0];
  private readonly move = { x: 0, y: 0, z: 0 };
  private readonly added = {} as AddBodyCmd;

  /**
   * @param adapter The page adapter: body commands go through it, as on a single-player page.
   * @param net The room: `localEntity` is drawn where the body is.
   * @param world The page's physics world.
   * @param dt The fixed step, seconds: every replayed step is this long.
   */
  constructor(
    private readonly adapter: ClientLoopAdapter,
    private readonly net: NetService,
    private readonly world: PhysicsService,
    private readonly dt: number,
  ) {}

  /**
   * Hear the trailers the replica decodes and the page's physics steps.
   *
   * @param events The page engine's events.
   * @param replica The client loop's replica writer.
   * @returns A function that stops listening.
   */
  listen(events: Pick<Events<EngineEventMap>, 'on'>, replica: ReplicaWriter): () => void {
    replica.onPlayer = (row) => {
      this.trailer(row);
    };
    const off = events.on('physics:stepped', () => {
      this.stepped();
    });
    return () => {
      off();
      replica.onPlayer = null;
    };
  }

  /** @returns The authority's entity this page draws at the predicted body, or 0. */
  get ownEntity(): number {
    return this.synced ? this.net.localEntity : 0;
  }

  /**
   * @param body A body id from a contact.
   * @returns The guest's entity for the predicted body, else 0.
   */
  entityOf(body: number): number {
    return body !== 0 && body === this.body ? this.guestEntity : 0;
  }

  /** A new welcome: the seat's inputs start again at 1, so the ring is void. */
  reset(): void {
    this.ring.clear();
    this.pending = false;
    this.synced = false;
  }

  /** @param seq This step's input seq, just sent. */
  open(seq: number): void {
    this.seq = seq;
    if (this.body !== 0) this.ring.open(seq);
  }

  /**
   * One of the client guest's physics commands. Only its own character body
   * is the page's: the first `character` `add-body`, its `move-character`
   * and its `remove-body`. Every other physics command is the authority's
   * business and is dropped, as on a page that does not predict.
   *
   * @param command A physics command from the client guest.
   * @param ids The guest's id shifter, for the body's page entity.
   */
  command(command: Command, ids: LocalIds): void {
    switch (command.tag) {
      case 'add-body':
        if (this.body !== 0 || command.val.kind !== 'character') return;
        this.adopt(command.val, ids);
        return;
      case 'move-character':
        if (command.val.body === this.body && this.body !== 0) this.walk(command.val);
        return;
      case 'remove-body':
        if (command.val !== this.body || this.body === 0) return;
        this.adapter.removeBody(this.body);
        this.body = 0;
        this.reset();
        return;
      default:
        return;
    }
  }

  /** @param row The newest rows frame's trailer; copied, the codec reuses it. */
  trailer(row: PlayerRow): void {
    const last = this.last;
    last.entity = row.entity;
    last.seq = row.seq;
    last.flags = row.flags;
    for (let i = 0; i < 3; i += 1) {
      last.position[i] = row.position[i];
      last.velocity[i] = row.velocity[i];
    }
    this.pending = true;
  }

  /**
   * Compare the newest trailer with the prediction at its seq; snap and
   * replay when they disagree. Call at the start of a step, after the rows
   * were drained and before this step's input.
   *
   * @returns True when the body was moved (a snap): re-read the body rows.
   */
  reconcile(): boolean {
    if (!this.pending || this.body === 0) return false;
    this.pending = false;
    const last = this.last;
    const ring = this.ring;
    if (last.seq > ring.newest) return false; // numbered before this welcome
    const snap =
      !this.synced ||
      last.entity !== this.trailerEntity ||
      (last.flags & PlayerRowFlag.TELEPORT) !== 0;
    if (!snap) {
      if (!ring.has(last.seq)) return false; // older than the ring: nothing to compare with
      if (this.error(ring.slot(last.seq)) <= CORRECTION_METRES) return false;
      this.net.stats.corrections += 1;
    }
    this.trailerEntity = last.entity;
    this.synced = true;
    this.world.readBodyPose(this.body, this.pose, 0);
    for (let i = 0; i < 4; i += 1) this.rotation[i] = this.pose[3 + i];
    this.world.setTransform(this.body, last.position, this.rotation, false);
    this.world.setVelocity(this.body, last.velocity, this.still);
    this.replay(Math.max(last.seq + 1, ring.newest - PREDICT_RING + 1), ring.newest);
    this.world.readBodyPose(this.body, this.pose, 0);
    this.publish();
    return true;
  }

  /** The physics step ran: record where it left the body, and draw the player there. */
  stepped(): void {
    if (this.body === 0 || !this.world.readBodyPose(this.body, this.pose, 0)) return;
    if (this.ring.has(this.seq)) this.keep(this.ring.slot(this.seq));
    this.publish();
  }

  /**
   * @param at A step's slot.
   * @returns Metres from the position the ring holds there to the trailer's.
   */
  private error(at: number): number {
    const l = this.ring.lanes;
    const p = this.last.position;
    const dx = l[at + RingLane.POSITION] - p[0];
    const dy = l[at + RingLane.POSITION + 1] - p[1];
    const dz = l[at + RingLane.POSITION + 2] - p[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** @param at A step's slot: the body's position, just read into `pose`, is kept there. */
  private keep(at: number): void {
    const l = this.ring.lanes;
    for (let i = 0; i < 3; i += 1) l[at + RingLane.POSITION + i] = this.pose[i];
  }

  /**
   * @param first The first seq to run again.
   * @param newest The last.
   */
  private replay(first: number, newest: number): void {
    const ring = this.ring;
    const move = this.move;
    const l = ring.lanes;
    for (let seq = first; seq <= newest; seq += 1) {
      if (!ring.has(seq)) break;
      const at = ring.slot(seq);
      move.x = l[at + RingLane.MOVE];
      move.y = l[at + RingLane.MOVE + 1];
      move.z = l[at + RingLane.MOVE + 2];
      const jump = l[at + RingLane.JUMP] !== 0;
      const crouch = l[at + RingLane.CROUCH] !== 0;
      this.adapter.moveCharacter(this.body, move, jump, crouch, l[at + RingLane.SLOPE]);
      this.world.step(this.dt);
      this.world.readBodyPose(this.body, this.pose, 0);
      this.keep(at);
    }
  }

  /** Draw the authority's entity for this player at the predicted body. */
  private publish(): void {
    const entity = this.ownEntity;
    if (entity === 0) return;
    this.adapter.setTransformFromHost(
      entity,
      RowFlag.POSITION,
      this.pose,
      this.rotation,
      this.pose,
    );
  }

  /**
   * @param args The guest's `add-body` for its own character.
   * @param ids Moves its entity into the page's local range.
   */
  private adopt(args: AddBodyCmd, ids: LocalIds): void {
    this.body = args.body;
    this.guestEntity = args.entity;
    Object.assign(this.added, args);
    this.added.entity = ids.entity(args.entity);
    this.adapter.addBody(this.added);
    this.reset();
    this.ring.open(this.seq); // this step's move is about to come
  }

  /** @param move The guest's `move-character` for the body, this step's. */
  private walk(move: MoveCharacterCmd): void {
    const v = move.desiredVelocity;
    const ring = this.ring;
    if (ring.has(this.seq)) {
      const at = ring.slot(this.seq);
      const l = ring.lanes;
      l[at + RingLane.MOVE] = v.x;
      l[at + RingLane.MOVE + 1] = v.y;
      l[at + RingLane.MOVE + 2] = v.z;
      l[at + RingLane.JUMP] = move.jump ? 1 : 0;
      l[at + RingLane.CROUCH] = move.crouch ? 1 : 0;
      l[at + RingLane.SLOPE] = move.maxSlopeDeg;
    }
    this.adapter.moveCharacter(this.body, v, move.jump, move.crouch, move.maxSlopeDeg);
  }
}
