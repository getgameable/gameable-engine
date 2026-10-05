import { createEvents } from '@gameable/core';
import type { EngineContext, EngineEventMap, Events } from '@gameable/core';
import { Scene } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { physics, type PhysicsService, type PhysicsSteppedEvent } from './module.js';
import { BODY_STRIDE } from './world.js';

/**
 * The module reads exactly one thing off the context: the event bus it
 * announces `physics:stepped` on.
 *
 * @param events The bus to hand it, or a fresh one.
 * @returns A stub engine context.
 */
function stubContext(events: Events<EngineEventMap> = createEvents<EngineEventMap>()): EngineContext {
  return { events } as unknown as EngineContext;
}

/** The shape of the debug `LineSegments` this test pokes at. */
interface DebugLine {
  geometry: { attributes: Record<string, { array: Float32Array; count: number }> };
}

describe('physics()', () => {
  it('publishes the world as the `physics` service and steps it in fixedUpdate', async () => {
    const module = physics({ gravity: [0, -10, 0], maxBodies: 64 });
    expect(module.id).toBe('physics');
    expect(module.order).toBe(0);

    const service = (await module.init(stubContext())) as PhysicsService;
    try {
      service.addBody({
        id: 1,
        shape: 'box',
        dims: [10, 0.5, 10],
        position: [0, -0.5, 0],
        rotation: [0, 0, 0, 1],
        mass: 0,
        kind: 'static',
        layer: 0b1,
        mask: 0xffff,
        friction: 0.5,
        restitution: 0,
      });
      service.addBody({
        id: 2,
        shape: 'sphere',
        dims: [0.5],
        position: [0, 5, 0],
        rotation: [0, 0, 0, 1],
        mass: 1,
        kind: 'dynamic',
        layer: 0b10,
        mask: 0xffff,
        friction: 0.5,
        restitution: 0,
      });

      const out = new Float32Array(BODY_STRIDE);
      service.readBodies(out);
      const startY = out[2];
      for (let i = 0; i < 30; i += 1) module.fixedUpdate?.(1 / 60);
      service.readBodies(out);
      expect(out[2]).toBeLessThan(startY - 1);
    } finally {
      module.dispose();
    }
  }, 60_000);

  it('announces every step on `physics:stepped`, with one reused payload', async () => {
    const events = createEvents<EngineEventMap>();
    const module = physics({ maxBodies: 64 });
    const service = (await module.init(stubContext(events))) as PhysicsService;
    const seen: PhysicsSteppedEvent[] = [];
    const rows: number[] = [];
    events.on('physics:stepped', (payload) => {
      seen.push(payload);
      rows.push(payload.movingBodyCount);
    });
    try {
      service.addBody({
        id: 1,
        shape: 'sphere',
        dims: [0.5],
        position: [0, 5, 0],
        rotation: [0, 0, 0, 1],
        mass: 1,
        kind: 'dynamic',
        layer: 0b10,
        mask: 0xffff,
        friction: 0.5,
        restitution: 0,
      });
      module.fixedUpdate?.(1 / 60);
      module.fixedUpdate?.(1 / 60);

      expect(seen).toHaveLength(2);
      // One payload object, rewritten: reading it late is a bug the docs warn
      // about, and this is what makes the step allocation-free.
      expect(seen[0]).toBe(seen[1]);
      expect(rows).toEqual([1, 1]);
      expect(seen[0].dt).toBeCloseTo(1 / 60);
    } finally {
      module.dispose();
    }
  }, 60_000);

  it('attaches a wireframe that only rebuilds when the body set changes', async () => {
    const module = physics({ maxBodies: 64 });
    const service = (await module.init(stubContext())) as PhysicsService;
    const scene = new Scene();
    try {
      service.debugWireframe(scene);
      // The view loads lazily, so the lines arrive a microtask or two later.
      await vi.waitFor(() => {
        expect(scene.children).toHaveLength(1);
      });

      service.addBody({
        id: 1,
        shape: 'box',
        dims: [1, 1, 1],
        position: [0, 4, 0],
        rotation: [0, 0, 0, 1],
        mass: 1,
        kind: 'dynamic',
        layer: 0b1,
        mask: 0xffff,
        friction: 0.5,
        restitution: 0,
      });
      module.fixedUpdate?.(1 / 60);
      module.update?.(1 / 60, 0);

      const line = scene.children[0] as unknown as DebugLine;
      const position = line.geometry.attributes.position;
      // 12 edges, two endpoints each, one body.
      expect(position.count).toBe(24);
      const buffer = position.array;
      expect(buffer.some((v) => v !== 0)).toBe(true);

      // Stepping alone must not reallocate the buffer.
      for (let i = 0; i < 10; i += 1) {
        module.fixedUpdate?.(1 / 60);
        module.update?.(1 / 60, 0);
      }
      expect((scene.children[0] as unknown as DebugLine).geometry.attributes.position).toBe(
        position,
      );

      service.debugWireframe(null);
      expect(scene.children).toHaveLength(0);
    } finally {
      module.dispose();
    }
  }, 60_000);
});
