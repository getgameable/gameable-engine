import { describe, expect, it } from 'vitest';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { CameraState, Command, ExchangeCmd, FrameOutput } from '@gameable/sdk';

import { applyOutput } from '../apply';
import { createServerAdapter } from './createServerAdapter';
import type { DataSink } from './types';

/** Nothing here reaches physics. */
const NO_PHYSICS = {} as PhysicsService;

const camera = (x: number): CameraState => ({
  mode: 'first-person',
  projection: 'perspective',
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  target: undefined,
  fovYDeg: 75,
  near: 0.1,
  far: 1000,
  follow: undefined,
  armLength: 0,
  offset: { x: 0, y: 0, z: 0 },
});

/**
 * @param commands The frame's shared commands.
 * @param localCommands The frame's authority-only commands.
 * @returns A frame output.
 */
const out = (commands: Command[], localCommands: Command[] = []): FrameOutput => ({
  transforms: new Float32Array(12),
  commands,
  localCommands,
  camera: camera(0),
  hud: undefined,
});

const send = (to: number | undefined, name: string): Command => ({
  tag: 'send',
  val: { to, name, payload: '{}', reliable: true },
});

describe('the server adapter, per player', () => {
  it('lands set-player-camera and set-player-hud on the player they name, copied', () => {
    const a = createServerAdapter(NO_PHYSICS);
    const cam = camera(7);
    a.beginTick();
    applyOutput(
      a,
      out([
        { tag: 'set-player-camera', val: { player: 2, camera: cam } },
        { tag: 'set-player-hud', val: { player: 2, hud: '{"role":"murderer"}' } },
      ]),
    );
    cam.position.x = 99;
    expect(a.perPlayer[2].camera?.position.x).toBe(7);
    expect(a.perPlayer[2].hud).toBe('{"role":"murderer"}');
    expect(a.perPlayer[1].hud).toBeUndefined();
    // The frame camera is still player 0's.
    expect(a.perPlayer[0].camera?.position.x).toBe(0);
  });

  it('keeps targeted sends on their player and the rest as broadcasts, for one tick', () => {
    const a = createServerAdapter(NO_PHYSICS);
    a.beginTick();
    applyOutput(a, out([send(2, 'vote'), send(undefined, 'round'), send(2, 'clue')]));
    expect(a.perPlayer[2].sends.map((s) => s.name)).toEqual(['vote', 'clue']);
    expect(a.broadcasts.map((s) => s.name)).toEqual(['round']);
    expect(a.perPlayer[2].sends[0].to).toBe(2);

    a.beginTick();
    expect(a.perPlayer[2].sends).toHaveLength(0);
    expect(a.broadcasts).toHaveLength(0);
  });

  it('reuses its send copies once warm', () => {
    const a = createServerAdapter(NO_PHYSICS);
    a.beginTick();
    applyOutput(a, out([send(1, 'a')]));
    const first = a.perPlayer[1].sends[0];
    a.beginTick();
    applyOutput(a, out([send(1, 'b')]));
    expect(a.perPlayer[1].sends[0]).toBe(first);
    expect(first.name).toBe('b');
  });

  it('applies localCommands, after commands, but a local send reaches no player', () => {
    const a = createServerAdapter(NO_PHYSICS);
    expect(a.appliesLocal).toBe(true);
    a.beginTick();
    applyOutput(a, out([send(1, 'shared')], [send(1, 'local')]));
    // A local command never leaves the authority (spec 4.3; ruling I1, task 3.6b fix round 1).
    expect(a.perPlayer[1].sends.map((s) => s.name)).toEqual(['shared']);
  });
});

describe("the server adapter, a player's own view", () => {
  it("wins over the frame camera and HUD for that tick, then the frame's applies again", () => {
    const a = createServerAdapter(NO_PHYSICS);
    a.beginTick();
    applyOutput(a, {
      ...out([
        { tag: 'set-player-camera', val: { player: 0, camera: camera(9) } },
        { tag: 'set-player-hud', val: { player: 0, hud: '{"mine":1}' } },
      ]),
      hud: '{"frame":1}',
    });
    expect(a.perPlayer[0].camera?.position.x).toBe(9);
    expect(a.perPlayer[0].hud).toBe('{"mine":1}');

    a.beginTick();
    applyOutput(a, { ...out([]), hud: '{"frame":2}' });
    expect(a.perPlayer[0].camera?.position.x).toBe(0);
    expect(a.perPlayer[0].hud).toBe('{"frame":2}');
  });
});

describe('the server adapter, data commands', () => {
  const exchange: ExchangeCmd = { id: 4, a: 1, b: 2, give: '{"gold":1}', take: '{}' };
  const data: Command[] = [
    { tag: 'save-player-data', val: { player: 1, data: '{"gold":3}' } },
    { tag: 'save-game-data', val: { data: '{"round":2}' } },
    { tag: 'exchange', val: exchange },
  ];

  it('go to the data sink', () => {
    const seen: unknown[] = [];
    const dataSink: DataSink = {
      savePlayer: (player, json) => seen.push(['player', player, json]),
      saveGame: (json) => seen.push(['game', json]),
      exchange: (cmd) => seen.push(['exchange', cmd.id, cmd.a, cmd.b]),
    };
    const a = createServerAdapter(NO_PHYSICS, { dataSink, warn: () => undefined });
    a.beginTick();
    applyOutput(a, out(data));
    expect(seen).toEqual([
      ['player', 1, '{"gold":3}'],
      ['game', '{"round":2}'],
      ['exchange', 4, 1, 2],
    ]);
  });

  it('without a sink are dropped, with one warning each', () => {
    const warnings: string[] = [];
    const a = createServerAdapter(NO_PHYSICS, { warn: (m) => warnings.push(m) });
    for (let i = 0; i < 3; i += 1) {
      a.beginTick();
      applyOutput(a, out(data));
    }
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.includes('no store'))).toBe(true);
  });
});
