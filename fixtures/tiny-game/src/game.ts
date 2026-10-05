/**
 * The tiny game: the smallest module that exercises every part of the wasm
 * boundary, and the fixture `tests/boundary/` builds and runs.
 *
 * It spawns a capsule-bodied player and three enemies, walks the player with
 * WASD, hitscans on left mouse button, refreshes the HUD every 30 frames, and,
 * as a room's authority, answers a player's `ping` message with a `pong` and
 * that player's own HUD.
 * Nothing here is special-cased for tests: it is exactly the code a game
 * author writes.
 */
import {
  defineGame,
  Enemy,
  Health,
  Player,
  Transform,
  prefab,
  type GameContext,
  type PlayerHandle,
} from 'gameable';

/** The player: an invisible capsule driven by the host character controller. */
export const PlayerPrefab = prefab({
  name: 'player',
  body: {
    shape: 'capsule',
    dims: [0.3, 0.9],
    kind: 'character',
    mass: 80,
    layer: { player: true },
    mask: { staticGeometry: true, enemy: true, pickup: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  health: 100,
  components: [Player],
});

/** An enemy: a visible box that the player can shoot. */
export const EnemyPrefab = prefab({
  name: 'enemy',
  asset: 'enemy-capsule',
  body: {
    shape: 'capsule',
    dims: [0.3, 0.9],
    kind: 'dynamic',
    mass: 60,
    layer: { enemy: true },
    mask: { staticGeometry: true, player: true, projectile: true },
    flags: { reportContacts: true },
  },
  health: 30,
  components: [Enemy],
});

/** Metres per second the player walks at. */
const WALK_SPEED = 4;
/** How far the hitscan reaches. */
const RANGE = 100;
/** Damage one hit does. */
const DAMAGE = 10;

/** Reused query vectors: a system must not allocate. */
const eye = { x: 0, y: 0, z: 0 };
const forward = { x: 0, y: 0, z: -1 };

/**
 * The walking player: the one `init` spawned in a single-player game, or, on
 * a room's authority (which spawns `player` per joined player), player 0's.
 *
 * @param ctx The frame context.
 * @returns The entity, or 0 before player 0 has joined.
 */
function playerOf(ctx: GameContext): number {
  return ctx.player !== 0 ? ctx.player : ctx.playerEntity(0);
}

/** The frame context while `movePlayer` walks the room's players; a callback must not close over it. */
let roomCtx: GameContext | null = null;

/**
 * Walk one entity from one input's WASD, in that camera's yaw frame.
 *
 * @param ctx The frame context.
 * @param entity The entity to walk, or 0 for none.
 * @param input The input that drives it.
 * @param yaw The camera yaw to walk in.
 * @returns Nothing.
 */
function walk(ctx: GameContext, entity: number, input: GameContext['input'], yaw: number): void {
  if (entity === 0) return;
  const move = input.axis2('A', 'D', 'S', 'W');
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Forward is -Z, so yaw rotates (x, z) into world space like this.
  const vx = (move.x * cos - move.y * sin) * WALK_SPEED;
  const vz = (-move.x * sin - move.y * cos) * WALK_SPEED;
  ctx.physics.moveCharacter(entity, vx, 0, vz, input.pressed('Space'));
}

/**
 * Walk one room player's own entity from their own input.
 *
 * @param player The player.
 * @returns Nothing.
 */
function walkRoomPlayer(player: PlayerHandle): void {
  if (roomCtx !== null) walk(roomCtx, player.entity, player.input, player.camera.look.yaw);
}

/**
 * Walk the player from WASD, in the camera's yaw frame. As a room's
 * authority, walk every joined player's entity from that player's input.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function movePlayer(ctx: GameContext): void {
  if (ctx.net.role === 'authority') {
    roomCtx = ctx;
    ctx.players.forEach(walkRoomPlayer);
    roomCtx = null;
    return;
  }
  walk(ctx, playerOf(ctx), ctx.input, ctx.camera.look.yaw);
}

/**
 * Hitscan on left mouse button, damaging whatever it hits.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function shoot(ctx: GameContext): void {
  if (!ctx.input.mousePressed(1)) return;
  const player = playerOf(ctx);
  if (player === 0) return;
  eye.x = Transform.x[player] ?? 0;
  eye.y = (Transform.y[player] ?? 0) + 1.7;
  eye.z = Transform.z[player] ?? 0;
  const yaw = ctx.camera.look.yaw;
  const pitch = ctx.camera.look.pitch;
  forward.x = -Math.sin(yaw) * Math.cos(pitch);
  forward.y = Math.sin(pitch);
  forward.z = -Math.cos(yaw) * Math.cos(pitch);

  const hit = ctx.physics.raycast(eye, forward, RANGE, undefined, player);
  ctx.audio.play('shot', { entity: player, volume: 0.8 });
  if (!hit) return;
  const target = hit.entity;
  if (target === 0) return;
  const left = (Health.current[target] ?? 0) - DAMAGE;
  Health.current[target] = left;
  if (left <= 0) ctx.despawn(target);
}

/**
 * Refresh the HUD every 30 frames. `hud.set` only emits when the model
 * actually changed, so the frame counter is what forces a payload.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function updateHud(ctx: GameContext): void {
  if (ctx.frame % 30 !== 0) return;
  let alive = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i] ?? 0;
    if (e !== 0 && (Health.current[e] ?? 0) > 0) alive += 1;
  }
  const player = playerOf(ctx);
  hudModel.health = Health.current[player] ?? 0;
  hudModel.frame = ctx.frame;
  hudModel.enemies = alive;
  hudModel.grounded = ctx.physics.isGrounded(player) ? 1 : 0;
  ctx.hud.set(hudModel);
}

/** Reused HUD model, so the 30-frame refresh does not allocate one. */
const hudModel: Record<string, number> = { health: 0, frame: 0, enemies: 0, grounded: 0 };

/** The enemies spawned in `init`, so the HUD can count survivors. */
const enemies: number[] = [];

/** Reused `pong` payload and per-player HUD model: a system must not allocate. */
const pong = { frame: 0, w: false };
const pongHud: Record<string, number> = { pong: 0, w: 0 };

/**
 * As the authority, answer every `ping` with a `pong` to its sender, and
 * show the sender, on their own HUD, the frame and whether they hold W.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function answerPings(ctx: GameContext): void {
  const pings = ctx.net.messages('ping');
  for (let i = 0; i < pings.length; i += 1) {
    const from = pings[i].player;
    const sender = ctx.players.get(from);
    pong.frame = ctx.frame;
    pong.w = sender?.input.isDown('W') ?? false;
    ctx.net.send('pong', pong, { to: from });
    pongHud.pong = ctx.frame;
    pongHud.w = pong.w ? 1 : 0;
    sender?.hud.set(pongHud);
  }
}

export default defineGame({
  assets: ['arena', 'enemy-capsule', 'shot'],
  world: { gravity: -9.81, maxEntities: 512 },
  player: {
    prefab: PlayerPrefab,
    spawn: [0, 1, 0],
    camera: 'firstPerson',
    eyeHeight: 1.7,
  },
  rules: { walkSpeed: WALK_SPEED, damage: DAMAGE },
  init: (ctx) => {
    enemies.length = 0;
    for (let i = 0; i < 3; i += 1) {
      enemies.push(ctx.spawn(EnemyPrefab, { x: (i - 1) * 3, y: 1, z: -6 }));
    }
    console.log(`tiny-game ready with ${String(enemies.length)} enemies`);
  },
  systems: [movePlayer, shoot, updateHud, { on: 'authority', run: answerPings }],
});
