import type { WebGPURenderer } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDebugOverlay, DEFAULT_OVERLAY_HOTKEY } from './overlay.js';

/** A renderer stub exposing only the counters the overlay reads. */
const renderer = {
  info: { render: { calls: 3, triangles: 4242 } },
} as unknown as WebGPURenderer;

describe('createDebugOverlay', () => {
  it('has the F3 hotkey by default', () => {
    expect(DEFAULT_OVERLAY_HOTKEY).toBe('F3');
  });

  it('degrades to a headless overlay when there is no document', () => {
    const overlay = createDebugOverlay({ renderer, backendName: 'webgpu' });
    expect(overlay.element).toBeNull();
    expect(() => {
      overlay.dispose();
    }).not.toThrow();
  });

  it('accumulates statistics even with no DOM', () => {
    const overlay = createDebugOverlay({ renderer, backendName: 'webgl', samples: 4 });

    for (const ms of [10, 20, 30, 40]) overlay.sample(ms, 0);

    expect(overlay.stats.count).toBe(4);
    expect(overlay.stats.percentile(0.5)).toBe(30);
    overlay.dispose();
  });

  it('starts visible and toggles', () => {
    const overlay = createDebugOverlay({ renderer, backendName: 'webgpu' });
    expect(overlay.visible).toBe(true);

    overlay.toggle();
    expect(overlay.visible).toBe(false);

    overlay.setVisible(true);
    expect(overlay.visible).toBe(true);
    overlay.dispose();
  });

  it('can start hidden', () => {
    const overlay = createDebugOverlay({ renderer, backendName: 'webgpu', visible: false });
    expect(overlay.visible).toBe(false);
    overlay.dispose();
  });
});

/** The parts of an element the overlay touches. */
interface FakeElement {
  className: string;
  hidden: boolean;
  textContent: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/**
 * Give the overlay just enough DOM to mount: a `document` that makes plain
 * objects and a `window` that takes key listeners.
 *
 * @returns The container the panel is appended to, holding what was appended.
 */
function stubDom(): { append(element: FakeElement): void; children: FakeElement[] } {
  vi.stubGlobal('document', {
    createElement: (): FakeElement => ({
      className: '',
      hidden: false,
      textContent: '',
      setAttribute: () => undefined,
      remove: () => undefined,
    }),
  });
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const children: FakeElement[] = [];
  return {
    children,
    append: (element) => {
      children.push(element);
    },
  };
}

describe('the extra line', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws the extra source under the built-in lines', () => {
    const container = stubDom();
    const overlay = createDebugOverlay({
      renderer,
      backendName: 'webgpu',
      container: container as unknown as HTMLElement,
      extra: () => 'net    joined KQTX',
    });
    overlay.sample(16, 0);
    const text = container.children[0]?.textContent ?? '';
    expect(text.split('\n')).toHaveLength(4);
    expect(text.endsWith('\nnet    joined KQTX')).toBe(true);
    overlay.dispose();
  });

  it('is called only when the panel redraws, not once per frame', () => {
    const container = stubDom();
    let calls = 0;
    const overlay = createDebugOverlay({
      renderer,
      backendName: 'webgpu',
      container: container as unknown as HTMLElement,
      intervalMs: 250,
      extra: () => {
        calls += 1;
        return 'net';
      },
    });
    // 60 frames over one second: four redraws (0, 250, 500, 750 ms), not 60 calls.
    for (let frame = 0; frame < 60; frame += 1) overlay.sample(16, frame * (1000 / 60));
    expect(calls).toBe(4);
    overlay.dispose();
  });

  it('can be set, replaced and cleared after the overlay exists', () => {
    const container = stubDom();
    const overlay = createDebugOverlay({
      renderer,
      backendName: 'webgpu',
      container: container as unknown as HTMLElement,
    });
    const element = container.children[0];
    overlay.setExtra(() => 'first');
    expect(element.textContent.endsWith('\nfirst')).toBe(true);
    overlay.setExtra(() => 'second');
    expect(element.textContent.endsWith('\nsecond')).toBe(true);
    expect(element.textContent).not.toContain('first');
    overlay.setExtra(null);
    expect(element.textContent.endsWith('tris')).toBe(true);
    overlay.dispose();
  });

  it('is not called while the panel is hidden', () => {
    const container = stubDom();
    let calls = 0;
    const overlay = createDebugOverlay({
      renderer,
      backendName: 'webgpu',
      container: container as unknown as HTMLElement,
      visible: false,
    });
    overlay.setExtra(() => {
      calls += 1;
      return 'net';
    });
    overlay.sample(16, 0);
    overlay.sample(16, 1000);
    expect(calls).toBe(0);
    overlay.dispose();
  });

  it('accepts a source with no DOM and never calls it', () => {
    let calls = 0;
    const overlay = createDebugOverlay({ renderer, backendName: 'webgpu' });
    overlay.setExtra(() => {
      calls += 1;
      return 'net';
    });
    overlay.sample(16, 0);
    expect(calls).toBe(0);
    overlay.dispose();
  });
});
