// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { keyIndex } from './keycodes';
import { input, type InputService } from './module';
import type { EngineContext } from '@gameable/core';
import { isDown } from './state';

/**
 * A minimal engine context: just the renderer's canvas, which is all input
 * reads out of the real one.
 *
 * @returns The context.
 */
function context(): EngineContext {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  // Input reads exactly one field off the real context, so the rest of the
  // host surface (scene, camera, assets, events, clock) is not built here.
  return { renderer: { domElement: canvas } } as unknown as EngineContext;
}

describe('input()', () => {
  it('is an EngineModule with a stable id and an early order', () => {
    const module = input();
    expect(module.id).toBe('input');
    expect(module.order).toBe(-100);
    expect(typeof module.beginFrame).toBe('function');
    expect(typeof module.fixedUpdate).toBe('function');
    expect(typeof module.endFrame).toBe('function');
    expect(module.service).toBeNull();
  });

  it('returns its service from init and withdraws it on dispose', () => {
    const ctx = context();
    const module = input({ actions: { jump: ['Space'] } });
    const service: InputService = module.init(ctx);

    expect(service).toBe(module.service);
    expect(service.actions.names).toEqual(['jump']);
    expect(typeof service.requestPointerLock).toBe('function');
    expect(typeof service.exitPointerLock).toBe('function');

    module.dispose();
    expect(module.service).toBeNull();
  });

  it('drives the capture from beginFrame, fixedUpdate and endFrame', () => {
    const ctx = context();
    const module = input({ actions: { jump: ['Space'], move: { axis2: ['A', 'D', 'S', 'W'] } } });
    const service = module.init(ctx);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));

    module.beginFrame();
    // Held state is published by beginFrame; the edge waits for a fixed step.
    expect(service.actions.down('jump')).toBe(true);
    expect(service.actions.pressed('jump')).toBe(false);

    module.fixedUpdate(1 / 60);
    expect(service.actions.pressed('jump')).toBe(true);
    expect([...service.actions.axis2('move')]).toEqual([1, 0]);
    expect(isDown(service.state, keyIndex('Space'))).toBe(true);

    // A second step in the same frame does not see the edge again.
    module.fixedUpdate(1 / 60);
    expect(service.actions.pressed('jump')).toBe(false);
    module.endFrame();

    // The edge is gone, the hold is not.
    expect(service.actions.pressed('jump')).toBe(false);
    expect(service.actions.down('jump')).toBe(true);

    module.dispose();
  });

  it('holds an edge across frames that run no fixed step', () => {
    const module = input({ actions: { jump: ['Space'] } });
    const service = module.init(context());

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));

    // Ten rendered frames and not one simulation step: the old capture threw
    // the press away on the first `endFrame`.
    for (let i = 0; i < 10; i += 1) {
      module.beginFrame();
      module.endFrame();
    }

    module.beginFrame();
    module.fixedUpdate(1 / 60);
    expect(service.actions.pressed('jump')).toBe(true);
    module.endFrame();

    module.dispose();
  });

  it('exposes consume() for a host that drives the loop itself', () => {
    const module = input({ actions: { jump: ['Space'] } });
    const service = module.init(context());
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    service.consume();
    expect(service.actions.pressed('jump')).toBe(true);
    module.dispose();
  });

  it('survives beginFrame before init and after dispose', () => {
    const module = input();
    expect(() => {
      module.beginFrame();
      module.fixedUpdate(1 / 60);
      module.endFrame();
    }).not.toThrow();

    module.init(context());
    module.dispose();
    expect(() => {
      module.beginFrame();
      module.fixedUpdate(1 / 60);
    }).not.toThrow();
  });

  it('captures from an explicit target when given one', () => {
    const target = document.createElement('canvas');
    document.body.append(target);
    const module = input({ target, actions: { fire: ['LMB'] } });
    const service = module.init(context());

    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    module.beginFrame();
    module.fixedUpdate(1 / 60);
    expect(service.actions.down('fire')).toBe(true);
    module.dispose();
  });
});
