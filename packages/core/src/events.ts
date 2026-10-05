/**
 * A tiny typed pub/sub.
 *
 * `emit` is on the hot path — modules publish per-frame events — so it must not
 * allocate. With no listeners it is a `Map.get` and a length check; with
 * listeners it walks the live array by index. `off` during an `emit` leaves a
 * `null` tombstone that is compacted once the outermost emit returns, so
 * unsubscribing from inside a handler is safe and still allocation-free.
 */

/**
 * Shape of an event map: an interface mapping event name to payload type.
 *
 * Deliberately `object` rather than `Record<string, unknown>`: interfaces have
 * no implicit index signature, and the whole point of `EngineEventMap` is that
 * packages declaration-merge into it.
 */
export type EventMap = object;

/** A handler for one event. */
export type Listener<T> = (payload: T) => void;

/** Typed pub/sub over the event map `M`. */
export interface Events<M extends EventMap> {
  /**
   * Subscribe to an event.
   *
   * @param type Event name.
   * @param listener Handler.
   * @returns An unsubscribe function, so callers need not keep the reference.
   */
  on<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void;

  /**
   * Subscribe to the next occurrence only.
   *
   * @param type Event name.
   * @param listener Handler.
   * @returns An unsubscribe function.
   */
  once<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void;

  /**
   * Unsubscribe a handler.
   *
   * @param type Event name.
   * @param listener The exact function passed to `on`.
   */
  off<K extends keyof M>(type: K, listener: Listener<M[K]>): void;

  /**
   * Publish an event.
   *
   * @param type Event name.
   * @param payload Payload, matching the map.
   */
  emit<K extends keyof M>(type: K, payload: M[K]): void;

  /**
   * How many handlers are subscribed to an event.
   *
   * @param type Event name.
   * @returns The live listener count.
   */
  listenerCount(type: keyof M): number;

  /** Drop every handler. */
  clear(): void;
}

/**
 * Build a typed event bus.
 *
 * The type parameter is the event map. Packages extend the engine's map by
 * declaration-merging into `EngineEventMap`; standalone buses pass their own.
 *
 * @returns An empty bus.
 *
 * @example
 * ```ts
 * import { createEvents } from 'gameable/core';
 *
 * const events = createEvents<{ hit: { damage: number } }>();
 * const off = events.on('hit', (e) => console.log(e.damage));
 * events.emit('hit', { damage: 7 }); // logs 7
 * off();
 * ```
 */
export function createEvents<M extends EventMap>(): Events<M> {
  type Slot = Listener<never> | null;
  const byType = new Map<keyof M, Slot[]>();
  let emitDepth = 0;
  let tombstones = 0;

  /** Remove `null` tombstones once no emit is in progress. */
  function compact(): void {
    if (emitDepth > 0 || tombstones === 0) return;
    for (const [type, slots] of byType) {
      let write = 0;
      for (let read = 0; read < slots.length; read += 1) {
        const slot = slots[read];
        if (slot !== null) {
          slots[write] = slot;
          write += 1;
        }
      }
      slots.length = write;
      if (write === 0) byType.delete(type);
    }
    tombstones = 0;
  }

  const events: Events<M> = {
    on(type, listener) {
      let slots = byType.get(type);
      if (slots === undefined) {
        slots = [];
        byType.set(type, slots);
      }
      slots.push(listener);
      return () => {
        events.off(type, listener);
      };
    },

    once(type, listener) {
      /**
       * Forward once, then unsubscribe.
       *
       * @param payload The event payload.
       */
      const wrapper: Listener<M[typeof type]> = (payload) => {
        events.off(type, wrapper);
        listener(payload);
      };
      return events.on(type, wrapper);
    },

    off(type, listener) {
      const slots = byType.get(type);
      if (slots === undefined) return;
      const index = slots.indexOf(listener);
      if (index === -1) return;
      slots[index] = null;
      tombstones += 1;
      compact();
    },

    emit(type, payload) {
      const slots = byType.get(type);
      if (slots === undefined) return;
      const length = slots.length;
      if (length === 0) return;
      emitDepth += 1;
      for (let i = 0; i < length; i += 1) {
        const slot = slots[i];
        if (slot !== null) (slot as Listener<M[typeof type]>)(payload);
      }
      emitDepth -= 1;
      compact();
    },

    listenerCount(type) {
      const slots = byType.get(type);
      if (slots === undefined) return 0;
      let n = 0;
      for (const slot of slots) if (slot !== null) n += 1;
      return n;
    },

    clear() {
      byType.clear();
      tombstones = 0;
    },
  };

  return events;
}

/**
 * Events the engine itself publishes.
 *
 * Other packages add their own by declaration merging, exactly as they do for
 * `EngineServices`:
 *
 * ```ts
 * declare module 'gameable/core' {
 *   interface EngineEventMap {
 *     'physics:contact': { a: number; b: number };
 *   }
 * }
 * ```
 */
export interface EngineEventMap {
  /** The loop has started. */
  'engine:start': undefined;
  /** The loop has stopped. */
  'engine:stop': undefined;
  /** The drawing buffer changed size. */
  'engine:resize': { width: number; height: number };
  /**
   * A frame finished, after rendering.
   *
   * The payload object is reused every frame; read it in the handler and never
   * retain it.
   */
  'engine:frame': { frame: number; dtReal: number; alpha: number; substeps: number };
}
