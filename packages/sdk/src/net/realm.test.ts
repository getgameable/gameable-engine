/**
 * Two direct guests in one realm share the SDK's component arrays. The
 * reviewer's probe (3.9a I4): guest A's entity was rewritten by guest B's
 * `init`. Now A's next call after B started throws, loudly, instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { Transform } from '../ecs';
import { prefab, resetPrefabRegistry } from '../prefab';
import { rig, roomFrame } from './netTesting';

describe('one direct guest per realm', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('refuses to tick a guest after a second one started in the same realm', () => {
    const Box = prefab({ name: 'box' });
    const seen: number[] = [];
    const bump = (): void => {
      Transform.x[1] += 1;
      seen.push(Transform.x[1]);
    };
    const a = rig({ spawns: [{ prefab: Box, position: [5, 0, 0] }], systems: [bump] });
    a.guest.tick(roomFrame(0));
    a.guest.tick(roomFrame(1));
    expect(seen).toEqual([6, 7]);
    const b = rig({ spawns: [{ prefab: Box, position: [5, 0, 0] }], systems: [bump] });
    // A would now read B's entity 1 (x = 5 again), not its own 7.
    expect(() => a.guest.tick(roomFrame(2))).toThrow(/two direct guests in one realm/);
    expect(() => a.guest.snapshot()).toThrow(/two direct guests in one realm/);
    b.guest.tick(roomFrame(0));
    expect(seen).toEqual([6, 7, 6]);
  });

  it('lets guests run one after the other', () => {
    const a = rig({});
    a.guest.tick(roomFrame(0));
    a.guest.shutdown();
    const b = rig({});
    expect(() => b.guest.tick(roomFrame(0))).not.toThrow();
  });
});

describe('a client-role guest', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('runs init but never the level spawns: the shared world is the authority’s', () => {
    const Box = prefab({ name: 'box' });
    let inits = 0;
    const { guest } = rig(
      {
        spawns: [{ prefab: Box, position: [1, 0, 0] }],
        init: () => {
          inits += 1;
        },
      },
      '{"net":{"role":"client","localPlayer":1}}',
    );
    const out = guest.tick(roomFrame(0));
    expect(inits).toBe(1);
    expect(out.commands.filter((c) => c.tag === 'spawn')).toEqual([]);
  });
});
