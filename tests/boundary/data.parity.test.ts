/**
 * Player data across the boundary (Task 5.2): the `{ doc, savedAt }` a room
 * hands over at join, `ctx.data.save`, `ctx.data.exchange` and its
 * `exchange-result`, in direct and wasm mode, frame for frame.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts data.parity
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

const FRAMES = 80;
const TWO_SEATS = '{"net":{"role":"authority","maxPlayers":1}}';

describe.skipIf(!BOUNDARY_ENABLED)('direct / wasm parity: player data', () => {
  type Harness = typeof import('@gameable/test-harness');
  type Tape = ReturnType<Harness['simulatePlayers']>;
  let direct: Tape;
  let wasm: Tape;

  /**
   * Ana joins with 3 coins, Ben with none; Ana earns one, then trades two to
   * Ben, and the room answers the exchange as a store would.
   *
   * @param sandbox The ledger fixture, as the room's authority.
   * @param harness The test harness module.
   * @returns The tape.
   */
  function run(sandbox: Sandbox, harness: Harness): Tape {
    sandbox.init(harness.createGameConfig({ seed: 7n, fixedHz: 60, options: TWO_SEATS }));
    return harness.simulatePlayers(sandbox, {
      frames: FRAMES,
      players: 2,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) tape.join(0, 'ana', JSON.stringify({ doc: { coins: 3 }, savedAt: 1000 }));
        if (frame === 1) tape.join(1, 'ben');
        if (frame === 20) tape.message(0, 'earn', '{}');
        if (frame === 40) tape.message(0, 'trade', '{"coins":2}');
        // The store's answer carries both documents as it wrote them.
        if (frame === 45)
          return {
            events: [
              {
                tag: 'exchange-result',
                val: { id: 1, ok: true, reason: '', aData: '{"coins":2}', bData: '{"coins":2}' },
              },
            ],
          };
        return {};
      },
    });
  }

  beforeAll(async () => {
    const harness = await import('@gameable/test-harness');
    direct = run(await createDirect(await createBoundaryHost(), 'ledger'), harness);
    wasm = run(await createWasmSandbox(await createBoundaryHost(), 'ledger'), harness);
  }, 600_000);

  it('saves, trades and shows the traded documents in both modes', () => {
    for (const tape of [direct, wasm]) {
      const tags = tape.commandTags;
      expect(tags[20]).toContain('save-player-data');
      expect(tags[40]).toContain('exchange');
      expect(tags[45].filter((t) => t === 'save-player-data')).toHaveLength(2);
      const huds = tape.views[45];
      expect(huds.map((v) => v.hud)).toEqual([
        '{"coins":2,"since":1000,"last":"1:ok"}',
        '{"coins":2,"since":0,"last":"1:ok"}',
      ]);
    }
  });

  it('hashes identically on every frame, and every view matches', () => {
    expect(wasm.hashes).toEqual(direct.hashes);
    expect(wasm.views).toEqual(direct.views);
  });
});
