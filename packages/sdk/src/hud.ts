/**
 * The HUD facade.
 *
 * `frame-output.hud` is `option<string>`: JSON when the model changed, absent
 * when it did not. Serialising every frame would be the single most expensive
 * thing a simple game does across the boundary, so `hud.set` compares against
 * the previous model and only calls `JSON.stringify` on a real change.
 *
 * The comparison allocates nothing — no `Object.keys` arrays — and it walks
 * nested objects, so the shape both templates use, built inline every frame:
 *
 * ```ts
 * hud.set({ text: { ammo: '30' }, bars: { health: { value: 80, max: 100 } } });
 * ```
 *
 * is correctly seen as unchanged and costs one walk of a handful of keys
 * instead of a `JSON.stringify`.
 */
import { requireRuntime, type HudState } from './state';

/**
 * How many levels of nested plain objects `set` compares and copies.
 *
 * Four covers every HUD the templates and examples build, with a cap so a
 * model that accidentally holds a deep or cyclic graph cannot spin.
 */
const MAX_DEPTH = 4;

/** The model `clear()` sets, hoisted so clearing allocates nothing. */
const EMPTY_MODEL: Record<string, unknown> = Object.freeze({});

/**
 * Is `next` equal to `prev`, to `depth` levels of plain objects?
 *
 * Values below `depth`, and anything that is not a plain object (arrays
 * included), are compared with `Object.is`.
 *
 * @param prev The previous value.
 * @param next The new value.
 * @param depth How many more levels to descend.
 * @returns True when the two are equal.
 */
function deepEqual(prev: unknown, next: unknown, depth: number): boolean {
  if (Object.is(prev, next)) return true;
  if (depth === 0) return false;
  if (typeof prev !== 'object' || prev === null) return false;
  if (typeof next !== 'object' || next === null) return false;
  if (Array.isArray(prev) || Array.isArray(next)) return false;

  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  let count = 0;
  for (const key in b) {
    if (!Object.hasOwn(b, key)) continue;
    count += 1;
    if (!Object.hasOwn(a, key)) return false;
    if (!deepEqual(a[key], b[key], depth - 1)) return false;
  }
  // Counting instead of materialising two key arrays: a removed key shows up
  // as a length mismatch without allocating.
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue;
    count -= 1;
  }
  return count === 0;
}

/**
 * Snapshot a value, copying nested plain objects to the same depth `deepEqual`
 * compares.
 *
 * The copy is what the next frame compares against, so it must not alias
 * anything the game will mutate in place. It only runs on a real change.
 *
 * @param value The value the game set.
 * @param depth How many more levels to copy.
 * @returns A private copy, or the value itself when there is nothing to copy.
 */
function snapshot(value: unknown, depth: number): unknown {
  if (depth === 0) return value;
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value;
  const from = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key in from) {
    if (Object.hasOwn(from, key)) copy[key] = snapshot(from[key], depth - 1);
  }
  return copy;
}

/**
 * What a HUD facade writes: its change-detection state, and where a changed
 * model's JSON goes.
 *
 * The singleton `hud` sets the frame's `hud`; each player handle's `hud`
 * queues a `set-player-hud` for that player.
 */
export interface HudTarget {
  /** @returns The change-detection state this facade owns. */
  state(): HudState;
  /**
   * Hand on a changed model.
   *
   * @param json The model as JSON.
   */
  emit(json: string): void;
}

/**
 * Build a HUD facade over one target. Called once per target, never per tick.
 *
 * @param target What the facade writes.
 * @returns The facade.
 */
export function createHudFacade(target: HudTarget) {
  return {
    /**
     * Set the HUD model for this frame.
     *
     * Nested plain objects are compared by value four levels down, so a model
     * rebuilt inline every frame is recognised as unchanged. Arrays and class
     * instances are compared by identity: keep those out of the model, or build
     * them once and mutate nothing.
     *
     * @param model A JSON-serialisable object.
     * @returns True when the model changed and JSON will cross this frame.
     */
    set(model: Record<string, unknown>): boolean {
      const state = target.state();
      const last = state.last;
      if (last !== null && deepEqual(last, model, MAX_DEPTH)) return false;
      state.last = snapshot(model, MAX_DEPTH) as Record<string, unknown>;
      target.emit(JSON.stringify(model));
      return true;
    },

    /**
     * Forget what the host has seen, so the next `set` emits even if the model
     * did not change. Use it after the host reloaded its overlay.
     *
     * On its own it sends nothing: the next `set` does. To send an empty model
     * now, call `clear()`.
     *
     * @returns Nothing.
     */
    invalidate(): void {
      target.state().last = null;
    },

    /**
     * Drop the HUD: emit an empty model this frame.
     *
     * Idempotent — calling it every frame emits `{}` once, exactly like `set`.
     *
     * @returns Nothing.
     */
    clear(): void {
      const state = target.state();
      const last = state.last;
      if (last !== null && deepEqual(last, EMPTY_MODEL, MAX_DEPTH)) return;
      state.last = {};
      target.emit('{}');
    },
  };
}

/**
 * @param json The changed model; the frame's `hud` this step.
 */
function emitFrameHud(json: string): void {
  requireRuntime().hud.pending = json;
}

/**
 * The HUD facade: writes the frame's HUD.
 *
 * @example
 * ```ts
 * import { hud } from 'gameable';
 *
 * hud.set({ health: 100, ammo: 30 }); // emitted once
 * hud.set({ health: 100, ammo: 30 }); // unchanged, nothing crosses
 * ```
 */
export const hud = createHudFacade({
  state: () => requireRuntime().hud,
  emit: emitFrameHud,
});
