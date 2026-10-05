/**
 * Mystery: up to six players in one arena, one of them (or `rules.its` of
 * them) secretly "it".
 *
 * **This is the file to edit.** Everyone in the lobby presses R when ready;
 * once all of them are, and there are at least three, the authority deals a
 * round with the seeded `ctx.rng` (the host, `ctx.players.host`, can start
 * early with G). It tells "it" through their own HUD and nobody else, and
 * moves everyone onto a ring. After a few seconds' grace, "it" touching
 * anyone tags them out, and a vote follows: the players still in press 1-6
 * for who they think "it" is, and a majority puts that player out. Every
 * "it" voted out (or gone), or the clock (`rules.roundSeconds`) running out,
 * and the crew wins; no crew left, and "it" wins. Enter opens the page's chat
 * prompt; a line is echoed with the sender's name, and while a round runs a
 * ghost (out, or watching) is heard only by the other ghosts.
 *
 * Where each system runs is part of the design:
 *
 * - `readyUp`, `move`, `leavers`, `tag`, `vote`, `chat` and `roundHud` run on
 *   the **authority**: it owns the bodies and it is the only guest that knows
 *   who "it" is.
 * - `controls` runs on each player's **client**: keys become messages, and
 *   being tagged plays a sound on that page only.
 *
 * Alone (Play Solo), every system runs, nobody else is in the room, and the
 * HUD says "waiting for players": you can walk the arena but never win.
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame } from 'gameable';

import { chatLog, ghostLog } from './chat';
import { resetHud, roundHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { Crew, MAX_ENTITIES } from './prefabs';
import { MAX_PLAYERS, round } from './round';
import { chat } from './systems/chat';
import { controls } from './systems/controls';
import { leavers } from './systems/end';
import { listing } from './systems/listing';
import { move } from './systems/move';
import { readyUp } from './systems/ready';
import { tag } from './systems/tag';
import { vote } from './systems/vote';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

export default defineGame({
  // The page loads the character stack; a room seats up to six.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.crew', 'sfx.tag'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  // Spawned once per joining player on the authority, at init in solo.
  player: {
    prefab: Crew,
    spawn: [0, 1, 0],
    camera: 'thirdPerson',
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  // Every number the systems read. This is the tuning surface. The three to
  // change first: `roundSeconds`, `its` and `tagRadius`.
  rules: {
    // How long a round lasts, in seconds, votes included. The crew wins if
    // anyone of them is still in when it runs out.
    roundSeconds: 180,
    // How many players are "it". Always at least one crew member is left to
    // tag, so a small room deals fewer. Two or more "it"s know each other.
    its: 1,
    // Fewer than three and the hidden role is no secret.
    minPlayers: 3,
    // Seconds after the deal, and after each vote, before "it" can tag.
    graceSeconds: 3,
    // Seconds a vote stays open without a majority; then nobody is out.
    voteSeconds: 30,
    // How close "it" has to get, centre to centre, metres. Two capsules
    // touch at 0.7; a little more forgives the round trip to the server.
    tagRadius: 0.9,
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
  },

  init: () => {
    round.reset();
    round.ballot.reset();
    chatLog.reset();
    ghostLog.reset();
    resetHud();
    console.log(`mystery ready: up to ${String(MAX_PLAYERS)} players`);
  },

  // In order, once per fixed step, after the built-ins. The messages they
  // read (`ready`, `start`, `vote`, `chat`) are declared in `src/messages.ts`.
  systems: [
    { run: readyUp, on: 'authority' }, // the lobby: R from everyone, or the host's G
    { run: move, on: 'authority' },
    { run: leavers, on: 'authority' }, // a player gone mid-round is out
    { run: tag, on: 'authority' }, // a tag-out opens a vote
    { run: vote, on: 'authority' }, // a majority puts that player out
    { run: chat, on: 'authority' }, // echoed with the sender's name; ghosts only to ghosts
    { run: roundHud, on: 'authority' },
    { run: listing, on: 'authority' }, // the room list's phase: lobby, playing or voting
    { run: controls, on: 'client' }, // R, G and 1-6 become messages
  ],
});
