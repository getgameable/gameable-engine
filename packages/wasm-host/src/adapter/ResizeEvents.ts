/**
 * `engine:resize` as one pooled `resized` guest event per tick.
 */
import type { Engine } from '@gameable/core';
import type { GameEvent } from '@gameable/sdk';

/** One `resized` event. */
type Resized = Extract<GameEvent, { tag: 'resized' }>;

/**
 * The device pixel ratio the renderer is drawing at.
 *
 * @param engine The engine.
 * @returns The ratio, rounded to `f32` so both sandbox modes see one value.
 */
function devicePixelRatioOf(engine: Engine): number {
  const renderer = engine.renderer as unknown as { getPixelRatio?: () => number };
  if (typeof renderer.getPixelRatio === 'function') return renderer.getPixelRatio();
  return (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
}

/** Queues the engine's resizes for the guest, rewriting one pooled event. */
export class ResizeEvents {
  /** The one pooled `resized` event, built on the first resize. */
  private event: Resized | null = null;

  /**
   * Listen for resizes and queue them onto a guest event queue.
   *
   * @param engine The engine whose `engine:resize` is heard.
   * @param queue The queue the next tick reads.
   * @returns Unsubscribes the listener.
   */
  subscribe(engine: Engine, queue: GameEvent[]): () => void {
    return engine.events.on('engine:resize', (size) => {
      let event = this.event;
      if (event === null) {
        event = { tag: 'resized', val: { width: 0, height: 0, devicePixelRatio: 1 } };
        this.event = event;
      }
      event.val.width = size.width;
      event.val.height = size.height;
      event.val.devicePixelRatio = devicePixelRatioOf(engine);
      // One `resized` per tick: a drag-resize fires the observer far more
      // often than the simulation steps, and only the last size is true.
      for (let i = 0; i < queue.length; i += 1) {
        if (queue[i] === event) return;
      }
      queue.push(event);
    });
  }
}
