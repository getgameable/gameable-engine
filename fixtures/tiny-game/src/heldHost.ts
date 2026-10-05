/**
 * The tiny game with three seats, for the boundary test that a held seat (in
 * the room, out of `frame-input.players`) moves the host and reads as neutral
 * input the same way in direct and in wasm mode. Built to wasm by
 * `buildTinyGame({ game: 'heldHost' })`.
 *
 * As the authority it shows, on the frame HUD, `ctx.players.host` and what
 * seat 1's input says: W held, E pressed, the mouse's dx.
 */
import { defineGame, type GameContext } from 'gameable';

import game from './game';

/** The HUD model, reused: a system must not allocate. */
const view = { host: -1, w: false, e: false, dx: 0 };

/**
 * @param ctx The frame context.
 */
function showHost(ctx: GameContext): void {
  const seat = ctx.players.get(1);
  view.host = ctx.players.host ?? -1;
  view.w = seat?.input.isDown('KeyW') ?? false;
  view.e = seat?.input.pressed('KeyE') ?? false;
  view.dx = seat?.input.mouse.dx ?? 0;
  ctx.hud.set(view);
}

export default defineGame({
  ...game,
  features: { multiplayer: { maxPlayers: 3 } },
  systems: [...(game.systems ?? []), showHost],
});
