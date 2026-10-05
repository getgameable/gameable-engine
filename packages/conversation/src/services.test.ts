import { describe, expect, it } from 'vitest';

import { GAMEABLE_CONVERSATION_URL, GAMEABLE_TRANSCRIPTION_URL, servicesFromEnv } from './services';

describe('servicesFromEnv', () => {
  it('opens both hosted services with the one Gameable API key', () => {
    expect(servicesFromEnv({ GAMEABLE_API_KEY: 'k' })).toEqual({
      convorcherUrl: GAMEABLE_CONVERSATION_URL,
      convorcherKey: 'k',
      parlayUrl: GAMEABLE_TRANSCRIPTION_URL,
      parlayKey: 'k',
    });
  });

  it('is undefined without a key', () => {
    expect(servicesFromEnv({})).toBeUndefined();
    expect(servicesFromEnv({ GAMEABLE_API_KEY: '  ' })).toBeUndefined();
  });

  it('lets each service point elsewhere with its own key', () => {
    const services = servicesFromEnv({
      GAMEABLE_API_KEY: 'k',
      GAMEABLE_CONVERSATION_URL: 'https://talk.example',
      GAMEABLE_TRANSCRIPTION_KEY: 't',
    });
    expect(services?.convorcherUrl).toBe('https://talk.example');
    expect(services?.convorcherKey).toBe('k');
    expect(services?.parlayKey).toBe('t');
  });

  it('still reads the older per-service names', () => {
    expect(
      servicesFromEnv({
        CONVORCHER_URL: 'https://c.example',
        CONVORCHER_KEY: 'c',
        PARLAY_URL: 'wss://p.example/ws',
        PARLAY_KEY: 'p',
      }),
    ).toEqual({
      convorcherUrl: 'https://c.example',
      convorcherKey: 'c',
      parlayUrl: 'wss://p.example/ws',
      parlayKey: 'p',
    });
  });
});
