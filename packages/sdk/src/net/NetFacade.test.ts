import { beforeEach, describe, expect, it } from 'vitest';

import { commandPoolSize } from '../commands';
import { prefab, resetPrefabRegistry } from '../prefab';
import { hold, stubInput } from '../testing';
import { message, payloads, rig, roomFrame } from './netTesting';
import type { GameContext } from '../defineGame';

const AUTHORITY = '{"net":{"role":"authority"}}';
const CLIENT = '{"net":{"role":"client","localPlayer":2}}';

describe('ctx.net.local, nested', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('stays local inside a nested call and returns to the network after', () => {
    const Marker = prefab({ name: 'marker' });
    const p = { x: 0, y: 0, z: 0 };
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              ctx.net.local(() => {
                ctx.net.local(() => ctx.spawn(Marker, p));
                ctx.spawn(Marker, p);
              });
              ctx.spawn(Marker, p);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0));
    expect(payloads(out.localCommands, 'spawn')).toHaveLength(2);
    expect(payloads(out.commands, 'spawn')).toHaveLength(1);
  });

  it('restores the network buffer when the callback throws', () => {
    const Marker = prefab({ name: 'marker' });
    const p = { x: 0, y: 0, z: 0 };
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              try {
                ctx.net.local(() => {
                  throw new Error('boom');
                });
              } catch {
                // expected
              }
              ctx.spawn(Marker, p);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0));
    expect(payloads(out.commands, 'spawn')).toHaveLength(1);
    expect(out.localCommands).toHaveLength(0);
  });
});

describe('ctx.net.messages', () => {
  it("returns this tick's messages with that name, parsed", () => {
    const seen: unknown[] = [];
    const { guest } = rig({
      systems: [
        (ctx: GameContext) => {
          for (const m of ctx.net.messages<{ for: number }>('vote'))
            seen.push([m.player, m.payload.for]);
        },
      ],
    });
    guest.tick(
      roomFrame(0, [
        message(1, 'vote', '{"for":2}'),
        message(4, 'chat', '"hi"'),
        message(5, 'vote', '{"for":1}'),
      ]),
    );
    guest.tick(roomFrame(1));
    expect(seen).toEqual([
      [1, 2],
      [5, 1],
    ]);
  });

  it('drops a malformed payload and counts it, once per message', () => {
    let count = -1;
    let dropped = -1;
    const { guest } = rig({
      systems: [
        (ctx: GameContext) => {
          count = ctx.net.messages('vote').length;
          // A second read in the same tick must not count the drop twice.
          count = ctx.net.messages('vote').length;
          dropped = ctx.net.stats.dropped;
        },
      ],
    });
    guest.tick(roomFrame(0, [message(1, 'vote', '{nope'), message(2, 'vote', '{"for":1}')]));
    expect(count).toBe(1);
    expect(dropped).toBe(1);
  });
});

describe('bare systems under features.multiplayer', () => {
  it('run on the authority and not on a client', () => {
    const seen: string[] = [];
    const spec = {
      features: { multiplayer: true },
      systems: [
        (ctx: GameContext) => {
          seen.push(ctx.net.role);
        },
      ],
    };
    rig(spec, CLIENT).guest.tick(roomFrame(0));
    rig(spec, AUTHORITY).guest.tick(roomFrame(0));
    rig(spec).guest.tick(roomFrame(0));
    expect(seen).toEqual(['authority', 'solo']);
  });
});

describe('the singleton input on a client', () => {
  it("reads the local player's slot", () => {
    const seen: boolean[] = [];
    const { guest } = rig(
      {
        systems: [
          (ctx: GameContext) => {
            seen.push(ctx.input.isDown('W'), ctx.localPlayer?.input.isDown('W') ?? false);
          },
        ],
      },
      CLIENT,
    );
    const two = stubInput();
    hold(two, 'W');
    guest.tick(roomFrame(0, [], [{ player: 2, seq: 0, input: two }]));
    expect(seen).toEqual([true, true]);
  });
});

describe('per-player camera', () => {
  it('emits one set-player-camera per player per tick, however often it is touched', () => {
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              const p = ctx.players.get(3);
              p?.camera.set({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: 1 });
              p?.camera.lookAt({ x: 0, y: 0, z: 0 });
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0, [], [{ player: 3, seq: 0, input: stubInput() }]));
    const cams = payloads<{ player: number; camera: { position: { x: number } } }>(
      out.commands,
      'set-player-camera',
    );
    expect(cams).toHaveLength(1);
    expect(cams[0].player).toBe(3);
    expect(cams[0].camera.position.x).toBe(1);
    expect(out.camera.position.x).not.toBe(1);
  });
});

describe('a room tick in the steady state', () => {
  it('grows no command pool', () => {
    const model = { n: 0 };
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              for (const [, p] of ctx.players) {
                p.camera.firstPerson(p.entity);
                model.n = ctx.frame % 2;
                p.hud.set(model);
              }
              ctx.net.messages('none');
            },
          },
        ],
      },
      AUTHORITY,
    );
    const players = [
      { player: 1, seq: 0, input: stubInput() },
      { player: 2, seq: 0, input: stubInput() },
    ];
    for (let i = 0; i < 10; i += 1) guest.tick(roomFrame(i, [], players));
    const before = commandPoolSize();
    for (let i = 10; i < 200; i += 1) guest.tick(roomFrame(i, [], players));
    expect(commandPoolSize()).toBe(before);
  });
});

describe('malformed net options', () => {
  /**
   * @param options The options JSON.
   * @returns What `init` threw.
   */
  function initError(options: string): { code?: string; message?: string } {
    try {
      rig({}, options);
    } catch (err) {
      return err as { code?: string; message?: string };
    }
    return {};
  }

  it('fail init loudly with init-failed, naming the bad value', () => {
    const bad = initError('not json');
    expect(bad.code).toBe('init-failed');
    expect(bad.message).toContain('not JSON');
    const role = initError('{"net":{"role":"server"}}');
    expect(role.code).toBe('init-failed');
    expect(role.message).toContain('"server"');
  });

  it('absent options, absent net or an explicit solo stay solo', () => {
    for (const options of [undefined, '{"mode":"duel"}', '{"net":{"role":"solo"}}']) {
      const { guest, ctx } = rig({}, options);
      guest.tick(roomFrame(0));
      expect(ctx().net.role).toBe('solo');
    }
  });
});

describe('ctx.net.send refuses', () => {
  /**
   * @param payload What the system sends.
   * @returns The log lines and the sends of one tick.
   */
  function sendOnce(payload: unknown): { lines: string[]; sends: number } {
    const { guest, host } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              ctx.net.send('x', payload);
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0));
    return { lines: host.lines, sends: payloads(out.commands, 'send').length };
  }

  it('a payload that does not serialise', () => {
    const r = sendOnce(() => 1);
    expect(r.sends).toBe(0);
    expect(r.lines.some((l) => l.includes('not JSON-serialisable'))).toBe(true);
  });

  it('a payload over 2,048 bytes, with its size', () => {
    const r = sendOnce({ s: 'é'.repeat(1100) });
    expect(r.sends).toBe(0);
    expect(r.lines.some((l) => l.includes('2208 bytes') && l.includes('2048'))).toBe(true);
    expect(sendOnce({ s: 'a'.repeat(2000) }).sends).toBe(1);
  });
});
