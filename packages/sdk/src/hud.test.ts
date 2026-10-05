import { describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { createGuest } from './runtime';
import { createStubHost, stubConfig, stubFrame } from './testing';
import type { GameContext } from './defineGame';

describe('the hud facade', () => {
  it('emits JSON only when the model changed', () => {
    const model: Record<string, unknown> = { health: 100, ammo: 30 };
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set(model);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"health":100,"ammo":30}');
    expect(guest.tick(stubFrame(1)).hud).toBeUndefined();
    expect(guest.tick(stubFrame(2)).hud).toBeUndefined();

    model.ammo = 29;
    expect(guest.tick(stubFrame(3)).hud).toBe('{"health":100,"ammo":29}');
    expect(guest.tick(stubFrame(4)).hud).toBeUndefined();
  });

  it('notices added and removed keys', () => {
    let model: Record<string, unknown> = { a: 1 };
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set(model);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"a":1}');
    model = { a: 1, b: 2 };
    expect(guest.tick(stubFrame(1)).hud).toBe('{"a":1,"b":2}');
    model = { a: 1 };
    expect(guest.tick(stubFrame(2)).hud).toBe('{"a":1}');
  });

  it('reports whether the payload will cross', () => {
    const seen: boolean[] = [];
    const model = { score: 0 };
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          seen.push(ctx.hud.set(model));
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    guest.tick(stubFrame(1));
    expect(seen).toEqual([true, false]);
  });

  it('sees an inline nested model rebuilt every frame as unchanged', () => {
    // The shape both templates use. Before the two-level compare, the nested
    // objects were compared by identity, so this paid a JSON.stringify every
    // single frame and the templates kept their own mirror model to avoid it.
    let ammo = 30;
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set({
            text: { ammo: String(ammo), state: 'idle' },
            bars: { health: 1 },
          });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe(
      '{"text":{"ammo":"30","state":"idle"},"bars":{"health":1}}',
    );
    expect(guest.tick(stubFrame(1)).hud).toBeUndefined();
    expect(guest.tick(stubFrame(2)).hud).toBeUndefined();

    ammo = 29;
    expect(guest.tick(stubFrame(3)).hud).toBe(
      '{"text":{"ammo":"29","state":"idle"},"bars":{"health":1}}',
    );
    expect(guest.tick(stubFrame(4)).hud).toBeUndefined();
  });

  it('sees the three-level model the fps template builds as unchanged', () => {
    let health = 80;
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set({
            text: { ammo: '30' },
            bars: { health: { value: health, max: 100 } },
            crosshair: true,
          });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe(
      '{"text":{"ammo":"30"},"bars":{"health":{"value":80,"max":100}},"crosshair":true}',
    );
    expect(guest.tick(stubFrame(1)).hud).toBeUndefined();
    health = 70;
    expect(guest.tick(stubFrame(2)).hud).toBe(
      '{"text":{"ammo":"30"},"bars":{"health":{"value":70,"max":100}},"crosshair":true}',
    );
    expect(guest.tick(stubFrame(3)).hud).toBeUndefined();
  });

  it('notices a key added to or removed from a nested object', () => {
    let extra = false;
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set(extra ? { text: { a: '1', b: '2' } } : { text: { a: '1' } });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"text":{"a":"1"}}');
    extra = true;
    expect(guest.tick(stubFrame(1)).hud).toBe('{"text":{"a":"1","b":"2"}}');
    extra = false;
    expect(guest.tick(stubFrame(2)).hud).toBe('{"text":{"a":"1"}}');
    expect(guest.tick(stubFrame(3)).hud).toBeUndefined();
  });

  it('does not alias a model the game mutates in place', () => {
    const nested = { ammo: 30 };
    const model = { text: nested };
    const game = defineGame({
      systems: [
        (ctx) => {
          ctx.hud.set(model);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"text":{"ammo":30}}');
    nested.ammo = 29;
    expect(guest.tick(stubFrame(1)).hud).toBe('{"text":{"ammo":29}}');
  });

  it('re-sends the model after invalidate, and clears on clear', () => {
    let action: 'none' | 'invalidate' | 'clear' = 'none';
    const game = defineGame({
      systems: [
        (ctx) => {
          if (action === 'invalidate') ctx.hud.invalidate();
          if (action === 'clear') {
            ctx.hud.clear();
            return;
          }
          ctx.hud.set({ score: 1 });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"score":1}');
    expect(guest.tick(stubFrame(1)).hud).toBeUndefined();
    action = 'invalidate';
    expect(guest.tick(stubFrame(2)).hud).toBe('{"score":1}');
    action = 'clear';
    expect(guest.tick(stubFrame(3)).hud).toBe('{}');
    // `clear` is `set({})`: once the host has an empty model, clearing again
    // sends nothing.
    expect(guest.tick(stubFrame(4)).hud).toBeUndefined();
    action = 'none';
    expect(guest.tick(stubFrame(5)).hud).toBe('{"score":1}');
  });

  it('invalidate alone sends nothing; the next set does', () => {
    let action: 'none' | 'invalidate' | 'quiet' = 'none';
    const game = defineGame({
      systems: [
        (ctx) => {
          if (action === 'invalidate') {
            ctx.hud.invalidate();
            return;
          }
          if (action === 'quiet') return;
          ctx.hud.set({ score: 1 });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(guest.tick(stubFrame(0)).hud).toBe('{"score":1}');
    action = 'invalidate';
    expect(guest.tick(stubFrame(1)).hud).toBeUndefined();
    action = 'quiet';
    expect(guest.tick(stubFrame(2)).hud).toBeUndefined();
    action = 'none';
    expect(guest.tick(stubFrame(3)).hud).toBe('{"score":1}');
  });
});
