/**
 * `leaveRoom`: a page whose boot failed gives up its seat at once.
 */
import { describe, expect, it } from 'vitest';

import { leaveRoom } from './leaveRoom.js';

describe('leaveRoom', () => {
  it("leaves through the engine's net service, with the reason", () => {
    const left: string[] = [];
    const net = { leave: (reason?: string) => left.push(reason ?? '') };
    const engine = { modules: { tryGet: (id: string) => (id === 'net' ? net : undefined) } };
    expect(leaveRoom(engine)).toBe(true);
    expect(left).toEqual(['crashed']);
  });

  it('does nothing before the engine exists, or on a page with no room', () => {
    expect(leaveRoom(null)).toBe(false);
    expect(leaveRoom({ modules: { tryGet: () => undefined } })).toBe(false);
  });
});
