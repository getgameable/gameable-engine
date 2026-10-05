/**
 * The `net` module's page wiring: it does not join on init, it lets go of
 * the keys the moment the page goes away, and it watches the link each step.
 */
import { describe, expect, it } from 'vitest';

import { blankInput } from '../server/room/roomTesting.js';
import { multiplayer, type NetModule } from './module.js';
import { createInputCodec } from '../protocol/InputCodec.js';
import { FakeConnection } from './scriptedNet.js';

/** A window or document stand-in: listeners by event type. */
class Target {
  visibilityState = 'visible';
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** @returns The loaded net module on a fake connection, with fake page targets. */
async function page() {
  const connection = new FakeConnection();
  const window = new Target();
  const document = new Target();
  const feature = await multiplayer({ connection, away: { window, document } });
  const module = feature.modules[0] as NetModule;
  const net = module.init();
  return { connection, window, document, module, net };
}

/** @param connection The fake. Welcome the page. */
function welcome(connection: FakeConnection): void {
  connection.text({
    t: 'welcome',
    player: 0,
    entity: 0,
    secret: 's',
    frame: 1,
    snapshot: { frame: 1, entities: [] },
    players: [],
  });
}

/**
 * @param bytes An INPUT frame.
 * @returns Whether it says focused.
 */
function focused(bytes: Uint8Array): boolean {
  const into = blankInput();
  createInputCodec().decode(bytes, into);
  return into.focused;
}

describe('the net module', () => {
  it('does not join on init: the client loop starts the join once it is attached', async () => {
    const { connection, net } = await page();
    expect(connection.state).toBe('idle');
    net.start();
    expect(connection.state).toBe('connecting');
  });

  it('sends a neutral input at once when the tab is hidden, the window blurs, or the page hides', async () => {
    const { connection, window, document, net } = await page();
    net.start();
    welcome(connection);
    document.fire('visibilitychange'); // still visible: nothing
    expect(connection.inputs).toHaveLength(0);
    document.visibilityState = 'hidden';
    document.fire('visibilitychange');
    window.fire('blur');
    window.fire('pagehide');
    expect(connection.inputs).toHaveLength(3);
    expect(connection.inputs.map(focused)).toEqual([false, false, false]);
  });

  it('removes its listeners on dispose', async () => {
    const { window, document, module } = await page();
    expect(window.count() + document.count()).toBe(3);
    module.dispose();
    expect(window.count() + document.count()).toBe(0);
  });

  it('watches the link each fixed step: 2 s of silence reconnects', async () => {
    const { connection, module, net } = await page();
    net.start();
    welcome(connection);
    connection.state = 'open';
    for (let i = 0; i < 125; i += 1) module.fixedUpdate(1 / 60);
    expect(connection.reconnects).toEqual(['silent']);
  });
});
