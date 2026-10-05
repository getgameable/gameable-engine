import { describe, expect, it } from 'vitest';
import { defineGame } from './defineGame';
import { featuresOf } from './features';

describe('featuresOf', () => {
  it('returns an empty table for a game that declares nothing', () => {
    expect(featuresOf(defineGame({}))).toEqual({});
  });
  it('turns `true` into an empty options object and drops `false`', () => {
    const f = featuresOf(defineGame({ features: { characters: true, multiplayer: false } }));
    expect(f).toEqual({ characters: {} });
  });
  it('keeps an options object as given', () => {
    const f = featuresOf(defineGame({ features: { multiplayer: { maxPlayers: 8, sendHz: 20 } } }));
    expect(f).toEqual({ multiplayer: { maxPlayers: 8, sendHz: 20 } });
  });
  it('is frozen', () => {
    const f = featuresOf(defineGame({ features: { characters: true } }));
    expect(Object.isFrozen(f)).toBe(true);
  });
});
