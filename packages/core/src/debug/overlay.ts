/**
 * The debug overlay: a small fixed panel in the corner, toggled with F3.
 *
 * Created only when `createEngine({ debug: true })`. It is deliberately plain
 * DOM — no canvas, no charts — because the thing it measures must not be
 * perturbed by the measuring. Per frame it does one `push` into a preallocated
 * ring buffer; it builds a string and writes `textContent` four times a second.
 */
import type { WebGPURenderer } from 'three/webgpu';

import type { FrameStats } from './frameStats.js';
import { createFrameStats, DEFAULT_SAMPLE_COUNT } from './frameStats.js';

/** How often the panel's text is rewritten, in milliseconds. */
export const DEFAULT_OVERLAY_INTERVAL_MS = 250;

/** `KeyboardEvent.code` that toggles the panel. */
export const DEFAULT_OVERLAY_HOTKEY = 'F3';

/** Options accepted by {@link createDebugOverlay}. */
export interface DebugOverlayOptions {
  /** Renderer whose `info.render` counters are shown. */
  readonly renderer: WebGPURenderer;
  /** Backend label, for example `webgpu` or `webgl`. */
  readonly backendName: string;
  /** Where to mount the panel. Defaults to `document.body`. */
  readonly container?: HTMLElement;
  /** `KeyboardEvent.code` that toggles visibility. Defaults to `F3`. */
  readonly hotkey?: string;
  /** How often the text is rewritten, in milliseconds. Defaults to `250`. */
  readonly intervalMs?: number;
  /** Frames in the percentile window. Defaults to `120`. */
  readonly samples?: number;
  /** Whether the panel starts visible. Defaults to `true`. */
  readonly visible?: boolean;
  /**
   * A source for one more line (or several, joined by `'\n'`) under the
   * built-in ones, such as the `net` module's room line. Called only when the
   * panel redraws, never per frame. Can also be set later with `setExtra`.
   */
  readonly extra?: () => string;
}

/** The debug overlay. */
export interface DebugOverlay {
  /** The panel element, or `null` when there is no DOM to mount into. */
  readonly element: HTMLElement | null;
  /** The frame-time window behind the numbers. */
  readonly stats: FrameStats;
  /** Whether the panel is currently shown. */
  readonly visible: boolean;

  /**
   * Record a frame and, at most every `intervalMs`, redraw.
   *
   * @param frameMs How long the frame took, in milliseconds.
   * @param nowMs Current timestamp, in milliseconds.
   */
  sample(frameMs: number, nowMs: number): void;

  /**
   * Show or hide the panel.
   *
   * @param value True to show.
   */
  setVisible(value: boolean): void;

  /**
   * Flip visibility. This is what the hotkey does.
   */
  toggle(): void;

  /**
   * Set, replace or clear the extra line source. There is one: a second call
   * replaces the first. The panel redraws now if it is shown.
   *
   * @param source Returns the text to show under the built-in lines, or null to show none.
   */
  setExtra(source: (() => string) | null): void;

  /**
   * Remove the panel and the key listener.
   */
  dispose(): void;
}

/**
 * Inline style for the panel; kept here so the overlay needs no stylesheet.
 * A Gameable glass card (STYLE.md) with the mono stack, because
 * the readout is columns of numbers.
 */
const PANEL_STYLE = [
  'position:fixed',
  'top:8px',
  'right:8px',
  'z-index:2147483647',
  'margin:0',
  'padding:8px 10px',
  'font:500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'font-variant-numeric:tabular-nums',
  'color:#f2f2f4',
  'background:rgba(28,29,34,0.6)',
  'backdrop-filter:blur(10px)',
  '-webkit-backdrop-filter:blur(10px)',
  'border:1px solid #2e2f36',
  'border-radius:12px',
  'white-space:pre',
  'pointer-events:none',
  'user-select:none',
].join(';');

/**
 * Build the debug overlay.
 *
 * On a host with no `document` — Node, a worker, a test — this returns a
 * working overlay whose `element` is `null`: the statistics still accumulate
 * and can be read, nothing is mounted, and nothing throws.
 *
 * @param options Renderer, backend label and panel settings.
 * @returns The overlay.
 *
 * @example
 * ```ts
 * import { createDebugOverlay } from 'gameable/core';
 * import { WebGPURenderer } from 'three/webgpu';
 *
 * const renderer = new WebGPURenderer({ canvas: document.createElement('canvas') });
 * const overlay = createDebugOverlay({ renderer, backendName: 'webgpu' });
 * overlay.sample(16.6, performance.now()); // call once per frame
 * overlay.setExtra(() => 'net    joined KQTX'); // drawn under the built-in lines
 * ```
 */
export function createDebugOverlay(options: DebugOverlayOptions): DebugOverlay {
  const stats = createFrameStats(options.samples ?? DEFAULT_SAMPLE_COUNT);
  const intervalMs = options.intervalMs ?? DEFAULT_OVERLAY_INTERVAL_MS;
  const hotkey = options.hotkey ?? DEFAULT_OVERLAY_HOTKEY;

  let visible = options.visible ?? true;
  let extra: (() => string) | null = options.extra ?? null;
  let lastDraw = Number.NEGATIVE_INFINITY;
  let element: HTMLElement | null = null;
  let onKeyDown: ((event: KeyboardEvent) => void) | null = null;

  const hasDom = typeof document !== 'undefined';
  if (hasDom) {
    element = document.createElement('div');
    element.className = 'gameable-debug-overlay';
    element.setAttribute('style', PANEL_STYLE);
    element.hidden = !visible;
    (options.container ?? document.body).append(element);

    onKeyDown = (event: KeyboardEvent) => {
      if (event.code === hotkey) {
        event.preventDefault();
        overlay.toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
  }

  /**
   * Rewrite the panel text from the current statistics.
   */
  function draw(): void {
    if (element === null) return;
    const render = options.renderer.info.render;
    element.textContent =
      `${options.backendName}  ${stats.fps.toFixed(0)} fps\n` +
      `frame  p50 ${stats.percentile(0.5).toFixed(2)} ms  p95 ${stats.percentile(0.95).toFixed(2)} ms\n` +
      `draw   ${String(render.calls)} calls  ${String(render.triangles)} tris` +
      (extra === null ? '' : `\n${extra()}`);
  }

  const overlay: DebugOverlay = {
    get element() {
      return element;
    },
    stats,
    get visible() {
      return visible;
    },

    sample(frameMs, nowMs) {
      stats.push(frameMs);
      if (!visible || element === null) return;
      if (nowMs - lastDraw < intervalMs) return;
      lastDraw = nowMs;
      draw();
    },

    setVisible(value) {
      visible = value;
      if (element !== null) element.hidden = !value;
      if (value) {
        lastDraw = Number.NEGATIVE_INFINITY;
        draw();
      }
    },

    toggle() {
      overlay.setVisible(!visible);
    },

    setExtra(source) {
      extra = source;
      if (visible) draw();
    },

    dispose() {
      if (onKeyDown !== null) window.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
      element?.remove();
      element = null;
    },
  };

  return overlay;
}
