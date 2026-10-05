/**
 * `docs/play.md` against the kits `build-games.mjs` hosts: every multiplayer
 * kit it finds has a card that opens a room and says how many tabs to open.
 * A kit merged without its card fails here, not on the live site.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { multiplayerKits, ROOT } from '../../packages/cli/scripts/kits.mjs';

const PLAY = readFileSync(join(ROOT, 'docs/play.md'), 'utf8');

/**
 * @param name A kit's `/play/<name>/` segment.
 * @returns Its card's HTML, or undefined.
 */
function cardOf(name) {
  return PLAY.split('<div class="gm-card">').find((card) => card.includes(`href="/play/${name}/`));
}

describe('docs/play.md', () => {
  const kits = multiplayerKits();

  it('finds kits to check', () => {
    expect(kits.length).toBeGreaterThanOrEqual(4);
  });

  it.each(kits.map((kit) => [kit.name]))('has a card for %s: a room link, its keys and its tabs', (name) => {
    const card = cardOf(name);
    expect(card, `no card links /play/${name}/`).toBeDefined();
    expect(card).toContain(`href="/play/${name}/?room=new"`);
    expect(card).toContain(`--template ${name}`);
    expect(card).toMatch(/class="gm-controls">click to play/);
    expect(card).toMatch(/tabs?/);
  });

  it('tells mystery to open three tabs: a round needs three players', () => {
    expect(cardOf('mystery')).toMatch(/3 in all/);
  });
});
