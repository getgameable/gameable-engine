/**
 * Queued physics contacts in the WIT shape, without allocating per frame.
 */
import type { ContactRecord, PhysicsService } from '@gameable/physics-jolt';
import type { Contact } from '@gameable/sdk';

/** The contact list handed to a tick with no contacts. */
const EMPTY_CONTACTS: readonly Contact[] = [];

/** Drains a physics world's contacts into pooled WIT `contact` records. */
export class ContactReader {
  /** Reused contact pool; the physics module refills it in place. */
  private readonly pool: ContactRecord[] = [];
  /** Reused WIT contacts, so a frame with contacts still allocates nothing. */
  private readonly contacts: Contact[] = [];
  /** Memoised prefixes of `contacts`, indexed by count. */
  private readonly views: (readonly Contact[])[] = [EMPTY_CONTACTS];

  /**
   * Move queued contacts into the WIT shape, resolving entities.
   *
   * @param physics The world to drain, or null for none.
   * @param entityOfBody The body-to-entity map.
   * @returns The contacts for this tick.
   */
  read(physics: PhysicsService | null, entityOfBody: (body: number) => number): readonly Contact[] {
    if (physics === null) return EMPTY_CONTACTS;
    const contacts = this.contacts;
    const count = physics.drainContacts(this.pool);
    for (let i = 0; i < count; i += 1) {
      const source = this.pool[i];
      let target = contacts[i] as Contact | undefined;
      if (target === undefined) {
        target = {
          a: 0,
          b: 0,
          entityA: 0,
          entityB: 0,
          phase: 'begin',
          point: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 0 },
          impulse: 0,
        };
        contacts.push(target);
      }
      target.a = source.a;
      target.b = source.b;
      target.entityA = entityOfBody(source.a);
      target.entityB = entityOfBody(source.b);
      target.phase = source.phase;
      target.point.x = source.px;
      target.point.y = source.py;
      target.point.z = source.pz;
      target.normal.x = source.nx;
      target.normal.y = source.ny;
      target.normal.z = source.nz;
      target.impulse = source.impulse;
    }
    // The pooled `Contact` objects are never replaced, only rewritten, so a
    // view built for a given count stays correct for every later frame with
    // that count. Memoising them is what makes a steady stream of contacts
    // allocation-free.
    let view = this.views[count] as readonly Contact[] | undefined;
    if (view === undefined) {
      view = contacts.slice(0, count);
      this.views[count] = view;
    }
    return view;
  }
}
