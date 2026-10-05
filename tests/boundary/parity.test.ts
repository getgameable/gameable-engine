/**
 * Direct mode and wasm mode must be the same program.
 *
 * The two sandboxes share the SDK runtime on purpose; the only difference is
 * which realm it runs in and how values cross. This test drives the same 300
 * scripted frames through both and compares `hashFrameOutput` frame by frame,
 * which covers transforms, commands, camera and HUD.
 *
 * The tape also carries the 0.2.0 lanes — two room players with their own
 * input (unrounded mouse floats included) and the `player-joined` / `message`
 * events — so every new `frame-input` record is lowered into the component on
 * every frame, and a lowering fault traps the wasm guest instead of passing
 * unseen. Player 2's `ping` is answered by the tiny game's authority system,
 * which reads player 2's input and emits a `send` and a `set-player-hud`, so
 * the new SDK paths cross the boundary in both modes too.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts
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

/** How many frames both modes run. */
const FRAMES = 300;

describe.skipIf(!BOUNDARY_ENABLED)('direct / wasm parity', () => {
  let directHashes: number[] = [];
  let wasmHashes: number[] = [];
  let directTags: string[][] = [];
  let wasmTags: string[][] = [];
  let directHud: { frame: number; json: string }[] = [];
  let wasmHud: { frame: number; json: string }[] = [];

  /**
   * Run the scripted tape through one sandbox.
   *
   * @param sandbox The sandbox to drive.
   * @param harness The test harness module.
   * @returns Per-frame hashes, command tags and HUD payloads.
   */
  function run(
    sandbox: Sandbox,
    harness: typeof import('@gameable/test-harness'),
  ): { hashes: number[]; tags: string[][]; hud: { frame: number; json: string }[] } {
    // Built per run, so neither mode sees the other's rounding.
    const one = harness.createInputState();
    const two = harness.createInputState();
    const players = [
      { player: 1, seq: 0, input: one },
      { player: 2, seq: 0, input: two },
    ];
    const result = harness.simulate(sandbox, {
      frames: FRAMES,
      script: (frame, input) => {
        if (frame === 5) harness.press(input, 'W');
        if (frame === 90) harness.release(input, 'W');
        if (frame === 95) harness.press(input, 'A');
        if (frame === 150) harness.release(input, 'A');
        if (frame % 60 === 40) harness.pressMouse(input, 1);
        if (frame % 60 === 41) harness.releaseMouse(input, 1);
        input.mouse.dx = frame % 30 === 0 ? 12 : 0;
        input.mouse.dy = frame % 45 === 0 ? -7 : 0;
        if (frame === 10) harness.press(two, 'W');
        one.mouse.dx = frame % 7 === 0 ? 0.1 : 0;
        players[0].seq = frame;
        players[1].seq = frame + 1;
        const events =
          frame % 50 === 3
            ? [
                { tag: 'player-joined' as const, val: { player: 2, name: 'bo', data: undefined } },
                { tag: 'message' as const, val: { player: 1, name: 'vote', payload: '{"for":2}' } },
                { tag: 'message' as const, val: { player: 2, name: 'ping', payload: '{}' } },
              ]
            : [];
        return {
          players,
          events,
          bodies: harness.packBodies([
            {
              body: 1,
              groundState: frame % 60 < 30 ? 1 : 4,
              position: [0, 1 + Math.sin(frame * 0.05) * 0.01, -frame * 0.01],
            },
            { body: 2, position: [-3, 1, -6] },
            { body: 3, position: [0, 1, -6] },
            { body: 4, position: [3, 1, -6] },
          ]),
        };
      },
    });
    return { hashes: result.hashes, tags: result.commandTags, hud: result.hud };
  }

  beforeAll(async () => {
    const harness = await import('@gameable/test-harness');

    const directHost = await createBoundaryHost();
    const direct = await createDirect(directHost);
    direct.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60 }));
    const d = run(direct, harness);
    directHashes = d.hashes;
    directTags = d.tags;
    directHud = d.hud;

    const wasmHost = await createBoundaryHost();
    const wasm = await createWasmSandbox(wasmHost);
    wasm.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60 }));
    const w = run(wasm, harness);
    wasmHashes = w.hashes;
    wasmTags = w.tags;
    wasmHud = w.hud;

    expect(direct.dead).toBe(false);
    expect(wasm.dead).toBe(false);
  }, 600_000);

  it('produces the same command tags on every frame', () => {
    expect(wasmTags).toEqual(directTags);
  });

  it("answers player 2's ping with a send and a set-player-hud in both modes", () => {
    for (const tags of [directTags, wasmTags]) {
      const answered = tags.filter((t) => t.includes('send') && t.includes('set-player-hud'));
      // One ping every 50 frames from frame 3: 3, 53, ..., 253.
      expect(answered).toHaveLength(6);
    }
  });

  it('emits the same HUD payloads', () => {
    expect(wasmHud).toEqual(directHud);
  });

  it('observes alternating ground contact in both modes with zero vertical velocity', () => {
    for (const tape of [directHud, wasmHud]) {
      expect(tape.length).toBeGreaterThan(2);
      for (const entry of tape) {
        const hud = JSON.parse(entry.json) as { grounded: number };
        expect(hud.grounded).toBe(entry.frame % 60 < 30 ? 1 : 0);
      }
    }
  });

  it('hashes identically for every one of the scripted frames', () => {
    expect(wasmHashes).toHaveLength(FRAMES);
    const diverged: number[] = [];
    for (let frame = 0; frame < FRAMES; frame += 1) {
      if (wasmHashes[frame] !== directHashes[frame]) diverged.push(frame);
    }
    expect(diverged).toEqual([]);
  });
});

/** How many frames the two-player tape runs. */
const ROOM_FRAMES = 200;

/** `game-config.options` a two-seat room's authority boots with (the highest seat id, as the room passes it). */
const TWO_SEATS = '{"net":{"role":"authority","maxPlayers":1}}';

describe.skipIf(!BOUNDARY_ENABLED)('direct / wasm parity, two players in a room', () => {
  type Harness = typeof import('@gameable/test-harness');
  type Tape = ReturnType<Harness['simulatePlayers']>;
  let direct: Tape;
  let wasm: Tape;

  /**
   * Seat 0 joins on frame 0 and walks; seat 1 joins on frame 10, walks and
   * looks around, pings the authority, and leaves on frame 150.
   *
   * @param sandbox The two-seat fixture, as the room's authority.
   * @param harness The test harness module.
   * @returns The tape: per-frame hashes and every player's view.
   */
  function run(sandbox: Sandbox, harness: Harness): Tape {
    sandbox.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60, options: TWO_SEATS }));
    return harness.simulatePlayers(sandbox, {
      frames: ROOM_FRAMES,
      players: 2,
      script: (frame, tape) => {
        if (frame === 0) tape.join(0, 'ana');
        if (frame === 10) tape.join(1, 'ben');
        if (frame === 150) tape.leave(1);
        if (frame === 5) harness.press(tape.input(0), 'W');
        if (frame === 90) harness.release(tape.input(0), 'W');
        if (frame === 95) harness.press(tape.input(0), 'D');
        if (frame === 12) harness.press(tape.input(1), 'A');
        if (frame === 60) harness.press(tape.input(1), 'W');
        tape.input(1).mouse.dx = frame % 7 === 0 ? 3.1 : 0;
        if (frame % 40 === 20) tape.message(1, 'ping', '{}');
      },
    });
  }

  beforeAll(async () => {
    const harness = await import('@gameable/test-harness');
    // In turn, never interleaved: a direct guest shares the SDK's arrays with
    // every other direct guest in this realm, so only one may be live at a time.
    direct = run(await createDirect(await createBoundaryHost(), 'twoSeats'), harness);
    wasm = run(await createWasmSandbox(await createBoundaryHost(), 'twoSeats'), harness);
  }, 600_000);

  it('seats both players, moves both, and drops the one who left', () => {
    for (const tape of [direct, wasm]) {
      expect(tape.views[9].map((v) => v.player)).toEqual([0]);
      expect(tape.views[10].map((v) => v.player)).toEqual([0, 1]);
      expect(tape.views[150].map((v) => v.player)).toEqual([0]);
      const [ana, ben] = tape.views[100];
      expect(ana.entity).not.toBe(0);
      expect(ben.entity).not.toBe(0);
      expect(ben.entity).not.toBe(ana.entity);
      const moves = tape.commandTags
        .slice(10, 150)
        .flat()
        .filter((t) => t === 'move-character');
      expect(moves.length).toBeGreaterThanOrEqual(2 * 140);
    }
  });

  it("answers seat 1's pings on its own HUD in both modes", () => {
    for (const tape of [direct, wasm]) {
      const pinged = tape.views.filter(
        (frame) => frame.find((v) => v.player === 1)?.hud !== undefined,
      );
      // Frames 20, 60, 100 and 140: seat 1 is seated for all four.
      expect(pinged).toHaveLength(4);
    }
  });

  it('hashes identically for every one of the two-player frames, and shows each player the same view', () => {
    expect(wasm.hashes).toHaveLength(ROOM_FRAMES);
    const diverged: number[] = [];
    for (let frame = 0; frame < ROOM_FRAMES; frame += 1) {
      if (wasm.hashes[frame] !== direct.hashes[frame]) diverged.push(frame);
    }
    expect(diverged).toEqual([]);
    expect(wasm.views).toEqual(direct.views);
  });
});
