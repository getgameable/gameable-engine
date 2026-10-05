/** The input contract: what the exporter's parameters and the publish lookup's JSON become. */
import { describe, expect, it } from 'vitest';

import { applyBadge, loadPlan, placeTransform, readVisit, wantsLite } from '../src/visit';

const PAGE = 'https://cc.example/play/visit/';

describe('readVisit', () => {
  it('takes the hello world parameters the published page already sends', () => {
    const c = readVisit(
      `${PAGE}?character=/companion/public/acme/nova/files/v3/character.json&talk=/companion/public/acme/nova/&id=Nova_2&name=Nova`,
    );
    expect(c.character).toBe(
      'https://cc.example/companion/public/acme/nova/files/v3/character.json',
    );
    expect(c.talk).toBe('https://cc.example/companion/public/acme/nova/');
    expect(c.id).toBe('Nova_2');
    expect(c.name).toBe('Nova');
    expect(c.setting).toBeNull();
    expect(c.mode).toBe('chat');
    expect(c.view).toBe('half');
  });

  it('refuses addresses on another site, and falls back to the sample and the local relay', () => {
    const c = readVisit(
      `${PAGE}?character=https://evil.example/c.json&talk=//evil.example/&id=../x`,
    );
    expect(c.character).toBeNull();
    expect(c.talk).toBe('https://cc.example/services/visit/');
    expect(c.id).toBe('greeter');
    expect(c.name).toBe('Your character');
  });

  it('accepts the studio own names for modes and views', () => {
    expect(readVisit(`${PAGE}?mode=companion&view=tight`)).toMatchObject({
      mode: 'chat',
      view: 'portrait',
    });
    expect(readVisit(`${PAGE}?mode=hangout&view=wide`)).toMatchObject({
      mode: 'hangout',
      view: 'body',
    });
    expect(readVisit(`${PAGE}?mode=show&view=medium`)).toMatchObject({
      mode: 'show',
      view: 'half',
    });
    expect(readVisit(`${PAGE}?mode=anything&view=room`)).toMatchObject({
      mode: 'chat',
      view: 'room',
    });
  });

  it('reads a place from parameters, with the studio base and placement', () => {
    const c = readVisit(
      `${PAGE}?place=/env/p/world.spz&collider=/env/p/collider.glb&pano=/env/p/pano.png&placeBase=0.7466,-0.6713,1&placeAt=1,0.1,90,0.5,-1`,
    );
    expect(c.setting).toMatchObject({
      splat: 'https://cc.example/env/p/world.spz',
      collider: 'https://cc.example/env/p/collider.glb',
      pano: 'https://cc.example/env/p/pano.png',
      lite: null,
      colorSpace: 'srgb',
      base: { scale: 0.7466, floor: -0.6713, flip: true },
      placement: { scale: 1, height: 0.1, turn: 90, x: 0.5, z: -1 },
    });
  });

  it('reads the publish lookup JSON, and a parameter wins over the same field', () => {
    const doc = {
      name: 'Nova',
      id: 'nova',
      character: '/c/nova/character.json',
      level: '/c/nova/level/character.json',
      talk: '/companion/public/acme/nova/',
      greeting: '  Hey!\n  Welcome in.  ',
      mode: 'show',
      view: 'portrait',
      setting: {
        splat: '/env/p/world.spz',
        lite: '/env/p/world_500k.spz',
        base: { scale: 0.5, floor: -1, flip: false },
        placement: { scale: 20, turn: 45 },
      },
    };
    const c = readVisit(`${PAGE}?mode=hangout`, '/', doc);
    expect(c).toMatchObject({
      name: 'Nova',
      id: 'nova',
      level: 'https://cc.example/c/nova/level/character.json',
      greeting: 'Hey! Welcome in.',
      mode: 'hangout',
      view: 'portrait',
    });
    expect(c.setting?.lite).toBe('https://cc.example/env/p/world_500k.spz');
    expect(c.setting?.base).toEqual({ scale: 0.5, floor: -1, flip: false });
    // Placement is held to the studio's limits.
    expect(c.setting?.placement).toEqual({ scale: 10, height: 0, turn: 45, x: 0, z: 0 });
  });

  it('takes a bundled folder name for the character, as the hello world does', () => {
    expect(readVisit(`${PAGE}?character=nova_cc`, '/play/visit/').character).toBe(
      'https://cc.example/play/visit/characters/nova_cc/character.json',
    );
  });
});

describe('placeTransform', () => {
  it('stands a turned-over place with its floor on the character floor, as the studio does', () => {
    const t = placeTransform({
      base: { scale: 0.7466, floor: -0.6713, flip: true },
      placement: { scale: 1, height: 0, turn: 0, x: 0, z: 0 },
    });
    expect(t.position[1]).toBeCloseTo(0.6713, 6);
    expect(t.scale).toBeCloseTo(0.7466, 6);
    expect(t.quaternion).toEqual([1, 0, -0, 0]);
  });

  it('turns about the vertical and scales with the owner placement', () => {
    const t = placeTransform({
      base: { scale: 2, floor: -1, flip: false },
      placement: { scale: 0.5, height: 0.2, turn: 180, x: 1, z: -2 },
    });
    expect(t.position).toEqual([1, 0.7, -2]);
    expect(t.scale).toBe(1);
    expect(t.quaternion[1]).toBeCloseTo(1, 6);
  });
});

describe('wantsLite', () => {
  it('gives a phone the lighter load and lets ?lite= decide', () => {
    expect(wantsLite(null, { coarse: true, shortSide: 390, memoryGb: 8 })).toBe(true);
    expect(wantsLite(null, { coarse: false, shortSide: 800, memoryGb: 4 })).toBe(true);
    expect(wantsLite(null, { coarse: false, shortSide: 800, memoryGb: 16 })).toBe(false);
    expect(wantsLite(false, { coarse: true, shortSide: 390, memoryGb: 2 })).toBe(false);
    expect(wantsLite(true, { coarse: false, shortSide: 1400, memoryGb: 32 })).toBe(true);
  });
});

describe('loadPlan', () => {
  const doc = {
    character: '/companion/public/acme/nova/files/9/character.json',
    level: '/companion/public/acme/nova/files/l512-9/character.json',
    packages: { full: { bytes: 86716008 }, level: { bytes: 58508102 } },
  };
  const full = 'https://cc.example/companion/public/acme/nova/files/9/character.json';
  const light = 'https://cc.example/companion/public/acme/nova/files/l512-9/character.json';

  it('gives a phone the lighter copy alone and a computer the lighter copy first, then the full one', () => {
    const c = readVisit(PAGE, '/', doc);
    expect(c.sizes).toEqual({ character: 86716008, level: 58508102 });
    expect(loadPlan(c, true)).toEqual({ first: light, then: null, firstBytes: 58508102 });
    expect(loadPlan(c, false)).toEqual({ first: light, then: full, firstBytes: 58508102 });
  });

  it('loads the full copy alone when there is no lighter one', () => {
    const alone = readVisit(PAGE, '/', { ...doc, level: null, packages: {} });
    expect(alone.sizes).toEqual({ character: null, level: null });
    expect(loadPlan(alone, false)).toEqual({ first: full, then: null, firstBytes: null });
    expect(loadPlan(alone, true)).toEqual({ first: full, then: null, firstBytes: null });
  });
});

describe("the page's credit, from the lookup's badge", () => {
  const lookup = (badge: unknown) => readVisit(PAGE, '/', { name: 'Nova', badge }).badge;

  it('reads its words and link, and shows it unless show is false', () => {
    expect(
      lookup({
        show: true,
        href: 'https://app.gameable.com/?ref=acme/nova',
        text: 'I made this with Gameable',
      }),
    ).toEqual({
      show: true,
      href: 'https://app.gameable.com/?ref=acme/nova',
      text: 'I made this with Gameable',
    });
    expect(lookup({ show: false, href: 'https://app.gameable.com/', text: 'x' })?.show).toBe(false);
    expect(lookup({ href: 'https://app.gameable.com/' })).toEqual({
      show: true,
      href: 'https://app.gameable.com/',
      text: 'I made this with Gameable',
    });
  });

  it('is null without a badge or with a link that is not http(s): the page keeps its own chip', () => {
    expect(lookup(undefined)).toBeNull();
    expect(readVisit(PAGE).badge).toBeNull();
    expect(lookup({ show: true, href: 'javascript:alert(1)', text: 'x' })).toBeNull();
    expect(lookup({ show: true, text: 'x' })).toBeNull();
  });

  it('draws it on the chip: new tab and noopener; hidden when show is false; unchanged without one', () => {
    const chip = () => ({
      link: {
        href: 'https://engine.gameable.com/',
        target: '_blank',
        rel: 'noreferrer',
        hidden: false,
      },
      label: { textContent: 'Made with Gameable' as string | null },
    });
    const shown = chip();
    applyBadge(shown, {
      show: true,
      href: 'https://app.gameable.com/?ref=acme/nova',
      text: 'I made this with Gameable',
    });
    expect(shown.link).toEqual({
      href: 'https://app.gameable.com/?ref=acme/nova',
      target: '_blank',
      rel: 'noopener',
      hidden: false,
    });
    expect(shown.label.textContent).toBe('I made this with Gameable');
    const hidden = chip();
    applyBadge(hidden, { show: false, href: 'https://app.gameable.com/', text: 'x' });
    expect(hidden.link.hidden).toBe(true);
    const old = chip();
    applyBadge(old, null);
    expect(old).toEqual(chip());
  });
});
