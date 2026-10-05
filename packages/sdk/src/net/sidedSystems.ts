/**
 * Systems that say where they run, filtered once in `init`, never per tick.
 */
import type { NetRole } from './roles';
import type { GameContext } from '../defineGame';

/** A plain system: one function, run once per fixed step. Same as `System`. */
type Run = (ctx: GameContext) => void;

/**
 * A system that says where it runs.
 *
 * `'authority'` runs on the room's authority and in a single-player (`solo`)
 * game; `'client'` runs on a player's page and in `solo`; `'both'` runs
 * everywhere. `solo` is its own authority and its own client, so it runs all
 * three. A bare function is `'authority'` once the game declares
 * `features.multiplayer`, and `'both'` otherwise, so a single-player game reads
 * the same as it always did.
 *
 * @example
 * ```ts
 * import { defineGame } from 'gameable';
 *
 * export default defineGame({
 *   features: { multiplayer: true },
 *   systems: [
 *     (ctx) => { ctx.net.send('tick', ctx.frame); }, // bare: the authority's
 *     { on: 'client', run: (ctx) => { ctx.hud.set({ ping: ctx.frame }); } },
 *   ],
 * });
 * ```
 */
export interface SidedSystem {
  /** The system. */
  run: Run;
  /** Where it runs. */
  on: 'authority' | 'client' | 'both';
}

/**
 * @param on Where a system says it runs.
 * @param role Where this guest runs.
 * @returns True when a system with that side runs here.
 */
function runsHere(on: SidedSystem['on'], role: NetRole): boolean {
  if (on === 'both' || role === 'solo') return true;
  return on === role;
}

/**
 * Keep the systems that run in this role, in declaration order. Init only.
 *
 * @param systems The game's `systems`, bare or sided.
 * @param multiplayer Whether the game declares `features.multiplayer`.
 * @param role Where this guest runs.
 * @param outRuns Cleared, then filled with the systems that run here.
 * @param outLabels Cleared, then filled with `"system[i]"`, `i` the declaration index.
 */
export function resolveSystems(
  systems: readonly (Run | SidedSystem)[],
  multiplayer: boolean,
  role: NetRole,
  outRuns: Run[],
  outLabels: string[],
): void {
  outRuns.length = 0;
  outLabels.length = 0;
  const bare: SidedSystem['on'] = multiplayer ? 'authority' : 'both';
  for (let i = 0; i < systems.length; i += 1) {
    const entry = systems[i];
    const run = typeof entry === 'function' ? entry : entry.run;
    const on = typeof entry === 'function' ? bare : entry.on;
    if (!runsHere(on, role)) continue;
    outRuns.push(run);
    outLabels.push(`system[${String(i)}]`);
  }
}
