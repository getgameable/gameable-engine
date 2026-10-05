import { describe, expect, it } from 'vitest';
import type { CameraState } from '@gameable/sdk';

import { PlayerCommands, type LocalView } from './PlayerCommands';

const CAMERA = { mode: 'free' } as CameraState;

/** @returns A local view recording what reached it. */
function recordingView(): LocalView & { cameras: CameraState[]; huds: (string | undefined)[] } {
  const cameras: CameraState[] = [];
  const huds: (string | undefined)[] = [];
  return {
    cameras,
    huds,
    setCamera: (camera) => cameras.push(camera),
    setHud: (json) => huds.push(json),
  };
}

describe('PlayerCommands, the page half of the net commands', () => {
  it('shows the local player camera and HUD and drops everyone else', () => {
    const view = recordingView();
    const players = new PlayerCommands({ localPlayer: 2 }, () => undefined);
    players.show(view);
    players.setPlayerCamera(2, CAMERA);
    players.setPlayerCamera(3, CAMERA);
    players.setPlayerHud(2, '{"hp":3}');
    players.setPlayerHud(0, '{"hp":1}');
    expect(view.cameras).toEqual([CAMERA]);
    expect(view.huds).toEqual(['{"hp":3}']);
  });

  it('owns the camera and HUD from a local command until the next step', () => {
    const players = new PlayerCommands({ localPlayer: 1 }, () => undefined);
    players.show(recordingView());
    players.setPlayerCamera(4, CAMERA);
    expect(players.ownsCamera).toBe(false);
    players.setPlayerCamera(1, CAMERA);
    players.setPlayerHud(1, '{}');
    expect([players.ownsCamera, players.ownsHud]).toEqual([true, true]);
    players.beginStep();
    expect([players.ownsCamera, players.ownsHud]).toEqual([false, false]);
  });

  it('defaults to player 0, the single-player player', () => {
    const view = recordingView();
    const players = new PlayerCommands({}, () => undefined);
    players.show(view);
    players.setPlayerHud(0, '{}');
    expect(view.huds).toEqual(['{}']);
  });

  it('hands sends to the sink, and drops them without one', () => {
    const sent: unknown[] = [];
    const players = new PlayerCommands({ send: (...args) => sent.push(args) }, () => undefined);
    players.methods.send(undefined, 'vote', '{"for":1}', true);
    expect(sent).toEqual([[undefined, 'vote', '{"for":1}', true]]);
    expect(() => {
      new PlayerCommands({}, () => undefined).send(1, 'x', '{}', false);
    }).not.toThrow();
  });

  it('warns that the page has no store, keyed so the adapter says it once', () => {
    const keys: string[] = [];
    const players = new PlayerCommands({}, (key) => keys.push(key));
    players.methods.savePlayerData(1, '{}');
    players.methods.saveGameData('{}');
    players.methods.exchange({ id: 1, a: 1, b: 2, give: '{}', take: '{}' });
    players.methods.savePlayerData(1, '{}');
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => k.includes('no store on the page'))).toBe(true);
  });
});
