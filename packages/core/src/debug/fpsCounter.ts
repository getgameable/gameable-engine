import type { EngineContext } from '../context.js';

/**
 * Count rendered frames in a supplied HUD element; update twice a second.
 * Resets on tab visibility changes and returns an idempotent cleanup callback.
 * The caller owns markup and styling; no overlay is created unless requested.
 *
 * @param engine Host event source.
 * @param value Element displaying only the numeric FPS value.
 * @returns Cleanup callback; call when disposing the owning module.
 * @example
 * ```ts
 * const dispose = createFpsCounter(engine, document.querySelector('#fps-value')!);
 * ```
 */
export function createFpsCounter(
  engine: Pick<EngineContext, 'events'>,
  value: HTMLElement,
): () => void {
  const document = value.ownerDocument;
  const window = document.defaultView;
  const nowMs = () => window?.performance.now() ?? performance.now();
  // Avoid formatting/allocating strings in the frame callback.
  const labels = Array.from({ length: 1000 }, (_, i) => String(i));
  let frames = 0;
  let start = nowMs();
  const reset = () => {
    frames = 0;
    start = nowMs();
    value.textContent = '—';
  };
  document.addEventListener('visibilitychange', reset);
  const off = engine.events.on('engine:frame', () => {
    if (document.hidden) return;
    frames++;
    const now = nowMs();
    const elapsed = now - start;
    if (elapsed < 500) return;
    value.textContent = labels[Math.min(999, Math.round((frames * 1000) / elapsed))];
    frames = 0;
    start = now;
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    off();
    document.removeEventListener('visibilitychange', reset);
    window?.removeEventListener('pagehide', dispose);
  };
  window?.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
