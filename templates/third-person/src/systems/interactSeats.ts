/**
 * What each player has and sees for `src/systems/interact.ts`: their pocket,
 * their prompt and their notice, one per player seat. Seat 0's are the
 * exported `questState` and `interactState`, which also hold the state every
 * player shares (chests opened, the door, the escape).
 */
import { KIND_NONE } from '../prefabs';
import type { Actor } from './actors';
import { SeatStore } from './seats';

/** One player's pocket. */
export interface Pocket {
  /** Keys in the pocket. One is enough. */
  keys: number;
}

/**
 * What the single player is carrying (seat 0's pocket in a room), and how the
 * round is going: `chestsOpened` and `escaped` are shared by every player.
 */
export const questState = {
  /** Keys in the pocket. One is enough. */
  keys: 0,
  /** Chests opened so far, by anyone. */
  chestsOpened: 0,
  /** True once the door has finished sliding. */
  escaped: false,
};

/** What `E` would do right now for one player, and the notice on their screen. */
export interface InteractSeat {
  /** The entity `E` would act on, or 0. */
  target: number;
  /** One of the `KIND_*` constants, for the entity in `target`. */
  kind: number;
  /** The prompt line, or `''` when nothing is in reach. */
  prompt: string;
  /** A transient notice: "the chest is empty", "it is locked". */
  message: string;
  /** Fixed steps left before `message` clears. */
  messageFrames: number;
}

/**
 * What `E` would do right now for the single player (seat 0's in a room), and
 * what the door is doing: `door` and `doorSlid` are shared by every player.
 */
export const interactState = {
  target: 0,
  kind: KIND_NONE,
  prompt: '',
  message: '',
  messageFrames: 0,
  /** The door entity, found during `init`. */
  door: 0,
  /** How far the door has slid, in metres. */
  doorSlid: 0,
};

/**
 * @param seat One player's interact state.
 */
function clearSeat(seat: InteractSeat): void {
  seat.target = 0;
  seat.kind = KIND_NONE;
  seat.prompt = '';
  seat.message = '';
  seat.messageFrames = 0;
}

/** Every player's interact state; seat 0's is {@link interactState}. */
export const seats = new SeatStore<InteractSeat>(
  interactState,
  () => ({ target: 0, kind: KIND_NONE, prompt: '', message: '', messageFrames: 0 }),
  clearSeat,
);

/** Every player's pocket; seat 0's is {@link questState}. */
export const pockets = new SeatStore<Pocket>(
  questState,
  () => ({ keys: 0 }),
  (pocket) => {
    pocket.keys = 0;
  },
);

/**
 * A player's HUD-facing state, for `src/hud.ts`.
 *
 * @param who The player.
 * @returns Their interact state and pocket.
 */
export function interactFor(who: Actor): { seat: InteractSeat; pocket: Pocket } {
  view.seat = seats.of(who);
  view.pocket = pockets.of(who);
  return view;
}

/** The reused answer of {@link interactFor}. */
const view: { seat: InteractSeat; pocket: Pocket } = { seat: interactState, pocket: questState };

/**
 * Forget everything. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetInteract(): void {
  seats.reset();
  pockets.reset();
  questState.chestsOpened = 0;
  questState.escaped = false;
  interactState.door = 0;
  interactState.doorSlid = 0;
}
