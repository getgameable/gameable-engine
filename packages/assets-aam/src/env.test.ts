import { describe, expect, it } from 'vitest';

import { createAamClient } from './client.js';
import { aamConfigFromEnv } from './env.js';

describe('aamConfigFromEnv', () => {
  it('returns null when the URL is unset, blank or the record is empty', () => {
    expect(aamConfigFromEnv({})).toBeNull();
    expect(aamConfigFromEnv({ VITE_ASSET_MANAGER_URL: '' })).toBeNull();
    expect(aamConfigFromEnv({ VITE_ASSET_MANAGER_URL: '   ' })).toBeNull();
    expect(aamConfigFromEnv({ VITE_ASSET_MANAGER_API_KEY: 'secret' })).toBeNull();
  });

  it('reads both variables and trims the trailing slash', () => {
    expect(
      aamConfigFromEnv({
        VITE_ASSET_MANAGER_URL: 'https://aam.example/ ',
        VITE_ASSET_MANAGER_API_KEY: ' secret ',
      }),
    ).toEqual({ baseUrl: 'https://aam.example', apiKey: 'secret' });
  });

  it('treats a missing key as cookie auth rather than an error', () => {
    const config = aamConfigFromEnv({ VITE_ASSET_MANAGER_URL: '/aam' });
    expect(config).toEqual({ baseUrl: '/aam', apiKey: '' });
  });

  it('ignores unrelated variables', () => {
    expect(aamConfigFromEnv({ VITE_SOMETHING_ELSE: 'x' })).toBeNull();
  });

  it('feeds createAamClient directly', () => {
    const config = aamConfigFromEnv({
      VITE_ASSET_MANAGER_URL: 'https://aam.example',
      VITE_ASSET_MANAGER_API_KEY: 'secret',
    });
    expect(config).not.toBeNull();
    const client = createAamClient({ ...config! });
    expect(client.resolveFileUrl('/api/me')).toBe('https://aam.example/api/me');
  });

  it('does not throw when called with no argument', () => {
    expect(() => aamConfigFromEnv()).not.toThrow();
  });
});
