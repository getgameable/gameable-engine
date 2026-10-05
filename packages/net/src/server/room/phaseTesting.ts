/**
 * The phase game: a real SDK guest whose authority sets the room's phase
 * (`ctx.net.setPhase`) to whatever word a `phase` message carries, and
 * broadcasts `all` as the positive control. If a client's own `aos:phase`
 * ever reached it, it would broadcast `leak`. Tests only: our Room's
 * (`Room.phase.test.ts`) and the Colyseus room's, which imports this file by
 * URL. Not exported from the package.
 */
import { defineGame, type GameContext, type GameDefinition } from '@gameable/sdk';

const everyone = { n: 0 };

/**
 * The authority's system.
 *
 * @param ctx The frame context.
 */
function follow(ctx: GameContext): void {
  const asks = ctx.net.messages('phase');
  for (let i = 0; i < asks.length; i += 1) {
    const word = asks[i].payload;
    if (typeof word === 'string') ctx.net.setPhase(word);
    everyone.n += 1;
    ctx.net.send('all', everyone);
  }
  if (ctx.net.messages('aos:phase').length > 0) ctx.net.send('leak', null);
}

/** @returns A fresh definition of the phase game. */
export function phaseGame(): GameDefinition {
  everyone.n = 0;
  return defineGame({ systems: [{ on: 'authority', run: follow }] });
}
