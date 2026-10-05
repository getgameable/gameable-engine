import { describe, expect, it } from 'vitest';

import { stubInput, hold } from '../testing';
import { joined, left, rig, roomFrame } from './netTesting';
import type { GameContext } from '../defineGame';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('per-player look', () => {
  it("integrates each player's own mouse, so their camera turns", () => {
    const yaws: number[] = [];
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              const p = ctx.players.get(3);
              p?.camera.firstPerson(0);
              yaws.push(p?.camera.look.yaw ?? NaN, ctx.camera.look.yaw);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const three = stubInput();
    three.mouse.dx = 100;
    guest.tick(roomFrame(0, [joined(3)], [{ player: 3, seq: 0, input: three }]));
    // 100 px at the default 0.0025 rad/px, to the left; the frame's own look is untouched.
    expect(yaws[0]).toBeCloseTo(-0.25);
    expect(yaws[1]).toBe(0);
  });
});

describe('per-player axis2', () => {
  it('gives each player their own result object', () => {
    let a: unknown = null;
    let b: unknown = null;
    let ax = 0;
    const { guest } = rig({
      systems: [
        (ctx: GameContext) => {
          const one = ctx.players.get(1)?.input.axis2('A', 'D', 'S', 'W');
          const two = ctx.players.get(2)?.input.axis2('A', 'D', 'S', 'W');
          a = one;
          b = two;
          ax = one?.y ?? NaN;
        },
      ],
    });
    const one = stubInput();
    hold(one, 'W');
    guest.tick(
      roomFrame(
        0,
        [],
        [
          { player: 1, seq: 0, input: one },
          { player: 2, seq: 0, input: stubInput() },
        ],
      ),
    );
    expect(a).not.toBe(b);
    expect(ax).toBe(1);
    expect((b as { y: number }).y).toBe(0);
  });
});

describe('a seat taken again', () => {
  it('inherits neither the name, the data, the camera, the look nor the input', () => {
    let step = 0;
    let seenX = Number.NaN;
    const { guest, ctx } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (c: GameContext) => {
              if (step === 2) seenX = c.players.get(3)?.camera.state.position.x ?? Number.NaN;
              if (step === 0)
                c.players.get(3)?.camera.set({ x: 9, y: 9, z: 9 }, { x: 0, y: 0, z: 0, w: 1 });
            },
          },
        ],
      },
      AUTHORITY,
    );
    const three = stubInput();
    hold(three, 'W');
    three.mouse.dx = 100;
    guest.tick(
      roomFrame(
        0,
        [{ tag: 'player-joined', val: { player: 3, name: 'ada', data: '{"gold":5}' } }],
        [{ player: 3, seq: 0, input: three }],
      ),
    );
    const handle = ctx().players.get(3);
    expect(handle?.data).toEqual({ gold: 5 });

    step = 1;
    guest.tick(roomFrame(1, [left(3)]));
    expect(handle?.name).toBe('');
    expect(handle?.data).toBeNull();
    expect(handle?.input.isDown('W')).toBe(false);

    step = 2;
    guest.tick(roomFrame(2, [joined(3, 'bo')]));
    expect(handle?.name).toBe('bo');
    expect(seenX).not.toBe(9);
    expect(seenX).not.toBeNaN();
    expect(handle?.camera.look.yaw).toBe(0);
    expect(handle?.input.isDown('W')).toBe(false);
  });
});
