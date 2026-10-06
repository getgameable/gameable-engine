/**
 * The page's boot decisions, without a browser: the template as shipped
 * (multiplayer off) registers its own physics and loads only `characters`;
 * the same game with `features.multiplayer` (the play-with-friends recipe)
 * registers no physics and resolves `multiplayer` to the `net` module.
 */
import { resolveFeatures, type EngineModule } from 'gameable/core';
import { createLoopbackConnection } from 'gameable/net/client';
import { chooseRoom, roomMode } from 'gameable/net/page';
import { GUEST_STATUS_PATH as ASKED_AT } from 'gameable/net/solo';
import { loopbackPair } from 'gameable/net/testing';
import { featuresOf, type GameDefinition } from 'gameable';
import { GUEST_STATUS_PATH as ANSWERED_AT } from 'gameable/vite';
import { describe, expect, it } from 'vitest';

import { name as packageName } from '../package.json';
import game from '../src/game';
import { GAME_NAME, multiplayerOn, pageFeatures, pageModules, predictOn } from '../src/session';

/** The template's game with the recipe's one edit. */
const withFriends: GameDefinition = {
  ...game,
  features: { ...game.features, multiplayer: { maxPlayers: 6 } },
};

/**
 * @param id A module id.
 * @returns A module that does nothing.
 */
const stub = (id: string): EngineModule => ({ id }) as EngineModule;

/** The module parts the page passes, with physics counted. */
function parts(): { made: string[]; physics: () => EngineModule; others: EngineModule[] } {
  const made: string[] = [];
  return {
    made,
    physics: () => {
      made.push('physics');
      return stub('physics');
    },
    others: [stub('input'), stub('audio'), stub('splat')],
  };
}

// Checked only while multiplayer is off: after the play-with-friends recipe's
// one edit the game IS the multiplayer one, which the blocks below cover.
describe.runIf(!multiplayerOn(game))('the template as shipped: multiplayer off', () => {
  it('is not multiplayer, and registers its own physics first', () => {
    expect(multiplayerOn(game)).toBe(false);
    const page = parts();
    expect(pageModules(false, page).map((m) => m.id)).toEqual([
      'physics',
      'input',
      'audio',
      'splat',
    ]);
    expect(page.made).toEqual(['physics']);
  });

  it('resolves characters only', async () => {
    const loaded = await resolveFeatures(featuresOf(game), pageFeatures());
    expect(loaded.map((feature) => feature.name)).toEqual(['characters']);
  });
});

describe('the template with features.multiplayer', () => {
  it('never makes a page physics world', () => {
    expect(multiplayerOn(withFriends)).toBe(true);
    const page = parts();
    expect(pageModules(true, page).map((m) => m.id)).toEqual(['input', 'audio', 'splat']);
    expect(page.made).toEqual([]);
  });

  it('resolves a feature table whose modules include net and no physics (Play Solo)', async () => {
    const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
    const room = await chooseRoom(roomMode(''), {
      game: GAME_NAME,
      name: 'You',
      startSolo: () => Promise.resolve({ connection }),
    });
    const loaded = await resolveFeatures(featuresOf(withFriends), pageFeatures(room.multiplayer));
    expect(loaded.map((feature) => feature.name).sort()).toEqual(['characters', 'multiplayer']);
    const ids = [
      ...pageModules(true, parts()),
      ...loaded.flatMap((feature) => feature.modules),
    ].map((m) => m.id);
    expect(ids).toContain('net');
    expect(ids).not.toContain('physics');
  });

  it("joins under the package's name without its scope", () => {
    // The package's own name, not a literal: a scaffolded game is renamed to its directory.
    expect(GAME_NAME).toBe(packageName.replace(/^@[^/]+\//, ''));
  });
});

describe('the template with features.multiplayer.predict', () => {
  const predicting: GameDefinition = {
    ...game,
    features: { ...game.features, multiplayer: { maxPlayers: 6, predict: true } },
  };

  it('predicts only when the game says so', () => {
    expect(predictOn(game)).toBe(false);
    expect(predictOn(withFriends)).toBe(false);
    expect(predictOn(predicting)).toBe(true);
  });

  it('registers its own physics world again: the level and its own body, nothing else', () => {
    const page = parts();
    expect(pageModules(true, page, true).map((m) => m.id)).toEqual([
      'physics',
      'input',
      'audio',
      'splat',
    ]);
    expect(page.made).toEqual(['physics']);
  });
});

describe("Play Solo's stale-guest check", () => {
  it('asks where the dev server answers: net/solo and the vite plugin agree on the path', () => {
    expect(ASKED_AT).toBe(ANSWERED_AT);
  });
});
