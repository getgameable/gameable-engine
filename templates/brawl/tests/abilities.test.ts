/**
 * The fight on the authority, driven by `simulatePlayers`: abilities checked
 * for cooldown, range and facing; a hit's knockback and its confirmation; a
 * knockout, a respawn and the round. Fighters stand where the body rows put
 * them, as the authority's physics would.
 */
import type { Command } from 'gameable';
import { simulatePlayers, type PlayersInput } from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { SPAWNS } from '../src/fight';
import type { HitPayload } from '../src/messages';
import { boot, payloads, rows, velocityOf } from './arena';

/** Where the two fighters stand: seat 0 faces +x at first, seat 1 is in front of it. */
type Stance = Map<number, readonly [number, number]>;

/**
 * Run two fighters for `frames` steps; seat 0 sends what `act` says.
 *
 * @param frames How many steps.
 * @param where Each seat's `[x, z]`, from frame 1 on.
 * @param act Frame to the message seat 0 sends on it.
 * @returns `simulatePlayers`' result.
 */
function fightFor(
  frames: number,
  where: readonly (readonly [number, number])[],
  act: (frame: number) => string | null,
): ReturnType<typeof simulatePlayers> {
  const guest = boot();
  const stance: Stance = new Map();
  return simulatePlayers(guest, {
    frames,
    players: 4,
    keepOutputs: true,
    script: (frame, tape: PlayersInput) => {
      if (frame === 0) {
        tape.join(0);
        tape.join(1);
        return {};
      }
      stance.clear();
      where.forEach((at, seat) => stance.set(tape.entityOf(seat), at));
      const name = act(frame);
      if (name !== null) tape.message(0, name);
      return { bodies: rows(stance) };
    },
  });
}

/**
 * @param result A run.
 * @param frame A frame.
 * @param seat A seat.
 * @returns What that seat was sent on that frame.
 */
const sendsOf = (result: ReturnType<typeof simulatePlayers>, frame: number, seat: number) =>
  result.views[frame].find((v) => v.player === seat)?.sends ?? [];

describe('the abilities, checked on the authority', () => {
  it('a punch in range and in front lands: the attacker and the victim are both told', () => {
    const result = fightFor(
      4,
      [
        [0, 0],
        [1, 0],
      ],
      (f) => (f === 2 ? 'punch' : null),
    );
    const toAttacker = payloads<HitPayload>(sendsOf(result, 2, 0), 'hit');
    const toVictim = payloads<HitPayload>(sendsOf(result, 2, 1), 'hit');
    expect(toAttacker).toEqual([{ by: 0, to: 1, ability: 0, damage: 12, hp: 88 }]);
    expect(toVictim).toEqual(toAttacker);
    // Addressed to each of them, not to everyone.
    expect(sendsOf(result, 2, 0).find((s) => s.name === 'hit')?.broadcast).toBe(false);
  });

  it('a second punch inside the cooldown is refused, and lands once it is over', () => {
    // 0.4 s is 24 steps: frame 10 is too soon after frame 2, frame 30 is not.
    const result = fightFor(
      32,
      [
        [0, 0],
        [1, 0],
      ],
      (f) => (f === 2 || f === 10 || f === 30 ? 'punch' : null),
    );
    expect(payloads(sendsOf(result, 10, 0), 'refused')).toEqual([{ ability: 0, why: 'cooldown' }]);
    expect(payloads(sendsOf(result, 10, 0), 'hit')).toEqual([]);
    expect(payloads<HitPayload>(sendsOf(result, 30, 0), 'hit')[0]?.hp).toBe(76);
  });

  it('a punch out of range is refused, and so is one at someone behind', () => {
    const far = fightFor(
      4,
      [
        [0, 0],
        [3, 0],
      ],
      (f) => (f === 2 ? 'punch' : null),
    );
    expect(payloads(sendsOf(far, 2, 0), 'refused')).toEqual([{ ability: 0, why: 'range' }]);
    expect(payloads(sendsOf(far, 2, 1), 'hit')).toEqual([]);

    const behind = fightFor(
      4,
      [
        [0, 0],
        [-1, 0],
      ],
      (f) => (f === 2 ? 'punch' : null),
    );
    expect(payloads(sendsOf(behind, 2, 0), 'refused')).toEqual([{ ability: 0, why: 'facing' }]);
  });

  it('a hit knocks the victim back, away from the attacker, and fades', () => {
    const result = fightFor(
      40,
      [
        [0, 0],
        [1, 0],
      ],
      (f) => (f === 2 ? 'punch' : null),
    );
    const outputs = result.outputs ?? [];
    const victim = result.views[2].find((v) => v.player === 1)?.entity ?? 0;
    const at = (frame: number) => velocityOf(outputs[frame].commands, victim);
    expect(at(1)).toEqual({ x: 0, z: 0 });
    // The knockback goes out along +x (attacker at 0, victim at 1), in the hit's own step.
    expect(at(2)?.x).toBeCloseTo(7, 5);
    expect(Math.abs(at(2)?.z ?? 1)).toBeLessThan(1e-6);
    expect(at(39)?.x ?? 0).toBeLessThan(0.25); // under 4% of it, 37 steps on
    // The victim flashes red on the hit, for everyone (a shared material change).
    const flash = (commands: readonly Command[]) =>
      commands.find((c) => c.tag === 'set-material-param' && c.val.entity === victim);
    expect(flash(outputs[2].commands)).toBeDefined();
  });

  it('a slam hits everyone around, a dash goes the way the fighter faces', () => {
    const result = fightFor(
      6,
      [
        [0, 0],
        [-2, 0],
      ],
      (f) => (f === 2 ? 'slam' : f === 4 ? 'dash' : null),
    );
    expect(payloads<HitPayload>(sendsOf(result, 2, 1), 'hit')).toEqual([
      { by: 0, to: 1, ability: 2, damage: 20, hp: 80 },
    ]);
    const attacker = result.views[4].find((v) => v.player === 0)?.entity ?? 0;
    expect(velocityOf(result.outputs?.[4].commands ?? [], attacker)?.x).toBeCloseTo(14, 5);
  });
});

describe('knockouts and the round', () => {
  /** Seat 0 punches seat 1 every 25 steps, from step 2. */
  const everyPunch = (f: number): string | null => (f >= 2 && (f - 2) % 25 === 0 ? 'punch' : null);

  it('a knockout is told to everyone, and the fighter respawns at their spawn with full health', () => {
    // 100 health, 12 a punch: the ninth punch (step 202) knocks out.
    const result = fightFor(
      340,
      [
        [0, 0],
        [1, 0],
      ],
      everyPunch,
    );
    const koFrame = result.views.findIndex((v) => payloads(v[0]?.sends ?? [], 'ko').length > 0);
    expect(koFrame).toBe(202);
    for (const seat of [0, 1]) {
      expect(payloads(sendsOf(result, koFrame, seat), 'ko')).toEqual([{ by: 0, to: 1 }]);
    }
    // Knocked out, they cannot be hit again.
    expect(payloads(sendsOf(result, 227, 0), 'refused')).toEqual([{ ability: 0, why: 'range' }]);
    // Two seconds (120 steps, counted from the next) on, back at seat 1's spawn, teleported.
    const backFrame = result.views.findIndex(
      (v) => payloads(v[0]?.sends ?? [], 'respawn').length > 0,
    );
    expect(backFrame - koFrame).toBeGreaterThanOrEqual(120);
    expect(backFrame - koFrame).toBeLessThanOrEqual(121);
    expect(payloads(sendsOf(result, backFrame, 1), 'respawn')).toEqual([{ player: 1 }]);
    const teleport = result.outputs?.[backFrame].commands.find(
      (c) => c.tag === 'set-body-transform',
    );
    expect(teleport?.tag === 'set-body-transform' && teleport.val.position).toEqual({
      x: SPAWNS[1][0],
      y: Math.fround(SPAWNS[1][1]),
      z: SPAWNS[1][2],
    });
    expect(payloads<HitPayload>(sendsOf(result, 327, 1), 'hit')[0]?.hp).toBe(88);
  });

  it('the first to three knockouts wins the round: the room says round-over, then fighting', () => {
    // Three knockouts: nine punches each, with a 2 s respawn between.
    const result = fightFor(
      1100,
      [
        [0, 0],
        [1, 0],
      ],
      everyPunch,
    );
    const phases = (result.outputs ?? []).flatMap((o) =>
      o.commands
        .filter((c) => c.tag === 'send' && c.val.name === 'aos:phase')
        .map((c) => (c.tag === 'send' ? (JSON.parse(c.val.payload) as string) : '')),
    );
    expect(phases.slice(0, 3)).toEqual(['fighting', 'round-over', 'fighting']);
    const roundFrame = result.views.findIndex(
      (v) => payloads(v[0]?.sends ?? [], 'round').length > 0,
    );
    expect(roundFrame).toBeGreaterThan(0);
    expect(payloads(sendsOf(result, roundFrame, 1), 'round')).toEqual([{ winner: 0 }]);
  });
});
