import { describe, expect, it, vi } from 'vitest';
import { createHeadlessEngine } from './headless.js';
import type { EngineModule } from './module.js';

describe('createHeadlessEngine', () => {
  it('inits modules in order with a context that has no renderer', async () => {
    const log: string[] = [];
    const m = (id: string, order: number): EngineModule => ({
      id,
      order,
      init: (ctx) => {
        log.push(`init:${id}:${String('renderer' in ctx)}`);
      },
      fixedUpdate: () => {
        log.push(`step:${id}`);
      },
      dispose: () => {
        log.push(`dispose:${id}`);
      },
    });
    const engine = await createHeadlessEngine({ modules: [m('b', 0), m('a', -10)], fixedHz: 60 });
    expect(log).toEqual(['init:a:false', 'init:b:false']);
    expect(engine.ctx.config.headless).toBe(true);
    expect(engine.ctx.caps.webgpu).toBe(false);
    engine.step(0);
    engine.step(1000 / 60);
    expect(log.filter((l) => l.startsWith('step'))).toEqual(['step:a', 'step:b']);
    await engine.dispose();
    expect(log.slice(-2)).toEqual(['dispose:b', 'dispose:a']);
  });
  it('step returns the frame timing and advances time by whole steps', async () => {
    const engine = await createHeadlessEngine({ fixedHz: 60 });
    engine.step(0);
    const t = engine.step(1000 / 30);
    expect(t.substeps).toBe(2);
    expect(engine.time.elapsed).toBeCloseTo(2 / 60, 6);
    await engine.dispose();
  });
  it('start/stop ticks on its own and stop really stops', async () => {
    const engine = await createHeadlessEngine({ fixedHz: 120 });
    engine.start();
    await new Promise((r) => setTimeout(r, 60));
    engine.stop();
    const after = engine.time.elapsed;
    expect(after).toBeGreaterThan(0.02);
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.time.elapsed).toBe(after);
    await engine.dispose();
  });
  it('emits engine:frame with the frame count and the step timing', async () => {
    const engine = await createHeadlessEngine({ fixedHz: 60 });
    const seen: string[] = [];
    engine.events.on('engine:frame', (f) => {
      seen.push(`${String(f.frame)}:${String(f.substeps)}:${f.dtReal.toFixed(4)}`);
    });
    engine.step(0);
    engine.step(1000 / 60);
    expect(seen).toEqual(['1:0:0.0000', '2:1:0.0167']);
    expect(engine.time.renderFrame).toBe(2);
    await engine.dispose();
  });
  it('rejects a non-positive fixedHz', async () => {
    await expect(createHeadlessEngine({ fixedHz: 0 })).rejects.toThrow(RangeError);
  });
  it('start emits engine:start before the first step, which waits for the timer', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const engine = await createHeadlessEngine({
        fixedHz: 60,
        modules: [
          {
            id: 'm',
            init: () => undefined,
            fixedUpdate: () => {
              log.push('step');
            },
            dispose: () => undefined,
          },
        ],
      });
      engine.events.on('engine:start', () => {
        log.push('start');
      });
      engine.events.on('engine:frame', () => {
        log.push('frame');
      });
      engine.start();
      expect(log).toEqual(['start']);
      vi.advanceTimersByTime(0);
      expect(log).toEqual(['start', 'frame']);
      vi.advanceTimersByTime(1000 / 60 + 1);
      expect(log.slice(0, 4)).toEqual(['start', 'frame', 'step', 'frame']);
      await engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
