/**
 * The filters game (Task 4.2): a real SDK guest whose authority, on every
 * `poke` message, emits the three outputs a room must keep to their reader:
 * a `send` with `to: 2`, a spawn inside `ctx.net.local`, and player 1's own
 * HUD; plus a broadcast `all`, the positive control. Tests only: our Room's
 * (`Room.filters.test.ts`) and the Colyseus room's, which imports this file
 * by URL as it does the tiny game. Not exported from the package.
 */
import { defineGame, type GameContext, type GameDefinition, prefab } from '@gameable/sdk';

/** Only ever spawned inside `ctx.net.local`: no player may ever hear of it. */
export const MARKER = 'local-marker';

/** The HUD player 1 is given; nobody else may see it. */
export const HUD_ONE = '{"mine":1}';

const Marker = prefab({ name: MARKER });
const origin = { x: 0, y: 0, z: 0 };
const toTwo = { n: 0 };
const everyone = { n: 0 };
const hudOne = { mine: 1 };
let current: GameContext | null = null;

/** The spawn `ctx.net.local` runs; a module function, so a poke allocates no closure. */
function spawnMarker(): void {
  current?.spawn(Marker, origin);
}

/**
 * The authority's system.
 *
 * @param ctx The frame context.
 */
function answerPokes(ctx: GameContext): void {
  const pokes = ctx.net.messages('poke');
  for (let i = 0; i < pokes.length; i += 1) {
    toTwo.n += 1;
    everyone.n += 1;
    ctx.net.send('for-two', toTwo, { to: 2 });
    ctx.net.send('all', everyone);
    current = ctx;
    ctx.net.local(spawnMarker);
    current = null;
    ctx.players.get(1)?.hud.set(hudOne);
  }
}

/** @returns A fresh definition of the filters game (its counters start at 0). */
export function filtersGame(): GameDefinition {
  toTwo.n = 0;
  everyone.n = 0;
  return defineGame({ systems: [{ on: 'authority', run: answerPokes }] });
}
