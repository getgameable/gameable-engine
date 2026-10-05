import type { JoltInstance, JoltModule } from './jolt.js';

/** Tuning for the object-layer slot table. */
export interface LayerOptions {
  /**
   * How many distinct Jolt object layers the world may hand out. Half of them
   * back static bodies and half back moving bodies, so the default of 64
   * allows 32 distinct `(layer, mask)` pairs on each side.
   */
  maxObjectLayers?: number;
}

/** Jolt's two broad-phase layers: everything non-moving, and everything moving. */
const BROAD_PHASE_LAYERS = 2;

/**
 * Maps the engine's `(layer, mask)` bit pairs onto Jolt object layers.
 *
 * Jolt decides whether two bodies may collide from a *symmetric* table indexed
 * by object layer, but the engine's contract is a per-body `layer` (what I am)
 * and `mask` (what I collide with). The bridge is to mint one Jolt object
 * layer — a *slot* — per distinct `(layer, mask, moving)` triple the game
 * actually uses, and to enable the slot pair `(s, t)` exactly when
 * `maskS & layerT` and `maskT & layerS` are both non-zero.
 *
 * Slots are split statically down the middle: `[0, half)` are static bodies
 * and map to broad-phase layer 0, `[half, max)` are moving bodies and map to
 * broad-phase layer 1. That split has to be static because Jolt's
 * `ObjectVsBroadPhaseLayerFilterTable` snapshots its table in the constructor,
 * long before the game has added a body; the mutable
 * `ObjectLayerPairFilterTable` handed to the simulation is read live, which is
 * what makes lazy slot registration safe.
 */
export class LayerTable {
  /** Jolt module, for constructing the filter objects. */
  readonly #jolt: JoltModule;

  /** Total slot count; slots `[0, half)` are static, `[half, max)` moving. */
  readonly #max: number;

  /** First moving slot index. */
  readonly #half: number;

  /** The live, mutable pair filter the simulation consults every step. */
  readonly #pairFilter: JoltInstance<'ObjectLayerPairFilterTable'>;

  /** Frozen pair filter used only to build the broad-phase table. */
  readonly #broadPhasePairFilter: JoltInstance<'ObjectLayerPairFilterTable'>;

  /** Object layer to broad-phase layer mapping. */
  readonly #broadPhase: JoltInstance<'BroadPhaseLayerInterfaceTable'>;

  /** Derived object-vs-broad-phase filter. */
  readonly #objectVsBroadPhase: JoltInstance<'ObjectVsBroadPhaseLayerFilterTable'>;

  /**
   * `layer` to `mask` to slot, for the static side.
   *
   * Two levels of numeric map rather than one `"layer|mask|moving"` string
   * key: `addBody` runs whenever a game spawns something, and building a
   * string there allocates for every single body.
   */
  readonly #staticSlots = new Map<number, Map<number, number>>();

  /** `layer` to `mask` to slot, for the moving side. */
  readonly #movingSlots = new Map<number, Map<number, number>>();

  /** Per-slot `layer` bits, indexed by slot. */
  readonly #slotLayer: Uint32Array;

  /** Per-slot `mask` bits, indexed by slot. */
  readonly #slotMask: Uint32Array;

  /** Slots handed out so far, in registration order. */
  readonly #used: number[] = [];

  /** OR of the `layer` bits of every static slot minted so far. */
  #staticBits = 0;

  /** OR of the `layer` bits of every moving slot minted so far. */
  #movingBits = 0;

  /** Next free static slot. */
  #nextStatic = 0;

  /** Next free moving slot. */
  #nextMoving: number;

  /**
   * Build the layer table and its Jolt filter objects.
   *
   * @param jolt The initialised Jolt module.
   * @param options Slot-count tuning.
   */
  constructor(jolt: JoltModule, options: LayerOptions = {}) {
    const max = options.maxObjectLayers ?? 64;
    if (max < 2 || max % 2 !== 0) {
      throw new Error(`maxObjectLayers must be an even number >= 2, got ${String(max)}`);
    }
    this.#jolt = jolt;
    this.#max = max;
    this.#half = max / 2;
    this.#nextMoving = this.#half;
    this.#slotLayer = new Uint32Array(max);
    this.#slotMask = new Uint32Array(max);

    this.#pairFilter = new jolt.ObjectLayerPairFilterTable(max);

    // Broad-phase granularity is only "does a moving thing take part", so the
    // frozen table can be filled in completely up front.
    this.#broadPhasePairFilter = new jolt.ObjectLayerPairFilterTable(max);
    for (let i = 0; i < max; i += 1) {
      for (let j = i; j < max; j += 1) {
        if (i >= this.#half || j >= this.#half) this.#broadPhasePairFilter.EnableCollision(i, j);
      }
    }

    this.#broadPhase = new jolt.BroadPhaseLayerInterfaceTable(max, BROAD_PHASE_LAYERS);
    for (let i = 0; i < max; i += 1) {
      const bp = new jolt.BroadPhaseLayer(i < this.#half ? 0 : 1);
      this.#broadPhase.MapObjectToBroadPhaseLayer(i, bp);
      jolt.destroy(bp);
    }

    this.#objectVsBroadPhase = new jolt.ObjectVsBroadPhaseLayerFilterTable(
      this.#broadPhase,
      BROAD_PHASE_LAYERS,
      this.#broadPhasePairFilter,
      max,
    );
  }

  /**
   * The mutable pair filter to hand to `JoltSettings.mObjectLayerPairFilter`.
   *
   * @returns The live pair filter.
   */
  get pairFilter(): JoltInstance<'ObjectLayerPairFilter'> {
    return this.#pairFilter;
  }

  /**
   * The broad-phase interface to hand to `JoltSettings.mBroadPhaseLayerInterface`.
   *
   * @returns The broad-phase layer interface.
   */
  get broadPhase(): JoltInstance<'BroadPhaseLayerInterface'> {
    return this.#broadPhase;
  }

  /**
   * The filter to hand to `JoltSettings.mObjectVsBroadPhaseLayerFilter`.
   *
   * @returns The object-vs-broad-phase filter.
   */
  get objectVsBroadPhase(): JoltInstance<'ObjectVsBroadPhaseLayerFilter'> {
    return this.#objectVsBroadPhase;
  }

  /**
   * The `layer` bits a slot was registered with.
   *
   * @param slot Jolt object layer index.
   * @returns The engine-side `layer` bitset, or 0 for an unused slot.
   */
  layerBitsOf(slot: number): number {
    return this.#slotLayer[slot] ?? 0;
  }

  /**
   * How many slots have been minted. A cache keyed on this is valid until the
   * next new `(layer, mask, moving)` triple appears.
   *
   * @returns The slot count.
   */
  get revision(): number {
    return this.#used.length;
  }

  /**
   * Slots this table can hand out in total.
   *
   * @returns The ceiling, from `maxObjectLayers`.
   */
  get maxObjectLayers(): number {
    return this.#max;
  }

  /**
   * OR of the `layer` bits of every static slot.
   *
   * A query mask that shares no bit with this cannot hit a static body, so the
   * whole static broad-phase tree can be skipped.
   *
   * @returns The accumulated static `layer` bitset.
   */
  get staticLayerBits(): number {
    return this.#staticBits;
  }

  /**
   * OR of the `layer` bits of every moving slot. See
   * {@link LayerTable.staticLayerBits}.
   *
   * @returns The accumulated moving `layer` bitset.
   */
  get movingLayerBits(): number {
    return this.#movingBits;
  }

  /**
   * Fill a per-slot accept table for one query mask.
   *
   * Jolt asks `ObjectLayerFilter.ShouldCollide(slot)` once per broad-phase
   * candidate, from inside wasm. Answering from a `Uint8Array` the query
   * prepared beforehand turns that into one array read.
   *
   * @param mask Bitset of body `layer`s the query may hit.
   * @param out Destination, at least `maxObjectLayers` long.
   */
  fillAccept(mask: number, out: Uint8Array): void {
    out.fill(0);
    for (const slot of this.#used) {
      out[slot] = ((this.#slotLayer[slot] ?? 0) & mask) !== 0 ? 1 : 0;
    }
  }

  /**
   * Slot index for a `(layer, mask, moving)` triple, minting one if needed.
   *
   * Registration allocates — a map key and, once per new triple, a handful of
   * `EnableCollision` calls. It happens on `addBody`, never during a step.
   *
   * @param layer What the body is.
   * @param mask What the body collides with.
   * @param moving False for static bodies.
   * @returns The Jolt object layer to create the body in.
   * @throws {Error} When the slot budget for that side of the split is exhausted.
   */
  slotFor(layer: number, mask: number, moving: boolean): number {
    const l = layer >>> 0;
    const m = mask >>> 0;
    const byLayer = moving ? this.#movingSlots : this.#staticSlots;
    const byMask = byLayer.get(l);
    const existing = byMask?.get(m);
    if (existing !== undefined) return existing;

    let slot: number;
    if (moving) {
      if (this.#nextMoving >= this.#max) {
        throw new Error(
          `out of moving object layers (${String(this.#half)}); raise layers.maxObjectLayers`,
        );
      }
      slot = this.#nextMoving;
      this.#nextMoving += 1;
    } else {
      if (this.#nextStatic >= this.#half) {
        throw new Error(
          `out of static object layers (${String(this.#half)}); raise layers.maxObjectLayers`,
        );
      }
      slot = this.#nextStatic;
      this.#nextStatic += 1;
    }

    this.#slotLayer[slot] = l;
    this.#slotMask[slot] = m;
    if (byMask === undefined) byLayer.set(l, new Map<number, number>([[m, slot]]));
    else byMask.set(m, slot);
    if (moving) this.#movingBits |= l;
    else this.#staticBits |= l;

    for (const other of this.#used) {
      const otherMoving = other >= this.#half;
      if (!moving && !otherMoving) continue; // static never collides with static
      const otherLayer = this.#slotLayer[other] ?? 0;
      const otherMask = this.#slotMask[other] ?? 0;
      if ((m & otherLayer) !== 0 && (otherMask & l) !== 0) {
        this.#pairFilter.EnableCollision(slot, other);
      }
    }
    if (moving && (m & l) !== 0) this.#pairFilter.EnableCollision(slot, slot);
    this.#used.push(slot);

    return slot;
  }

  /**
   * Free the Jolt objects this table still owns.
   *
   * `JoltInterface` **takes ownership** of the three filters it is handed
   * through `JoltSettings` — the pair filter, the broad-phase interface and
   * the object-vs-broad-phase filter — and deletes them in its own destructor.
   * Destroying them here as well is a double free that corrupts the wasm heap,
   * so the only thing left to clean up is the scratch pair filter that never
   * reached `JoltSettings`.
   *
   * Call this *after* the `JoltInterface` has been destroyed.
   */
  dispose(): void {
    this.#jolt.destroy(this.#broadPhasePairFilter);
    this.#staticSlots.clear();
    this.#movingSlots.clear();
    this.#used.length = 0;
    this.#staticBits = 0;
    this.#movingBits = 0;
  }
}
