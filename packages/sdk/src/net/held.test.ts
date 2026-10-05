import { describe, expect, it } from 'vitest';

import { hold, stubInput } from '../testing';
import { joined, rig, roomFrame } from './netTesting';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('a held seat', () => {
  it('reads as neutral input while the room holds it: no repeated press, no held key, no mouse', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    const busy = stubInput();
    hold(busy, 'KeyE');
    hold(busy, 'KeyW');
    busy.mouse.dx = 50;
    busy.mouse.dy = -20;
    guest.tick(
      roomFrame(
        0,
        [joined(0), joined(1)],
        [
          { player: 0, seq: 0, input: stubInput() },
          { player: 1, seq: 0, input: busy },
        ],
      ),
    );
    const seat = () => ctx().players.get(1);
    expect(seat()?.input.pressed('KeyE')).toBe(true);

    // Seat 1 dropped: held (no player-left), left out of the players list.
    for (let f = 1; f <= 3; f += 1) {
      guest.tick(roomFrame(f, [], [{ player: 0, seq: f, input: stubInput() }]));
      expect(seat()?.connected).toBe(true);
      expect(seat()?.input.pressed('KeyE')).toBe(false);
      expect(seat()?.input.isDown('KeyW')).toBe(false);
      expect(seat()?.input.mouse.dx).toBe(0);
      expect(seat()?.input.mouse.dy).toBe(0);
    }
  });
});
