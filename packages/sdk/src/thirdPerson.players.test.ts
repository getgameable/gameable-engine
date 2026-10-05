import { beforeEach, describe, expect, it } from 'vitest';

import { joined, payloads, rig, roomFrame } from './net/netTesting';
import { prefab, resetPrefabRegistry } from './prefab';
import { hold, stubInput } from './testing';
import { createThirdPersonController } from './thirdPerson';
import type { GameContext } from './defineGame';
import type { AddBodyCmd, MoveCharacterCmd } from './types';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('createThirdPersonController().updatePlayers', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('drives the entity a player possesses, not the one they joined with', () => {
    const body = { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' } as const;
    const Avatar = prefab({ name: 'avatar', body, health: 100 });
    const Car = prefab({ name: 'car', body, health: 100 });
    const controller = createThirdPersonController();
    let car = 0;
    const { guest } = rig(
      {
        player: { prefab: Avatar },
        init: (ctx) => {
          controller.reset(ctx);
        },
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              if (ctx.frame === 2) {
                car = ctx.spawn(Car, { x: 5, y: 0, z: 0 });
                ctx.players.get(0)?.possess(car);
              }
              controller.updatePlayers(ctx);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const w = stubInput();
    hold(w, 'W');
    const players = [{ player: 0, seq: 0, input: w }];
    const bodies = new Map<number, number>();
    const moved: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      const out = guest.tick(roomFrame(frame, frame === 0 ? [joined(0)] : [], players));
      for (const c of payloads<AddBodyCmd>(out.commands, 'add-body')) bodies.set(c.body, c.entity);
      if (frame === 4) {
        for (const c of payloads<MoveCharacterCmd>(out.commands, 'move-character')) {
          moved.push(bodies.get(c.body) ?? -1);
        }
      }
    }
    expect(car).not.toBe(0);
    expect(moved).toEqual([car]);
    expect(controller.stateOf(0)?.vz).toBeLessThan(0);
  });

  it('starts the possessed entity from rest: the seat state resets on an entity change', () => {
    const body = { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' } as const;
    const Avatar = prefab({ name: 'avatar', body, health: 100 });
    const Car = prefab({ name: 'car', body, health: 100 });
    const controller = createThirdPersonController();
    const speeds: number[] = [];
    const { guest } = rig(
      {
        player: { prefab: Avatar },
        init: (ctx) => {
          controller.reset(ctx);
        },
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              if (ctx.frame === 40)
                ctx.players.get(0)?.possess(ctx.spawn(Car, { x: 5, y: 0, z: 0 }));
              controller.updatePlayers(ctx);
              speeds.push(-(controller.stateOf(0)?.vz ?? 0));
            },
          },
        ],
      },
      AUTHORITY,
    );
    const w = stubInput();
    hold(w, 'W');
    const players = [{ player: 0, seq: 0, input: w }];
    for (let frame = 0; frame <= 40; frame += 1) {
      guest.tick(roomFrame(frame, frame === 0 ? [joined(0)] : [], players));
    }
    // 39 steps of W: at the 3.2 m/s default walk speed. The car's first step
    // starts from rest: one step of the default 10 m/s^2 acceleration.
    expect(speeds[39]).toBeCloseTo(3.2, 1);
    expect(speeds[40]).toBeCloseTo(10 / 60, 3);
  });

  it('freezes only the players the predicate names: one talks, the other walks', () => {
    const body = { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' } as const;
    const Avatar = prefab({ name: 'avatar', body, health: 100 });
    const controller = createThirdPersonController();
    const { guest } = rig(
      {
        player: { prefab: Avatar },
        init: (ctx) => {
          controller.reset(ctx);
        },
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              controller.updatePlayers(ctx, (player) => player.id === 0);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const w = stubInput();
    hold(w, 'W');
    const players = [
      { player: 0, seq: 0, input: w },
      { player: 1, seq: 0, input: w },
    ];
    for (let frame = 0; frame < 10; frame += 1) {
      guest.tick(roomFrame(frame, frame === 0 ? [joined(0), joined(1)] : [], players));
    }
    expect(controller.stateOf(0)?.vz).toBeCloseTo(0, 5);
    expect(controller.stateOf(1)?.vz).toBeLessThan(0);
  });
});
