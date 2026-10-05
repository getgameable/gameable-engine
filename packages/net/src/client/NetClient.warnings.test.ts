/**
 * Task 4.2 follow-up: an `error` frame that does not end the session
 * (`budget` sent as a warning while the page stays seated) is a warning,
 * not a close reason; a real close still sets `closeReason`.
 */
import { describe, expect, it } from 'vitest';

import { createNetClient } from './NetClient.js';
import { FakeConnection } from './scriptedNet.js';

const WELCOME = {
  t: 'welcome',
  player: 0,
  entity: 0,
  secret: 's',
  frame: 1,
  snapshot: { frame: 1, entities: [] },
  players: [],
};

/** @returns A started, welcomed client on a fake connection. */
function client(): { net: ReturnType<typeof createNetClient>; connection: FakeConnection } {
  const connection = new FakeConnection();
  const net = createNetClient(connection, { name: 'Ana' });
  net.start();
  connection.text(WELCOME);
  return { net, connection };
}

describe('NetClient: warnings are not close reasons', () => {
  it('a budget error while open is a warning: closeReason stays empty', () => {
    const { net, connection } = client();
    let heard = 0;
    net.onChange(() => (heard += 1));
    connection.text({ t: 'error', code: 'budget' });
    connection.text({ t: 'error', code: 'budget' });
    expect(net.closeReason).toBe('');
    expect(net.lastWarning).toBe('budget');
    expect(net.stats.warnings).toBe(2);
    expect(heard).toBe(1); // listeners hear the warning once
  });

  it('a later close still sets closeReason from the close, not the old warning', () => {
    const { net, connection } = client();
    connection.text({ t: 'error', code: 'budget' });
    connection.events?.onState('closed', 'lost');
    expect(net.state).toBe('closed');
    expect(net.closeReason).toBe('lost');
  });

  it('an error that ends the session still sets closeReason', () => {
    const { net, connection } = client();
    connection.text({ t: 'error', code: 'ended', detail: 'crashed' });
    connection.events?.onState('closed', 'ended');
    expect(net.closeReason).toBe('ended: crashed');
    expect(net.lastWarning).toBe('');
    expect(net.stats.warnings).toBe(0);
  });
});
