import { describe, expect, it, vi } from 'vitest';

// Counts every load of ws and lets the real module through.
const wsLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('ws', async (importOriginal) => {
  wsLoads.count += 1;
  return importOriginal();
});

describe('the import graph of the net package', () => {
  it('loads no ws from any entry: the package opens no sockets (phase 3 review M1)', async () => {
    const root = await import('./index.js');
    const client = await import('./client/index.js');
    const testing = await import('./testing/index.js');
    const solo = await import('./solo/index.js');
    const server = await import('./server/index.js');
    expect(typeof root.BaseTransport).toBe('function');
    expect(typeof client.createLoopbackConnection).toBe('function');
    expect(typeof testing.loopbackPair).toBe('function');
    expect(typeof solo.createInPageAuthority).toBe('function');
    expect(typeof server.createRoom).toBe('function');
    expect(wsLoads.count).toBe(0);
  }, 30_000); // a cold import of five entries' graphs: over 5 s in a loaded full run (3.11a fix round)

  it('counts a ws load when one happens (positive control for the zero above)', async () => {
    // Without this, a mock that never counts would make the zero meaningless. ws is no
    // dependency of this package any more; the workspace still installs it (Colyseus's transport).
    const { WebSocketServer } = await import('ws');
    expect(typeof WebSocketServer).toBe('function');
    expect(wsLoads.count).toBeGreaterThan(0);
  });
});
