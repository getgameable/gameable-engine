import { describe, expect, it } from 'vitest';
import type { HostContext } from '@gameable/core';
import type { FrameOutput, GameEvent, HostFrameInput } from '@gameable/sdk';

import { NullEngineAdapter, type NullAdapter } from '../adapter/EngineAdapter';
import type { Sandbox } from '../sandbox';
import { GuestLoop } from './GuestLoop';
import type { LoopAdapter, LoopEngine } from './types';

/** A null adapter with the three members a loop needs beyond `EngineAdapter`. */
type ProbeAdapter = NullAdapter & LoopAdapter;

/**
 * @param log Where `applyBodyRows` and `dispose` are recorded.
 * @returns A recording adapter.
 */
function probeAdapter(log: string[]): ProbeAdapter {
  const events: GameEvent[] = [];
  return Object.assign(NullEngineAdapter(), {
    events,
    applyBodyRows: () => log.push('applyBodyRows'),
    dispose: () => log.push('dispose'),
  });
}

/** @returns An engine with no services and an event bus that records nothing. */
function probeEngine(): LoopEngine {
  return {
    modules: { tryGet: () => undefined },
    events: { on: () => () => undefined },
  } as unknown as LoopEngine;
}

/**
 * @param log Where `tick` is recorded.
 * @param out What `tick` returns.
 * @returns A sandbox whose `dead` the test flips.
 */
function probeSandbox(log: string[], out: FrameOutput): Sandbox & { dead: boolean } {
  return {
    mode: 'direct',
    init: () => log.push('init'),
    tick: (input: HostFrameInput) => {
      // The events the guest was handed, so a test can see what was drained.
      log.push(`tick(${String(input.events.length)} events)`);
      return out;
    },
    shutdown: () => log.push('shutdown'),
    snapshot: () => new Uint8Array(0),
    restore: () => undefined,
    dead: false,
    error: null,
  };
}

/** The smallest loop: every hook records its name. */
class ProbeLoop extends GuestLoop<LoopEngine, ProbeAdapter> {
  deaths = 0;

  constructor(
    engine: LoopEngine,
    sandbox: Sandbox,
    adapter: ProbeAdapter,
    private readonly log: string[],
  ) {
    super(engine, sandbox, adapter, {});
  }

  protected initGuest(): void {
    this.sandbox.init({
      seed: 1n,
      fixedHz: 60,
      viewportWidth: 0,
      viewportHeight: 0,
      devMode: false,
    });
  }

  protected beginStep(): void {
    this.log.push('beginStep');
  }

  protected readInput(): void {
    this.log.push('readInput');
  }

  protected entityOfBody(body: number): number {
    return body;
  }

  protected beforeEncode(): void {
    this.log.push('beforeEncode');
    this.adapter.events.push({ tag: 'asset-loaded', val: { asset: 1, name: 'a' } });
  }

  protected onDead(): void {
    this.deaths += 1;
  }
}

/** A loop with no guest: its step returns nothing to apply. */
class ReplicaLoop extends GuestLoop<LoopEngine, ProbeAdapter, null> {
  constructor(
    engine: LoopEngine,
    adapter: ProbeAdapter,
    private readonly log: string[],
  ) {
    super(engine, null, adapter, {});
  }

  protected initGuest(): void {
    this.log.push('initGuest');
  }

  protected beginStep(): void {
    this.log.push('beginStep');
  }

  protected readInput(): void {
    this.log.push('readInput');
  }

  protected entityOfBody(body: number): number {
    return body;
  }

  protected onDead(): void {
    this.log.push('onDead');
  }

  protected override step(): FrameOutput | null {
    this.log.push('step');
    return null;
  }
}

describe('GuestLoop', () => {
  /** @returns An empty, valid frame output. */
  function emptyOut(): FrameOutput {
    return {
      transforms: new Float32Array(0),
      localCommands: [],
      commands: [],
      camera: {
        mode: 'first-person',
        projection: 'perspective',
        position: { x: 0, y: 1.7, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        target: undefined,
        fovYDeg: 75,
        near: 0.1,
        far: 1000,
        follow: undefined,
        armLength: 0,
        offset: { x: 0, y: 0, z: 0 },
      },
      hud: undefined,
    };
  }

  it('runs one fixed step as beginStep, readInput, beforeEncode, tick, apply', () => {
    const log: string[] = [];
    const adapter = probeAdapter(log);
    const loop = new ProbeLoop(probeEngine(), probeSandbox(log, emptyOut()), adapter, log);
    loop.init({} as HostContext);
    log.length = 0;
    adapter.reset();
    loop.fixedUpdate(1 / 60);
    // applyOutput always writes the transforms, so that call marks the apply.
    if (adapter.by('applyTransforms').length > 0) log.push('apply');
    // The event beforeEncode queued reached this tick: it ran before the drain.
    expect(log).toEqual(['beginStep', 'readInput', 'beforeEncode', 'tick(1 events)', 'apply']);
  });

  it('stops ticking a dead guest and reports it once', () => {
    const log: string[] = [];
    const adapter = probeAdapter(log);
    const sandbox = probeSandbox(log, emptyOut());
    const loop = new ProbeLoop(probeEngine(), sandbox, adapter, log);
    loop.init({} as HostContext);
    loop.fixedUpdate(1 / 60);
    sandbox.dead = true;
    adapter.reset();
    loop.fixedUpdate(1 / 60);
    // The inert frame a dying guest returns is never applied.
    expect(adapter.by('applyTransforms')).toHaveLength(0);
    log.length = 0;
    loop.fixedUpdate(1 / 60);
    loop.fixedUpdate(1 / 60);
    expect(log.some((line) => line.startsWith('tick'))).toBe(false);
    expect(loop.deaths).toBe(1);
  });

  it('shuts the guest down and disposes the adapter', () => {
    const log: string[] = [];
    const loop = new ProbeLoop(
      probeEngine(),
      probeSandbox(log, emptyOut()),
      probeAdapter(log),
      log,
    );
    loop.init({} as HostContext);
    log.length = 0;
    loop.dispose();
    expect(log).toEqual(['shutdown', 'dispose']);
  });

  it('runs with no guest: step returns null, nothing is ticked or applied', () => {
    const log: string[] = [];
    const adapter = probeAdapter(log);
    const loop = new ReplicaLoop(probeEngine(), adapter, log);
    loop.init({} as HostContext);
    loop.fixedUpdate(1 / 60);
    loop.fixedUpdate(1 / 60);
    expect(adapter.calls).toHaveLength(0);
    loop.dispose();
    expect(log).toEqual([
      'initGuest',
      'beginStep',
      'readInput',
      'step',
      'beginStep',
      'readInput',
      'step',
      'dispose',
    ]);
  });
});
