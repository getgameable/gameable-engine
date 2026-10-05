import { describe, expect, it } from 'vitest';

import { createOriginPolicy } from './origins.js';

describe('OriginPolicy', () => {
  it('allows exactly the listed origins', () => {
    const policy = createOriginPolicy(['https://play.example', 'http://localhost:5173']);
    expect(policy.allows('https://play.example')).toBe(true);
    expect(policy.allows('http://localhost:5173')).toBe(true);
    expect(policy.allows('https://evil.example')).toBe(false);
    expect(policy.allows('http://play.example')).toBe(false); // the scheme counts
    expect(policy.allows('https://play.example:8443')).toBe(false); // so does the port
    expect(policy.allows('https://play.example.evil.example')).toBe(false);
  });

  it('refuses a request with no Origin (or the opaque "null")', () => {
    const policy = createOriginPolicy(['https://play.example']);
    expect(policy.allows(undefined)).toBe(false);
    expect(policy.allows(null)).toBe(false);
    expect(policy.allows('')).toBe(false);
    expect(policy.allows('null')).toBe(false);
  });

  it('matches without case and without a trailing slash', () => {
    const policy = createOriginPolicy(['https://Play.Example/']);
    expect(policy.allows('https://play.example')).toBe(true);
    expect(policy.allows('HTTPS://PLAY.EXAMPLE')).toBe(true);
  });

  it('takes host:* for any port on that scheme and host', () => {
    const policy = createOriginPolicy(['http://localhost:*']);
    expect(policy.allows('http://localhost:5173')).toBe(true);
    expect(policy.allows('http://localhost')).toBe(true);
    expect(policy.allows('https://localhost:5173')).toBe(false);
    expect(policy.allows('http://localhost.evil.example:5173')).toBe(false);
  });

  it('refuses a list entry that is not an origin', () => {
    expect(() => createOriginPolicy(['*'])).toThrow(/not an origin/);
    expect(() => createOriginPolicy(['https://a.example/path'])).toThrow(/not an origin/);
    expect(() => createOriginPolicy(['play.example'])).toThrow(/not an origin/);
  });
});
