import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

const page = 'https://cc.example/play/wasm-hello/';

describe('page configuration', () => {
  it('defaults to the bundled greeter and the hello relay', () => {
    expect(readConfig(page, '/play/wasm-hello/')).toEqual({
      character: 'https://cc.example/play/wasm-hello/characters/greeter/character.json',
      talk: 'https://cc.example/services/hello/',
      id: 'greeter',
      name: 'Gameable guide',
    });
  });
  it('takes a published character and its relay from the query', () => {
    const config = readConfig(
      `${page}?character=/companion/public/acme/nova/files/character.json&talk=/companion/public/acme/nova&id=Nova_2&name=Nova`,
      '/play/wasm-hello/',
    );
    expect(config).toEqual({
      character: 'https://cc.example/companion/public/acme/nova/files/character.json',
      talk: 'https://cc.example/companion/public/acme/nova/',
      id: 'Nova_2',
      name: 'Nova',
    });
  });
  it('refuses other origins and odd ids', () => {
    const config = readConfig(
      `${page}?character=https://evil.example/c.json&talk=//evil.example/&id=../x`,
      '/',
    );
    expect(config.character).toBe('https://cc.example/characters/greeter/character.json');
    expect(config.talk).toBe('https://cc.example/services/hello/');
    expect(config.id).toBe('greeter');
  });
});
