/**
 * Task 4.2 follow-up: only an `error` that refuses or ends the session stops
 * `LoopbackConnection` from reconnecting. A `budget` warning while seated is
 * not a refusal, so a later drop still reconnects; the room dropping the page
 * for abuse (the close reason `budget`) still ends it.
 */
import { describe, expect, it } from 'vitest';

import type { Transport } from '../transport/Transport.js';
import { loopbackPair } from '../transport/index.js';
import { flush } from './clientTesting.js';
import { createLoopbackConnection } from './LoopbackConnection.js';
import type { ConnectionState } from './RoomConnection.js';

const WELCOME = JSON.stringify({
  t: 'welcome',
  player: 0,
  entity: 0,
  secret: 's',
  frame: 1,
  snapshot: { frame: 1, entities: [] },
  players: [],
});

/** @returns A connection whose server ends the test holds, one per transport it opens. */
function setup(): {
  connection: ReturnType<typeof createLoopbackConnection>;
  servers: Transport[];
  states: [ConnectionState, string][];
} {
  const servers: Transport[] = [];
  const states: [ConnectionState, string][] = [];
  const connection = createLoopbackConnection({
    connect: () => {
      const [client, server] = loopbackPair();
      servers.push(server);
      return client;
    },
    backoff: { baseMs: 1 },
  });
  connection.join(
    { name: 'Ana' },
    { onText: () => undefined, onRows: () => undefined, onState: (s, r) => states.push([s, r]) },
  );
  return { connection, servers, states };
}

describe('LoopbackConnection: a warning is not a refusal', () => {
  it('a budget warning, then a drop: it still reconnects', async () => {
    const { connection, servers, states } = setup();
    servers[0].send(WELCOME);
    await flush();
    expect(connection.state).toBe('open');
    servers[0].send('{"t":"error","code":"budget"}');
    await flush();
    expect(connection.state).toBe('open');
    servers[0].close('lost');
    await flush(20);
    expect(states).toContainEqual(['reconnecting', 'lost']);
    expect(servers).toHaveLength(2); // a second transport was opened
    connection.leave();
  });

  it('dropped by the room for abuse (close reason budget): closed for good', async () => {
    const { connection, servers, states } = setup();
    servers[0].send(WELCOME);
    servers[0].send('{"t":"error","code":"budget"}');
    servers[0].close('budget');
    await flush(20);
    expect(connection.state).toBe('closed');
    expect(states.at(-1)).toEqual(['closed', 'budget']);
    expect(servers).toHaveLength(1);
  });

  it('a refusal (error: full, then a close) still closes for good with the error as the reason', async () => {
    const { connection, servers, states } = setup();
    servers[0].send('{"t":"error","code":"full"}');
    servers[0].close('full-ish');
    await flush(20);
    expect(connection.state).toBe('closed');
    expect(states.at(-1)).toEqual(['closed', 'full']);
    expect(servers).toHaveLength(1);
  });
});
