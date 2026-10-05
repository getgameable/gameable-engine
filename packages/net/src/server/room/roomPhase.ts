/**
 * The guest's `ctx.net.setPhase`, read off a step's sends: the reserved
 * `aos:phase` message the room server keeps for itself.
 */
import { isPhaseWord, PHASE_MESSAGE, RESERVED_MESSAGE_PREFIX } from '@gameable/sdk/wire';

/** What a send looks like to this reader. */
interface Send {
  readonly to?: number;
  readonly name: string;
  readonly payload: string;
}

/**
 * @param name A message name.
 * @returns True for a name the engine keeps (`aos:`): never forwarded to a
 *   player, and dropped when a client sends it.
 */
export function isReservedMessage(name: string): boolean {
  return name.startsWith(RESERVED_MESSAGE_PREFIX);
}

/**
 * The last phase the guest set in a step. Allocates only when the step holds
 * an `aos:phase` send, which `setPhase` emits on a change only.
 *
 * @param sends The step's sends, in order.
 * @returns The newest valid phase word, or undefined when the step set none.
 */
export function phaseIn(sends: readonly Send[]): string | undefined {
  let phase: string | undefined;
  for (let i = 0; i < sends.length; i += 1) {
    const send = sends[i];
    if (send.name !== PHASE_MESSAGE || send.to !== undefined) continue;
    let word: unknown;
    try {
      word = JSON.parse(send.payload);
    } catch {
      continue;
    }
    if (isPhaseWord(word)) phase = word;
  }
  return phase;
}
