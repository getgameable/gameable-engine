/**
 * A two-seat game hosted from its wasm guest: the room's seat count comes from
 * the game's imported definition (`roomSeats`, as Task 3.11's boot does), the
 * room refuses the third joiner, and the guest gives the two seats their
 * entities. And a held seat (joined, out of the players list) moves the host
 * and reads as neutral input, the same in direct and in wasm mode.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts room.seats
 * ```
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { Sandbox } from '@gameable/wasm-host';
import { describe, expect, it } from 'vitest';

import {
  BOUNDARY_ENABLED,
  ensureFixtureBuilt,
  FIXTURE_ASSETS,
  loadGameDefinition,
} from './harness.ts';

const MANIFEST = {
  version: 1,
  assets: FIXTURE_ASSETS.map((id) => ({ id, type: 'gltf', src: `${id}.glb` })),
};
const MS = 1000 / 60;

describe.skipIf(!BOUNDARY_ENABLED)('a two-seat wasm guest in a room', () => {
  it('seats two from the declared seats and refuses the third at the room', async () => {
    const { createEngineRoomGame, createRoom } = await import('@gameable/net/server');
    const { FakePorts } = await import('../../packages/net/src/server/room/roomTesting.ts');
    const { roomSeats } = await import('@gameable/sdk');
    const { PROTOCOL_VERSION } = await import('@gameable/net');
    const hello = (name: string): string =>
      JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });
    const { guestDir, guestEntry } = await ensureFixtureBuilt('twoSeats');
    const seats = roomSeats(await loadGameDefinition('twoSeats'));
    expect(seats).toBe(2);
    const game = await createEngineRoomGame({
      guest: {
        guestModuleUrl: pathToFileURL(guestEntry).href,
        getCoreModule: async (path) => WebAssembly.compile(await readFile(`${guestDir}/${path}`)),
      },
      manifest: MANIFEST,
      maxPlayers: seats,
      seed: 7,
    });
    expect(game.sandbox.mode).toBe('wasm');
    expect(game.maxPlayers).toBe(2);

    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, sendHz: 20 });
    room.handle('a', hello('Ana'));
    room.handle('b', hello('Ben'));
    room.handle('c', hello('Cy'));
    expect(ports.texts('c')).toEqual([{ t: 'error', code: 'full' }]);
    expect(room.players.map((p) => p.id)).toEqual([0, 1]);

    for (let i = 0; i < 3; i += 1) game.tick(i * MS);
    expect(game.entityOf(0)).not.toBe(0);
    expect(game.entityOf(1)).not.toBe(0);
    expect(game.sandbox.dead).toBe(false);
    room.close('ended');
    await game.disposed;
  });
});

describe.skipIf(!BOUNDARY_ENABLED)('a held seat, direct / wasm parity', () => {
  /**
   * Three seats join; seat 1 holds W, presses E and moves the mouse, then
   * drops for 4 frames (held: joined, out of the players list) and comes back.
   * Seat 0, the host, drops too, while seat 1 is back.
   *
   * @param sandbox The `heldHost` fixture.
   * @returns Each frame's HUD, parsed, or null when it did not change.
   */
  async function run(sandbox: Sandbox): Promise<(Record<string, unknown> | null)[]> {
    const harness = await import('@gameable/test-harness');
    sandbox.init(
      harness.createGameConfig({
        seed: 0xa05en,
        fixedHz: 60,
        options: '{"net":{"role":"authority","maxPlayers":2}}',
      }),
    );
    const inputs = [0, 1, 2].map(() => harness.createInputState());
    harness.press(inputs[1], 'KeyW');
    harness.press(inputs[1], 'KeyE');
    inputs[1].mouse.dx = 50;
    const joins = [0, 1, 2].map((player) => ({
      tag: 'player-joined' as const,
      val: { player, name: `p${String(player)}` },
    }));
    // Frames 2-5: seat 1 held; 6-7: back; 8-11: seat 0 held as well.
    const listed = (frame: number): number[] =>
      frame >= 2 && frame <= 5 ? [0, 2] : frame >= 8 ? [1, 2] : [0, 1, 2];
    const huds: (Record<string, unknown> | null)[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const players = listed(frame).map((player) => ({
        player,
        seq: frame,
        input: inputs[player],
      }));
      const out = sandbox.tick(
        harness.createFrameInput({ frame, events: frame === 0 ? joins : [], players }),
      );
      huds.push(out.hud === undefined ? null : (JSON.parse(out.hud) as Record<string, unknown>));
    }
    return huds;
  }

  it('moves the host and reads the held seat as neutral, identically in both modes', async () => {
    const { createBoundaryHost, createDirect, createWasmSandbox } = await import('./harness.ts');
    const direct = await run(await createDirect(await createBoundaryHost(), 'heldHost'));
    const wasm = await run(await createWasmSandbox(await createBoundaryHost(), 'heldHost'));
    expect(wasm).toEqual(direct);
    const last = (huds: typeof direct, upTo: number): Record<string, unknown> | null => {
      for (let f = upTo; f >= 0; f -= 1) if (huds[f] !== null) return huds[f];
      return null;
    };
    expect(last(wasm, 1)).toEqual({ host: 0, w: true, e: true, dx: 50 });
    expect(last(wasm, 5)).toEqual({ host: 0, w: false, e: false, dx: 0 }); // held: neutral
    expect(last(wasm, 7)).toEqual({ host: 0, w: true, e: true, dx: 50 }); // back
    expect(last(wasm, 11)).toEqual({ host: 1, w: true, e: true, dx: 50 }); // the host held: seat 1
  }, 600_000);
});
