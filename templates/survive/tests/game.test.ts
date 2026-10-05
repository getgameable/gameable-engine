/**
 * The camp, driven headlessly as a room's authority (`tests/camp.ts`): the
 * day/night clock, creatures from the tree line walking at the nearest camp
 * body, gather and build, damage, getting up at dawn and the night count.
 */
import { Health } from 'gameable';
import { describe, expect, it } from 'vitest';

import { TREE_LINE, TREE_RING } from '../src/arena';
import { camp, PHASE_DAY, PHASE_NIGHT } from '../src/camp';
import game from '../src/game';
import { WALL_HALF } from '../src/prefabs';
import { bootCamp, lastMove, sends } from './camp';

/** A one-second day and a two-second night, at 60 steps a second. */
const SHORT = { daySeconds: 1, nightSeconds: 2 };

describe('the clock', () => {
  it('lives in ctx.rules and turns day to night to day, and the room list follows', () => {
    expect(game.rules?.daySeconds).toBe(60);
    expect(game.rules?.nightSeconds).toBe(45);
    const c = bootCamp(SHORT);
    const day = c.run(30, (frame, tape) => {
      if (frame === 0) tape.join(0);
    });
    expect(camp.phase).toBe(PHASE_DAY);
    const night = c.run(40);
    expect(camp.phase).toBe(PHASE_NIGHT);
    expect(camp.night).toBe(1);
    const morning = c.run(130);
    expect(camp.phase).toBe(PHASE_DAY);
    const phases = [day, night, morning].flatMap((r) =>
      sends(r, 'aos:phase').map((s) => s.payload),
    );
    expect(phases).toEqual(['day', 'night', 'day']);
    expect(sends(night, 'night')).toEqual([{ to: undefined, payload: { night: 1 } }]);
  });

  it('shows each player the time, their wood, health and nights', () => {
    const c = bootCamp(SHORT);
    const r = c.run(2, (frame, tape) => {
      if (frame === 0) tape.join(0);
    });
    const hud = JSON.parse(r.views[1][0].hud ?? r.views[0][0].hud ?? '{}') as {
      text: Record<string, string>;
    };
    expect(hud.text).toEqual({ time: 'day · 1 s to dusk', wood: '0', health: '100', nights: '0' });
  });
});

describe('the creatures', () => {
  it('spawn at the tree line at dusk, on the authority, more each night', () => {
    const c = bootCamp(SHORT);
    c.run(61, (frame, tape) => {
      if (frame === 0) tape.join(0);
    });
    expect(camp.creatures.count).toBe(3);
    for (let i = 0; i < camp.creatures.count; i += 1) {
      const at = c.where(camp.creatures.items[i]);
      expect(Math.hypot(at.x, at.z)).toBeCloseTo(TREE_LINE, 3);
    }
    c.run(120); // dawn: they are gone
    expect(camp.creatures.count).toBe(0);
    c.run(60); // the second night
    expect(camp.night).toBe(2);
    expect(camp.creatures.count).toBe(4);
  });

  it('walk at the nearest camp body: a survivor, or a wall that is nearer', () => {
    const c = bootCamp(SHORT);
    c.run(61, (frame, tape) => {
      if (frame === 0) {
        tape.join(0);
        tape.join(1);
      }
    });
    const [p0, p1] = [c.tape.entityOf(0), c.tape.entityOf(1)];
    const creature = camp.creatures.items[0];
    c.place(p0, 4, 0);
    c.place(p1, -4, 0);
    c.place(creature, 9, 0);
    // creatureSpeed 2, from x 9 straight at the survivor at x 4.
    const toP0 = lastMove(c.run(2), creature);
    expect(toP0?.x).toBeCloseTo(-2, 3);
    expect(toP0?.z).toBeCloseTo(0, 3);

    // The builder looks down -z, so the wall goes up 1.5 m that way, at (12, 0):
    // 3 m from the creature, nearer than the builder (3.35 m). It turns to the wall.
    camp.wood[0] = 2;
    c.place(p0, 12, 1.5);
    const built = c.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'build');
    });
    expect(camp.walls.count).toBe(1);
    const toWall = lastMove(built, creature);
    expect(toWall?.x).toBeCloseTo(2, 3);
    expect(toWall?.z).toBeCloseTo(0, 3);
  });

  it('hit what they reach: a survivor goes down, a wall falls', () => {
    const c = bootCamp({ ...SHORT, nightSeconds: 30, creaturesFirstNight: 1 });
    c.run(61, (frame, tape) => {
      if (frame === 0) tape.join(0);
    });
    const p0 = c.tape.entityOf(0);
    const creature = camp.creatures.items[0];
    c.place(p0, 0, 0);
    c.place(creature, 1, 0);
    // creatureDamage 10 about once a second: 100 health is ten hits.
    const r = c.run(60 * 10 + 30);
    expect(Health.current[p0]).toBe(0);
    expect(camp.downed[0]).toBe(1);
    expect(sends(r, 'downed')).toEqual([{ to: undefined, payload: { player: 0 } }]);

    // Down, the survivor is no target; a wall is, until it falls (60 health).
    camp.wood[0] = 2;
    camp.downed[0] = 0;
    c.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'build');
    });
    camp.downed[0] = 1;
    const wall = camp.walls.items[0];
    expect(camp.walls.count).toBe(1);
    c.place(creature, 0, -0.5); // the wall went up at (0, -1.5)
    const broke = c.run(60 * 6 + 30);
    expect(camp.walls.count).toBe(0);
    expect(broke.commands.flat()).toContainEqual({ tag: 'despawn', val: wall });
    expect(Health.current[wall]).toBe(0);
  });
});

describe('gather and build', () => {
  it('gather beside a tree adds wood to that player only; away from one, nothing', () => {
    const c = bootCamp();
    c.run(1, (_frame, tape) => {
      tape.join(0);
      tape.join(1);
    });
    c.place(c.tape.entityOf(0), 0, TREE_RING - 1.2); // the tree at (0, 7)
    c.place(c.tape.entityOf(1), 0, 0);
    const r = c.run(2, (frame, tape) => {
      if (frame === 1) {
        tape.message(0, 'gather');
        tape.message(1, 'gather');
      }
    });
    expect(camp.wood[0]).toBe(1);
    expect(camp.wood[1]).toBe(0);
    expect(sends(r, 'wood')).toEqual([{ to: 0, payload: { wood: 1 } }]);
  });

  it('build places a Wall in front of the player when they hold the wood, and not before', () => {
    const c = bootCamp();
    c.run(1, (_frame, tape) => {
      tape.join(0);
    });
    const p0 = c.tape.entityOf(0);
    c.place(p0, 0, TREE_RING - 1.2);
    const broke = c.run(2, (frame, tape) => {
      if (frame === 1) tape.message(0, 'build');
    });
    expect(camp.walls.count).toBe(0);
    expect(sends(broke, 'wood')).toEqual([]);

    c.run(3, (frame, tape) => {
      if (frame === 1) tape.message(0, 'gather');
      if (frame === 2) tape.message(0, 'gather');
    });
    const built = c.run(2, (frame, tape) => {
      if (frame === 1) tape.message(0, 'build');
    });
    expect(camp.walls.count).toBe(1);
    expect(camp.wood[0]).toBe(0);
    const add = built.commands
      .flat()
      .find((cmd) => cmd.tag === 'add-body' && cmd.val.entity === camp.walls.items[0]);
    const at = add?.tag === 'add-body' ? add.val.position : undefined;
    expect(at?.x).toBeCloseTo(0, 3);
    expect(at?.y).toBeCloseTo(WALL_HALF[1], 3);
    // Yaw 0 looks down -z: the wall goes up buildDistance (1.5 m) that way.
    expect(at?.z).toBeCloseTo(TREE_RING - 1.2 - 1.5, 3);
  });
});

describe('dawn', () => {
  it('counts the night for everyone standing, and gets the downed up at the camp', () => {
    const c = bootCamp({ ...SHORT, creaturesFirstNight: 0, creaturesPerNight: 0 });
    c.run(61, (frame, tape) => {
      if (frame === 0) {
        tape.join(0);
        tape.join(1);
      }
    });
    const p1 = c.tape.entityOf(1);
    Health.current[p1] = 0;
    camp.downed[1] = 1;
    const r = c.run(121);
    expect(camp.phase).toBe(PHASE_DAY);
    expect(camp.nightsSurvived[0]).toBe(1);
    expect(camp.nightsSurvived[1]).toBe(0);
    expect(camp.downed[1]).toBe(0);
    expect(Health.current[p1]).toBe(100);
    expect(r.commandTags.flat()).toContain('set-body-transform');
    expect(sends(r, 'dawn')).toEqual([{ to: undefined, payload: { night: 1 } }]);
    // The HUD says so.
    const hud = r.views.flatMap((v) => v).filter((v) => v.player === 0 && v.hud !== undefined);
    expect(hud.at(-1)?.hud).toContain('"nights":"1"');
  });

  it('a seat taken again starts with no wood and no nights', () => {
    const c = bootCamp(SHORT);
    c.run(1, (_frame, tape) => {
      tape.join(0);
    });
    camp.wood[0] = 5;
    camp.nightsSurvived[0] = 3;
    c.run(2, (frame, tape) => {
      if (frame === 0) tape.leave(0);
      if (frame === 1) tape.join(0);
    });
    expect(camp.wood[0]).toBe(0);
    expect(camp.nightsSurvived[0]).toBe(0);
  });

  it('saves the night count in the player document at dawn, and a later visit starts from it', () => {
    const c = bootCamp({ ...SHORT, creaturesFirstNight: 0, creaturesPerNight: 0 });
    // Two nights already kept from an earlier room, beside the rest of the document.
    c.run(61, (frame, tape) => {
      if (frame === 0) tape.join(0, 'Ana', JSON.stringify({ nightsSurvived: 2, hat: 'red' }));
    });
    expect(camp.nightsSurvived[0]).toBe(2);
    const r = c.run(121);
    const saves = r.commands
      .flat()
      .flatMap((cmd) => (cmd.tag === 'save-player-data' ? [cmd.val] : []));
    expect(saves).toEqual([{ player: 0, data: JSON.stringify({ nightsSurvived: 3, hat: 'red' }) }]);

    // The next room: the store hands the saved document back on join.
    const next = bootCamp(SHORT);
    next.run(1, (_frame, tape) => tape.join(0, 'Ana', saves[0]?.data));
    expect(camp.nightsSurvived[0]).toBe(3);
  });
});
