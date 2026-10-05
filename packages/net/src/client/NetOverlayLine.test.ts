/**
 * The debug overlay's `net` lines: what they show, the rows rate, and the
 * `multiplayer()` bind that puts them on an engine's overlay.
 */
import { createDebugOverlay, type DebugOverlay } from '@gameable/core';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createLoopbackConnection } from './LoopbackConnection.js';
import { multiplayer } from './module.js';
import type { NetService, NetStats } from './NetService.js';
import { createNetOverlayLine, showNetOnOverlay } from './NetOverlayLine.js';
import { loopbackPair } from '../transport/LoopbackTransport.js';

/** A mutable stand-in for the service, with only what the line reads. */
type FakeNet = {
  -readonly [K in keyof NetService]: NetService[K];
} & { stats: NetStats };

/** @returns A joined service: room KQTX, two of three players connected, seat 0 on entity 12. */
function fakeNet(): FakeNet {
  return {
    state: 'joined',
    room: 'KQTX',
    localPlayer: 0,
    localEntity: 12,
    maxPlayers: 6,
    rtt: 33.6,
    players: [
      { id: 0, name: 'Ana', connected: true },
      { id: 1, name: 'Bo', connected: true },
      { id: 2, name: 'Cy', connected: false },
    ],
    stats: {
      staleRows: 3,
      rowsFrames: 100,
      commandFrames: 0,
      messages: 0,
      badFrames: 0,
      inputsSent: 0,
      corrections: 0,
    },
  } as unknown as FakeNet;
}

describe('NetOverlayLine', () => {
  it('shows state, room, connected players, rtt, stale rows and your entity', () => {
    const line = createNetOverlayLine(fakeNet(), () => 0);
    expect(line.text()).toBe(
      'net    joined KQTX  players 2/6  rtt 34 ms\n' +
        '       rows 0/s  stale 3  corrections 0  you entity 12, seat 0',
    );
  });

  it("shows how often a predicting page's own body was corrected", () => {
    const net = fakeNet();
    net.stats.corrections = 2;
    expect(createNetOverlayLine(net, () => 0).text()).toContain(
      'stale 3  corrections 2  you entity 12',
    );
  });

  it('measures rows per second between two redraws', () => {
    const net = fakeNet();
    let now = 0;
    const line = createNetOverlayLine(net, () => now);
    now = 250;
    net.stats.rowsFrames += 5;
    expect(line.text()).toContain('rows 20/s');
    now = 500;
    expect(line.text()).toContain('rows 0/s');
  });

  it('keeps the last rate when two redraws share a timestamp', () => {
    const net = fakeNet();
    let now = 0;
    const line = createNetOverlayLine(net, () => now);
    now = 500;
    net.stats.rowsFrames += 10;
    line.text();
    expect(line.text()).toContain('rows 20/s');
  });

  it('says so before the welcome: no room, no seat, no entity', () => {
    const net = fakeNet();
    net.state = 'connecting';
    net.room = null;
    net.localPlayer = -1;
    net.localEntity = 0;
    net.players = [];
    const text = createNetOverlayLine(net, () => 0).text();
    expect(text).toContain('net    connecting ----  players 0/6');
    expect(text).toContain('you no entity, no seat');
  });
});

/** A renderer stub exposing only the counters the overlay reads. */
const renderer = { info: { render: { calls: 0, triangles: 0 } } } as unknown as WebGPURenderer;

/**
 * @returns An overlay with no DOM whose `setExtra` calls are recorded.
 */
function recordingOverlay(): { overlay: DebugOverlay; sources: ((() => string) | null)[] } {
  const overlay = createDebugOverlay({ renderer, backendName: 'webgpu' });
  const sources: ((() => string) | null)[] = [];
  const setExtra = overlay.setExtra.bind(overlay);
  overlay.setExtra = (source) => {
    sources.push(source);
    setExtra(source);
  };
  return { overlay, sources };
}

describe('showNetOnOverlay', () => {
  it('adds the net lines to an engine that has an overlay', () => {
    const { overlay, sources } = recordingOverlay();
    expect(showNetOnOverlay({ overlay }, fakeNet())).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.()).toContain('net    joined KQTX');
    overlay.dispose();
  });

  it('does nothing on an engine without one (debug off, or headless)', () => {
    expect(showNetOnOverlay({ overlay: null }, fakeNet())).toBe(false);
    expect(showNetOnOverlay({}, fakeNet())).toBe(false);
  });

  it("is what multiplayer()'s bind does", async () => {
    const { overlay, sources } = recordingOverlay();
    const loaded = await multiplayer({
      connection: createLoopbackConnection({ connect: () => loopbackPair()[0] }),
    });
    const net = await loaded.bind?.({ overlay } as never);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.()).toContain('net    connecting');
    expect(net).toBeDefined();
    overlay.dispose();
  });
});
