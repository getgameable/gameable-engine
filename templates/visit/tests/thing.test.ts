/** A thing's page (the studio's create-anything): the lookup's `thing` read, and the camera that frames it. */
import { describe, expect, it } from 'vitest';

import { readVisit } from '../src/visit';
import { thingFraming } from '../src/thing';

const PAGE = 'https://cc.example/play/visit/';

describe('a thing instead of a character', () => {
  it('reads the lookup document: its points, colour space and size; no character, no greeting', () => {
    const c = readVisit(PAGE, '/', {
      name: 'Road Car',
      character: null,
      greeting: '',
      thing: {
        splat: '/companion/public/acme/road_car/files/7/thing.ply',
        colorSpace: 'srgb',
        sizeM: 4.15,
        heightM: 2.25,
      },
    });
    expect(c.thing).toEqual({
      splat: 'https://cc.example/companion/public/acme/road_car/files/7/thing.ply',
      colorSpace: 'srgb',
      sizeM: 4.15,
      heightM: 2.25,
    });
    expect(c.character).toBeNull();
    expect(c.greeting).toBe('');
  });

  it('refuses a thing on another site, and has none when the document names none', () => {
    expect(
      readVisit(PAGE, '/', { thing: { splat: 'https://evil.example/t.ply' } }).thing,
    ).toBeNull();
    expect(readVisit(PAGE).thing).toBeNull();
    expect(readVisit(`${PAGE}?thing=/x/thing.ply&thingSize=0.15`).thing).toMatchObject({
      sizeM: 0.15,
      heightM: null,
    });
  });

  it('frames a long thing by its length and a tall one by its height', () => {
    const car = thingFraming({ sizeM: 4.3, heightM: 1.4 }, 45, 16 / 9);
    const tree = thingFraming({ sizeM: 15, heightM: 15 }, 45, 16 / 9);
    const cup = thingFraming({ sizeM: 0.15, heightM: 0.08 }, 45, 16 / 9);
    expect(car.target[1]).toBeCloseTo(0.7);
    expect(tree.distance).toBeGreaterThan(car.distance);
    expect(cup.distance).toBeLessThan(1);
    expect(cup.distance).toBeGreaterThan(0.1);
  });
});
