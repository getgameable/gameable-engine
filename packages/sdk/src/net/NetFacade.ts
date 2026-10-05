/**
 * `ctx.net`: where this guest runs, game messages in and out, and commands
 * that never leave the authority.
 */
import type { RuntimeState } from '../state';
import { MAX_PAYLOAD_BYTES, PHASE_MESSAGE, RESERVED_MESSAGE_PREFIX, isPhaseWord } from '../wire';
import { MessageInbox, type NetStats } from './MessageInbox';
import type { MessageDef } from './messages';
import { utf8Length } from './utf8';
import type { NetRole } from './roles';

/**
 * What `messages` hands back: one player's message, its payload parsed.
 *
 * @example
 * ```ts
 * for (const m of ctx.net.messages(Vote)) tally(m.player, m.payload.for);
 * ```
 */
export interface NetMessage<T> {
  /** The sender. */
  readonly player: number;
  /** The JSON payload, parsed. */
  readonly payload: T;
}

/**
 * Options for {@link NetFacade.send}.
 *
 * @example
 * ```ts
 * ctx.net.send('role', { role: 'murderer' }, { to: 3 });
 * ctx.net.send('aim', { x: 1 }, { reliable: false }); // every player, may drop
 * ```
 */
export interface SendOptions {
  /** One player; absent sends to every player. Ignored on a client. */
  to?: number;
  /** Ordered and guaranteed. Default true. */
  reliable?: boolean;
}

export { MAX_PAYLOAD_BYTES };
export type { NetStats };

/**
 * The `ctx.net` facade, one per guest.
 *
 * @example
 * ```ts
 * function votes(ctx: GameContext): void {
 *   if (!ctx.net.isAuthority) return;
 *   for (const vote of ctx.net.messages(Vote)) {
 *     ctx.net.send('voted', { by: vote.player, for: vote.payload.for });
 *   }
 *   ctx.net.local(() => ctx.audio.play('tick')); // never sent to a player
 * }
 * ```
 */
export class NetFacade {
  /** Counters since `init`. */
  readonly stats: NetStats = { dropped: 0, received: 0, unsent: 0 };
  private serial = 0;
  private readonly inboxes = new Map<string, MessageInbox>();
  /** `name: reason` pairs already logged, so a system sending every tick logs once. */
  private readonly warned = new Set<string>();
  /** The last phase `setPhase` sent, so the same word again sends nothing. */
  private phase: string | null = null;

  /** @param rt The runtime this facade belongs to. */
  constructor(private readonly rt: RuntimeState) {}

  /** @returns Where this guest runs. */
  get role(): NetRole {
    return this.rt.net.role;
  }

  /** @returns True on the authority and in a single-player game. */
  get isAuthority(): boolean {
    return this.rt.net.role !== 'client';
  }

  /** @returns The player this page belongs to on a client; 0 elsewhere. */
  get localPlayer(): number {
    return this.rt.net.localPlayer;
  }

  /** Start a tick: this tick's `messages` are read afresh. Runtime only. */
  beginTick(): void {
    this.serial += 1;
  }

  /** Forget the counters and every cached message list. `init` only. */
  reset(): void {
    this.stats.dropped = 0;
    this.stats.received = 0;
    this.stats.unsent = 0;
    this.serial = 0;
    this.inboxes.clear();
    this.warned.clear();
    this.phase = null;
  }

  /**
   * Send a game message: from the authority to one player or all of them,
   * from a client up to the authority (`to` is ignored there).
   *
   * Pass a `defineMessage` definition to check the payload with its guard
   * and cap it at its `maxBytes` before it leaves; a bare name (deprecated)
   * checks only the 2,048-byte wire cap.
   *
   * The payload is serialised with `JSON.stringify`, so a tick that sends
   * allocates that one string; a tick that sends nothing allocates nothing.
   * `undefined` sends `null`.
   *
   * @param message The definition, or a bare message name.
   * @param payload Anything JSON-serialisable; at most `maxBytes` (2,048) as UTF-8 JSON.
   * @param options `to` one player, and `reliable` (default true).
   * A payload that does not serialise (a function or a symbol), fails the
   * definition's check, or whose JSON is over the cap sends nothing and counts
   * in `stats.unsent`; it never throws, since a throwing system fails the tick.
   */
  send<T>(message: MessageDef<T>, payload: T, options?: SendOptions): void;
  send(name: string, payload: unknown, options?: SendOptions): void;
  send(message: MessageDef<unknown> | string, payload: unknown, options?: SendOptions): void {
    const rt = this.rt;
    // Not `instanceof`: a game bundling its own copy of the SDK still passes a definition.
    const def = typeof message === 'string' ? null : message;
    const name = def === null ? (message as string) : def.name;
    const reserved = name.startsWith(RESERVED_MESSAGE_PREFIX);
    const checked = !reserved && (def === null || passes(def, payload));
    const json = checked ? serialise(payload) : undefined;
    const cap = def === null ? MAX_PAYLOAD_BYTES : def.maxBytes;
    const bytes = json === undefined ? 0 : utf8Length(json);
    if (json === undefined || bytes > cap) {
      this.stats.unsent += 1;
      const why = reserved
        ? `has a name starting with '${RESERVED_MESSAGE_PREFIX}', which is the engine's`
        : !checked
          ? "fails the message's check"
          : json === undefined
            ? 'is not JSON-serialisable'
            : `is ${String(bytes)} bytes of JSON; the cap is ${String(cap)}`;
      this.warnOnce(name, `ctx.net.send('${name}'): the payload ${why}; nothing sent`);
      return;
    }
    const to = rt.net.role === 'client' ? undefined : options?.to;
    rt.commands.send(to, name, json, options?.reliable ?? true);
  }

  /**
   * Say what the room is doing, in a word (`lobby`, `playing`, `voting`), for
   * the public room list beside its code and seats. Authority only: on a
   * client, and in a game with no room, it does nothing. The same word again
   * sends nothing and allocates nothing; a new one sends the reserved message
   * `aos:phase`, which the room server reads and never forwards to a player.
   *
   * @param word 1 to 32 ASCII letters, digits or dashes. Anything else sends
   *   nothing, counts in `stats.unsent` and is logged once; it never throws.
   *
   * @example
   * ```ts
   * function lobby(ctx: GameContext): void {
   *   ctx.net.setPhase(started ? 'playing' : 'lobby');
   * }
   * ```
   */
  setPhase(word: string): void {
    if (this.rt.net.role !== 'authority' || word === this.phase) return;
    if (!isPhaseWord(word)) {
      this.stats.unsent += 1;
      this.warnOnce(
        PHASE_MESSAGE,
        `ctx.net.setPhase(${JSON.stringify(String(word)).slice(0, 40)}): a phase is 1 to 32 letters, digits or dashes; nothing sent`,
      );
      return;
    }
    this.phase = word;
    this.rt.commands.send(undefined, PHASE_MESSAGE, JSON.stringify(word), true);
  }

  /**
   * Log a refused send once per message name and reason.
   *
   * @param name The message's name.
   * @param line The whole log line.
   */
  private warnOnce(name: string, line: string): void {
    const key = `${name}: ${line}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.rt.host.log('warn', line);
  }

  /**
   * Run `fn` with every command it queues routed to `frame-output.local-commands`:
   * applied where this guest runs, never sent to a player. Nested calls stay
   * local; a throw still restores the network buffer. Allocates nothing.
   *
   * @param fn The code whose commands stay local.
   */
  local(fn: () => void): void {
    const rt = this.rt;
    const previous = rt.commands;
    rt.commands = rt.localCommands;
    try {
      fn();
    } finally {
      rt.commands = previous;
    }
  }

  /**
   * This tick's validated messages for one definition, in arrival order.
   *
   * A payload over the definition's `maxBytes`, not JSON, or failing its
   * check is dropped and counted in `stats.dropped`, never thrown at a
   * system; the rest count in `stats.received`. The list and its entries are
   * pooled and refilled each tick: read them inside the tick, never retain
   * them. Reading the same name twice in a tick counts nothing twice.
   *
   * A bare name (deprecated) reads the same list without a check, unless the
   * name's definition has been read before in this run; it caps at 2,048 bytes.
   *
   * @param message The definition, or a bare message name.
   * @returns The messages, `{ player, payload }`.
   */
  messages<T>(message: MessageDef<T> | string): readonly NetMessage<T>[] {
    const def = typeof message === 'string' ? null : (message as MessageDef<unknown>);
    const name = def === null ? (message as string) : def.name;
    let inbox = this.inboxes.get(name);
    if (inbox === undefined) {
      inbox = new MessageInbox(name);
      this.inboxes.set(name, inbox);
    }
    // The first definition read for a name is the one; a second object for the same
    // name (two SDK copies, a hand-made MessageDef) reads that list, never re-binds.
    if (def !== null && inbox.def === null) inbox.bind(def, this.serial, this.stats);
    return inbox.read(this.serial, this.rt.events, this.stats) as readonly NetMessage<T>[];
  }
}

/**
 * @param def The message's definition.
 * @param payload What a system asked to send.
 * @returns Whether the definition's check accepts it; a check that throws does not.
 */
function passes(def: MessageDef<unknown>, payload: unknown): boolean {
  try {
    return def.check(payload);
  } catch {
    return false;
  }
}

/**
 * @param payload What a system asked to send; `undefined` sends `null`.
 * @returns Its JSON, or undefined when it does not serialise.
 */
function serialise(payload: unknown): string | undefined {
  if (payload === undefined) return 'null';
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}
