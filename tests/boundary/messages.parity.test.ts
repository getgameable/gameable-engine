/**
 * `defineMessage` is the same program in direct mode and in wasm mode: the
 * same votes are dropped and counted, the same tallies go out, and every
 * player is shown the same view, frame for frame.
 *
 * The `votes` fixture is the two-seat tiny game plus a `vote` definition
 * (a whole seat number, at most 32 bytes) that the authority answers with a
 * broadcast `tally` and the voter's own HUD of `dropped` and `received`.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts messages.parity
 * ```
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  BOUNDARY_ENABLED,
  createBoundaryHost,
  createDirect,
  createWasmSandbox,
} from './harness.ts';
import type { Sandbox } from '@gameable/wasm-host';

/** How many frames the tape runs. */
const FRAMES = 120;

/** `game-config.options` a two-seat room's authority boots with. */
const TWO_SEATS = '{"net":{"role":"authority","maxPlayers":1}}';

describe.skipIf(!BOUNDARY_ENABLED)('direct / wasm parity, validated messages', () => {
  type Harness = typeof import('@gameable/test-harness');
  type Tape = ReturnType<Harness['simulatePlayers']>;
  let direct: Tape;
  let wasm: Tape;

  /**
   * Both seats join; every 10 frames seat 1 sends a good vote, and on the
   * frames between, a bad one: the wrong type, a negative seat, not JSON, or
   * over 32 bytes.
   *
   * @param sandbox The `votes` fixture, as the room's authority.
   * @param harness The test harness module.
   * @returns The tape.
   */
  function run(sandbox: Sandbox, harness: Harness): Tape {
    sandbox.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60, options: TWO_SEATS }));
    const bad = ['{"for":"zero"}', '{"for":-1}', '{for:0}', `{"for":0,"pad":"${'x'.repeat(32)}"}`];
    return harness.simulatePlayers(sandbox, {
      frames: FRAMES,
      players: 2,
      script: (frame, tape) => {
        if (frame === 0) tape.join(0, 'ana');
        if (frame === 1) tape.join(1, 'ben');
        if (frame < 5) return;
        if (frame % 10 === 5) tape.message(1, 'vote', `{"for":${String(frame % 2)}}`);
        else if (frame % 10 === 7) tape.message(1, 'vote', bad[(frame / 10) % bad.length | 0]);
        if (frame % 20 === 9) tape.message(0, 'vote', '{"for":1}');
      },
    });
  }

  beforeAll(async () => {
    const harness = await import('@gameable/test-harness');
    // In turn: a direct guest shares the SDK's arrays with every other direct guest in this realm.
    direct = run(await createDirect(await createBoundaryHost(), 'votes'), harness);
    wasm = run(await createWasmSandbox(await createBoundaryHost(), 'votes'), harness);
  }, 600_000);

  it('answers every valid vote with a tally to both players, and drops the bad ones', () => {
    for (const tape of [direct, wasm]) {
      const tallies = tape.views.map(
        (frame) => frame.find((v) => v.player === 0)?.sends.filter((s) => s.name === 'tally') ?? [],
      );
      // Seat 1: frames 5, 15, ..., 115 (12); seat 0: frames 9, 29, ..., 109 (6).
      expect(tallies.flat()).toHaveLength(18);
      expect(tallies[15].map((s) => s.payload)).toEqual(['{"by":1,"for":1,"frame":15}']);
      expect(tallies[17]).toEqual([]);
      // Seat 1's last HUD: 12 received from seat 1 plus 6 from seat 0, and 11 bad votes before frame 115.
      const huds = tape.views
        .map((frame) => frame.find((v) => v.player === 1)?.hud)
        .filter((h): h is string => h !== undefined);
      expect(JSON.parse(huds[huds.length - 1])).toEqual({ dropped: 11, received: 18 });
    }
  });

  it('hashes identically on every frame and shows each player the same view', () => {
    expect(wasm.hashes).toHaveLength(FRAMES);
    const diverged: number[] = [];
    for (let frame = 0; frame < FRAMES; frame += 1) {
      if (wasm.hashes[frame] !== direct.hashes[frame]) diverged.push(frame);
    }
    expect(diverged).toEqual([]);
    expect(wasm.views).toEqual(direct.views);
  });
});
