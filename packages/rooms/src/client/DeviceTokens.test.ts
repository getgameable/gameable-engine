import { describe, expect, it } from 'vitest';

import { DeviceTokens } from './DeviceTokens.js';
import type { SeatStorage } from './SeatTokens.js';

const TOKEN = `device.${'a'.repeat(22)}.${'b'.repeat(43)}`;

/** A Web Storage stand-in. */
class Memory implements SeatStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** Storage that throws on every call, as a blocked one does. */
const BLOCKED: SeatStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('DeviceTokens', () => {
  it("keeps the token under aos.identity.<the room server's origin>", () => {
    const storage = new Memory();
    const tokens = new DeviceTokens('wss://play.example/services/rooms/', storage);
    expect(tokens.key).toBe('aos.identity.https://play.example');
    expect(tokens.load()).toBeNull();
    tokens.save(TOKEN);
    expect(storage.items.get('aos.identity.https://play.example')).toBe(TOKEN);
    expect(new DeviceTokens('https://play.example/other/', storage).load()).toBe(TOKEN);
    expect(new DeviceTokens('ws://127.0.0.1:8790', storage).key).toBe(
      'aos.identity.http://127.0.0.1:8790',
    );
  });

  it('keeps only what looks like a device token', () => {
    const storage = new Memory();
    const tokens = new DeviceTokens('wss://play.example/', storage);
    tokens.save('junk');
    expect(tokens.load()).toBeNull();
    storage.items.set(tokens.key, 'tampered');
    expect(tokens.load()).toBeNull();
  });

  it('a blocked or missing storage keeps nothing and never throws', () => {
    const blocked = new DeviceTokens('wss://play.example/', BLOCKED);
    expect(() => {
      blocked.save(TOKEN);
    }).not.toThrow();
    expect(blocked.load()).toBeNull();
    const none = new DeviceTokens('wss://play.example/', null);
    none.save(TOKEN);
    expect(none.load()).toBeNull();
  });
});
