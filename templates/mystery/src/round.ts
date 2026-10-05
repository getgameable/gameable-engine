/**
 * The round: who is ready, who is in it, who is "it", who is out, and the
 * vote. Authority state only; a client never learns who "it" is except
 * through its own HUD.
 *
 * Flat lanes indexed by player id (and one by entity), sized once, so the
 * systems read and write numbers and a tick allocates nothing.
 */
import { Ballot } from './ballot';
import { MAX_ENTITIES } from './prefabs';

/** Seats in a room: `features.multiplayer.maxPlayers` in `src/game.ts`. */
export const MAX_PLAYERS = 6;

/** Highest player id + 1 the round tracks. Seats start at 0; six fit with room to spare. */
export const MAX_SEATS = 16;

/** No round yet: the lobby. */
export const PHASE_WAITING = 0;
/** A round is running. */
export const PHASE_LIVE = 1;
/** One remains, or "it" is gone: the lobby again, with the result on screen. */
export const PHASE_OVER = 2;
/** After a tag-out: the players still in vote who "it" is. Nobody is tagged. */
export const PHASE_VOTE = 3;

/** `out[player]`: tagged by "it". */
export const OUT_TAGGED = 1;
/** `out[player]`: voted out. */
export const OUT_VOTED = 2;

/** "It" tagged everyone. */
export const WINNER_IT = 1;
/** "It" left the room mid-round (the last "it" still in): the crew wins. */
export const WINNER_CREW = 2;
/** The crew voted the last "it" still in out. */
export const WINNER_VOTE = 3;
/** The round ran `rules.roundSeconds` with crew still in: the crew wins. */
export const WINNER_TIME = 4;

/** The one round a room plays at a time. */
export class Round {
  /** One of the `PHASE_*` constants. */
  phase = PHASE_WAITING;
  /** The first player dealt "it" (the only one when `rules.its` is 1), or -1. */
  it = -1;
  /** How many players were dealt "it" this round. */
  itCount = 0;
  /** `ctx.elapsed` at the deal; the round ends `rules.roundSeconds` later. */
  dealtAt = 0;
  /** `ctx.elapsed` when tagging last paused (the deal, a vote); tagging starts after the grace period. */
  startedAt = 0;
  /** Every "it" at the deal as every HUD names a player (`#2 Sam and #5 Ann`), for the end-of-round line after they left. */
  itName = '';
  /** 0 while the round runs, then one of the `WINNER_*` constants. */
  winner = 0;
  /**
   * Bumped whenever something every HUD shows changes without a phase change
   * (a ready, a vote, a chat line), so the HUD knows to redraw.
   */
  revision = 0;
  /** 1 for a player who pressed ready in the lobby. Cleared by the deal. */
  readonly ready = new Uint8Array(MAX_SEATS);
  /** 1 for a player dealt "it" this round. */
  readonly its = new Uint8Array(MAX_SEATS);
  /** 1 for a player dealt into this round. */
  readonly playing = new Uint8Array(MAX_SEATS);
  /** 0 while in; `OUT_TAGGED` or `OUT_VOTED` once out this round. */
  readonly out = new Uint8Array(MAX_SEATS);
  /** Who voted for whom in the open vote, and the refused votes. */
  readonly ballot = new Ballot(MAX_SEATS);
  /** Entity id to player id + 1, for the players in this round; 0 is nobody. */
  readonly owner = new Int32Array(MAX_ENTITIES);
  /** The entity each seat was dealt, so a leave can forget it. */
  readonly entityAt = new Int32Array(MAX_SEATS);

  /** Back to the lobby. Call from `defineGame({ init })`. */
  reset(): void {
    this.phase = PHASE_WAITING;
    this.it = -1;
    this.itCount = 0;
    this.dealtAt = 0;
    this.startedAt = 0;
    this.itName = '';
    this.winner = 0;
    this.revision += 1;
    this.ready.fill(0);
    this.its.fill(0);
    this.ballot.clear();
    this.playing.fill(0);
    this.out.fill(0);
    this.owner.fill(0);
    this.entityAt.fill(0);
  }

  /**
   * Deal a round. Mark each "it" with {@link Round.makeIt} next.
   *
   * @param elapsed `ctx.elapsed` now.
   */
  begin(elapsed: number): void {
    this.reset();
    this.phase = PHASE_LIVE;
    this.dealtAt = elapsed;
    this.startedAt = elapsed;
  }

  /**
   * Make one dealt player "it".
   *
   * @param player The player id.
   * @param name Their display name, as every HUD shows it.
   */
  makeIt(player: number, name: string): void {
    if (player < 0 || player >= MAX_SEATS || this.its[player] === 1) return;
    this.its[player] = 1;
    if (this.it < 0) this.it = player;
    this.itCount += 1;
    this.itName = this.itName === '' ? name : `${this.itName} and ${name}`;
  }

  /**
   * @param player A player id.
   * @returns True for a player dealt "it" this round, in or out.
   */
  isIt(player: number): boolean {
    return player >= 0 && player < MAX_SEATS && this.its[player] === 1;
  }

  /**
   * Seat one player in the round being dealt.
   *
   * @param player The player id.
   * @param entity Their entity.
   */
  seat(player: number, entity: number): void {
    if (player < 0 || player >= MAX_SEATS) return;
    this.playing[player] = 1;
    this.entityAt[player] = entity;
    if (entity > 0 && entity < MAX_ENTITIES) this.owner[entity] = player + 1;
  }

  /**
   * A player dealt into this round left the room. Their seat leaves the round
   * with them: whoever takes it next watches until the next deal, even when
   * the leave and the join arrive in the same frame.
   *
   * @param player The player id.
   */
  leave(player: number): void {
    if (player < 0 || player >= MAX_SEATS || this.playing[player] === 0) return;
    this.playing[player] = 0;
    const entity = this.entityAt[player];
    if (entity > 0 && entity < MAX_ENTITIES) this.owner[entity] = 0;
    this.entityAt[player] = 0;
  }

  /**
   * @param entity An entity.
   * @returns The player in this round who owns it, or -1.
   */
  playerOf(entity: number): number {
    return entity > 0 && entity < MAX_ENTITIES ? this.owner[entity] - 1 : -1;
  }

  /**
   * @param player A player id.
   * @returns True for a player in this round who is not out.
   */
  alive(player: number): boolean {
    return (
      player >= 0 && player < MAX_SEATS && this.playing[player] === 1 && this.out[player] === 0
    );
  }

  /**
   * A ghost, in the Among Us sense: while a round runs (live or voting), a
   * player who is out or was never dealt in. Ghosts hear everyone; only
   * ghosts hear a ghost. Between rounds nobody is a ghost.
   *
   * @param player A player id.
   * @returns True for a ghost.
   */
  ghost(player: number): boolean {
    return (this.phase === PHASE_LIVE || this.phase === PHASE_VOTE) && !this.alive(player);
  }

  /** @returns How many players in this round are still in, "it" included. */
  aliveCount(): number {
    let n = 0;
    for (let id = 0; id < MAX_SEATS; id += 1) if (this.alive(id)) n += 1;
    return n;
  }

  /** @returns How many "it"s are still in. None left: the crew wins. */
  itsAlive(): number {
    let n = 0;
    for (let id = 0; id < MAX_SEATS; id += 1) if (this.alive(id) && this.its[id] === 1) n += 1;
    return n;
  }

  /** @returns How many of the crew are still in. None left: "it" wins. */
  crewAlive(): number {
    return this.aliveCount() - this.itsAlive();
  }
}

/** This guest's round. */
export const round = new Round();
