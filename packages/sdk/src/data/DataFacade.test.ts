import { describe, expect, it } from 'vitest';

import { payloads, rig, roomFrame } from '../net/netTesting';
import type { GameContext } from '../defineGame';
import type { ExchangeCmd, GameEvent, SaveGameDataCmd, SavePlayerDataCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';

/**
 * A join carrying the room's `{ doc, savedAt }` envelope.
 *
 * @param player The seat.
 * @param doc The saved document.
 * @param savedAt When it was saved.
 * @returns The event.
 */
function joinedWith(player: number, doc: unknown, savedAt: number): GameEvent {
  return {
    tag: 'player-joined',
    val: { player, name: `p${String(player)}`, data: JSON.stringify({ doc, savedAt }) },
  };
}

/**
 * A rig whose `update` runs `step` with the context.
 *
 * @param step What the next update runs.
 * @param step.run The act.
 * @returns The rig.
 */
function dataRig(step: { run: (ctx: GameContext) => void }) {
  return rig(
    {
      update: (ctx) => {
        step.run(ctx);
      },
    },
    AUTHORITY,
  );
}

describe('ctx.data', () => {
  it('hands a joining player their saved document and when it was saved', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(roomFrame(0, [joinedWith(1, { coins: 10 }, 1234)]));
    expect(ctx().players.get(1)?.data).toEqual({ coins: 10 });
    expect(ctx().players.get(1)?.savedAt).toBe(1234);
  });

  it("hands over the server's clock at the load as joinedAt, with or without a document", () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    const envelope = (doc: unknown, savedAt: number | null): string =>
      JSON.stringify({ doc, savedAt, now: 9000 });
    guest.tick(
      roomFrame(0, [
        { tag: 'player-joined', val: { player: 1, name: 'a', data: envelope({ coins: 1 }, 1234) } },
        { tag: 'player-joined', val: { player: 2, name: 'b', data: envelope(null, null) } },
      ]),
    );
    expect(ctx().players.get(1)?.joinedAt).toBe(9000);
    expect(ctx().players.get(2)?.data).toBeNull();
    expect(ctx().players.get(2)?.savedAt).toBeNull();
    expect(ctx().players.get(2)?.joinedAt).toBe(9000);
  });

  it('keeps a bare JSON document as the data, with no savedAt', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(
      roomFrame(0, [{ tag: 'player-joined', val: { player: 2, name: 'b', data: '{"gold":5}' } }]),
    );
    expect(ctx().players.get(2)?.data).toEqual({ gold: 5 });
    expect(ctx().players.get(2)?.savedAt).toBeNull();
  });

  it('save queues a save-player-data and updates the handle', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(roomFrame(0, [joinedWith(1, { coins: 1 }, 1)]));
    step.run = (c) => {
      c.data.save(1, { coins: 2 });
    };
    const out = guest.tick(roomFrame(1));
    expect(payloads<SavePlayerDataCmd>(out.commands, 'save-player-data')).toEqual([
      { player: 1, data: '{"coins":2}' },
    ]);
    expect(ctx().players.get(1)?.data).toEqual({ coins: 2 });
  });

  it('exchange returns an id, and its result arrives in results() and moves the data', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(
      roomFrame(0, [
        joinedWith(0, { coins: 10 }, 1),
        joinedWith(1, { coins: 0, owned: ['gem'] }, 1),
      ]),
    );
    let id = 0;
    step.run = (c) => {
      id = c.data.exchange(0, 1, { coins: 4 }, { owned: ['gem'] });
    };
    const out = guest.tick(roomFrame(1));
    expect(id).toBeGreaterThan(0);
    expect(payloads<ExchangeCmd>(out.commands, 'exchange')).toEqual([
      { id, a: 0, b: 1, give: '{"coins":4}', take: '{"owned":["gem"]}' },
    ]);

    step.run = () => undefined;
    const done = guest.tick(
      roomFrame(2, [
        {
          tag: 'exchange-result',
          val: {
            id,
            ok: true,
            reason: '',
            aData: '{"coins":6,"owned":["gem"]}',
            bData: '{"coins":4,"owned":[]}',
          },
        },
      ]),
    );
    expect(ctx().data.results()).toEqual([{ id, ok: true, reason: '' }]);
    expect(ctx().players.get(0)?.data).toEqual({ coins: 6, owned: ['gem'] });
    expect(ctx().players.get(1)?.data).toEqual({ coins: 4, owned: [] });
    // Both sides are saved as they now are, so a save from before the result never wins.
    expect(
      payloads<SavePlayerDataCmd>(done.commands, 'save-player-data').map((s) => s.player),
    ).toEqual([0, 1]);

    guest.tick(roomFrame(3));
    expect(ctx().data.results()).toEqual([]);
  });

  it('a trade adopts the documents the store wrote, even when the guest copy moved meanwhile', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(
      roomFrame(0, [joinedWith(0, { coins: 10 }, 1), joinedWith(1, { owned: ['gem'] }, 1)]),
    );
    let id = 0;
    step.run = (c) => {
      id = c.data.exchange(0, 1, { coins: 4 }, { owned: ['gem'] });
    };
    guest.tick(roomFrame(1));
    // The giver spends while the trade is in flight; the room drops that save.
    step.run = (c) => {
      c.data.save(1, { owned: [] });
    };
    guest.tick(roomFrame(2));
    step.run = () => undefined;
    guest.tick(
      roomFrame(3, [
        {
          tag: 'exchange-result',
          val: {
            id,
            ok: true,
            reason: '',
            aData: '{"coins":6,"owned":["gem"]}',
            bData: '{"owned":[],"coins":4}',
          },
        },
      ]),
    );
    expect(ctx().players.get(0)?.data).toEqual({ coins: 6, owned: ['gem'] });
    expect(ctx().players.get(1)?.data).toEqual({ owned: [], coins: 4 });
  });

  it('a refused exchange changes nothing', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(roomFrame(0, [joinedWith(0, { coins: 1 }, 1), joinedWith(1, {}, 1)]));
    let id = 0;
    step.run = (c) => {
      id = c.data.exchange(0, 1, { coins: 4 }, {});
    };
    guest.tick(roomFrame(1));
    step.run = () => undefined;
    guest.tick(
      roomFrame(2, [
        { tag: 'exchange-result', val: { id, ok: false, reason: 'refused', aData: '', bData: '' } },
      ]),
    );
    expect(ctx().data.results()).toEqual([{ id, ok: false, reason: 'refused' }]);
    expect(ctx().players.get(0)?.data).toEqual({ coins: 1 });
  });

  it('game is the game-data document, and saveGame queues a save-game-data', () => {
    const step: { run: (ctx: GameContext) => void } = { run: () => undefined };
    const { guest, ctx } = dataRig(step);
    guest.tick(roomFrame(0));
    expect(ctx().data.game).toBeNull();
    guest.tick(roomFrame(1, [{ tag: 'game-data', val: { data: '{"round":3}' } }]));
    expect(ctx().data.game).toEqual({ round: 3 });
    step.run = (c) => {
      c.data.saveGame({ round: 4 });
    };
    const out = guest.tick(roomFrame(2));
    expect(payloads<SaveGameDataCmd>(out.commands, 'save-game-data')).toEqual([
      { data: '{"round":4}' },
    ]);
    expect(ctx().data.game).toEqual({ round: 4 });
  });

  it('a client saves nothing and says so once', () => {
    const step = {
      run: (c: GameContext) => {
        c.data.save(0, { coins: 1 });
      },
    };
    const { guest, host } = rig(
      {
        update: (c) => {
          step.run(c);
        },
      },
      '{"net":{"role":"client","localPlayer":0}}',
    );
    const out = guest.tick(roomFrame(0));
    guest.tick(roomFrame(1));
    expect(payloads(out.commands, 'save-player-data')).toEqual([]);
    expect(host.lines.filter((l) => l.includes('ctx.data'))).toHaveLength(1);
  });
});
