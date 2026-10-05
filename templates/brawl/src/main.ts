/**
 * The host: everything that is not the game. You should rarely need to touch
 * this file — gameplay lives in `src/game.ts`.
 *
 * It boots the engine, loads the arena and its collider, creates the sandbox
 * the game runs in, and joins the room. The game declares `multiplayer`, so
 * this page is always a room's client: the client loop shows the
 * authority's world and runs the game's `client` and `both` systems here.
 *
 * - No `?room=`: Play Solo, the authority in this page (`src/solo.ts`), with
 *   a "Play with friends" button that makes a room.
 * - `?room=CODE` joins that room, `?room=new` makes one, `?room=quick` takes
 *   any open one, on the room server at `<page origin>/services/rooms/` (or,
 *   on a local page, `?rooms=<url>`, such as `gameable serve`'s).
 *
 * The game declares `predict: true`, so the page keeps a physics world of its
 * own: the arena's collider and this player's own body, which the client
 * loop moves on key-down and corrects from the authority.
 *
 * The sandbox is direct under `npm run dev` and wasm after `npm run build`
 * (`src/sandbox.ts`); the two must behave the same.
 */
import { audio } from 'gameable/audio';
import { bindFeatures, createEngine, resolveFeatures, type Engine } from 'gameable/core';
import { input } from 'gameable/input';
import { attachRoomClient } from 'gameable/net/client';
import { chooseRoom, leaveRoom, roomMode } from 'gameable/net/page';
import { physics } from 'gameable/physics';
import { DEFAULT_MAX_ENTITIES, featuresOf, type GameDefinition } from 'gameable';
import { splat } from 'gameable/splat';
import { createEngineAdapter, createEngineHost, createGameSlot } from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { listPublicRooms } from 'gameable/host/features';
import { DirectionalLight, HemisphereLight } from 'three/webgpu';

import { addEnvironmentCollider, buildManifest, joltWasmUrl } from './hostAssets';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { makeSandbox } from './sandbox';
import { GAME_NAME, pageFeatures } from './session';

declare global {
  interface Window {
    /** Set once the first frames have been drawn. The e2e suite waits on it. */
    __AOS_READY__?: { mode: string; backend: string; characters: string };
    /** Anything that went wrong, so a failure is a message and not a black canvas. */
    __AOS_ERROR__?: string;
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('error') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const warning = document.getElementById('warn') as HTMLElement;
const query = new URLSearchParams(location.search);
const seed = Number(query.get('seed') ?? 0x5eed1234);

/**
 * Show a failure instead of a black screen.
 *
 * @param error What went wrong.
 */
function fail(error: unknown): void {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(typeof current === 'string' ? current : 'unknown error');
      break;
    }
    parts.push(
      depth === 0 ? `${current.name}: ${current.message}` : `caused by: ${current.message}`,
    );
    current = current.cause;
  }
  window.__AOS_ERROR__ = `${window.__AOS_ERROR__ ?? ''}${parts.join('\n')}\n`;
  overlay.textContent = window.__AOS_ERROR__;
  overlay.classList.add('visible');
  console.error(error);
}

/**
 * Warn loudly, in the console and on screen, without stopping the page.
 *
 * @param message What is wrong and what to do.
 */
function showWarning(message: string): void {
  console.warn(message);
  warning.textContent = message;
  warning.classList.add('visible');
}

/** The engine, once `createEngine` has made it: a failed boot leaves its room. */
let booted: Engine | null = null;

/**
 * A boot that failed, or a client loop that died: show it, and give up the
 * room's seat at once, so the others do not see a statue in it.
 *
 * @param error What went wrong.
 */
function crash(error: unknown): void {
  fail(error);
  leaveRoom(booted);
}

window.addEventListener('error', (event) => {
  fail(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  fail(event.reason);
});

/**
 * Import the game's definition. Direct mode runs it; wasm mode only reads its
 * `features` (the game itself runs inside the compiled guest).
 *
 * @returns The definition.
 */
async function loadDefinition(): Promise<GameDefinition> {
  return (await import('./game')).default;
}

/**
 * Boot everything.
 *
 * @returns Resolves once the loop is running.
 */
async function main(): Promise<void> {
  const definition = await loadDefinition();
  const inputModule = input({ pointerLock: false, target: canvas });
  // The page's own physics world: the arena's collider and this player's predicted body.
  const modules = [
    physics({ ...PHYSICS_OPTIONS, wasmUrl: joltWasmUrl }),
    inputModule,
    audio(),
    splat(),
  ];
  // `createEngine` needs its module list up front and the game module needs the
  // booted engine, so the slot books the place and is filled in below.
  const slot = createGameSlot();
  // Only a solo page loads the in-page authority (`src/solo.ts`).
  const room = await chooseRoom(roomMode(location.search), {
    game: GAME_NAME,
    name: 'You',
    startSolo: async () => (await import('./solo')).startSolo(definition, seed, showWarning),
  });
  const loaded = await resolveFeatures(featuresOf(definition), pageFeatures(room.multiplayer));

  const engine = await createEngine({
    canvas,
    manifest: buildManifest(),
    modules: [...modules, ...loaded.flatMap((feature) => feature.modules), slot.module],
    fixedHz: 60,
    renderer: { backend: 'auto' },
    debug: import.meta.env.DEV,
  });
  booted = engine;

  const sky = new HemisphereLight(0xbfd4ff, 0x30302c, 1.4);
  const sun = new DirectionalLight(0xfff3e0, 2.1);
  sun.position.set(6, 12, 4);
  engine.scene.add(sky, sun);

  await engine.assets.load('env.arena');
  engine.get('splat').add('env.arena');
  await addEnvironmentCollider(engine.get('physics'));

  const bound = await bindFeatures(loaded, engine);
  const characters = bound.get('characters') as CharacterBridge | undefined;

  const adapter = createEngineAdapter(engine, { modules, characters });
  const host = createEngineHost(engine, adapter, { seed });
  const sandbox = await makeSandbox(host, definition);
  // The client loop (attaching it starts the join, now that the page has
  // loaded), Play Solo's authority on this page's frames, and the badge.
  await attachRoomClient({
    engine,
    net: engine.get('net'),
    adapter,
    sandbox,
    slot,
    room,
    loop: {
      seed,
      entityBase: definition.world?.maxEntities ?? DEFAULT_MAX_ENTITIES,
      predict: featuresOf(definition).multiplayer?.predict === true,
    },
    onDead: (error) => {
      crash(error ?? new Error('the client loop stopped'));
    },
    badge: { browse: { game: GAME_NAME, list: listPublicRooms } },
  });

  canvas.addEventListener('click', () => {
    hint.classList.add('hidden');
  });

  const offReady = engine.events.on('engine:frame', ({ frame }) => {
    if (frame < 3) return;
    window.__AOS_READY__ = {
      mode: import.meta.env.GAMEABLE_MODE,
      backend: engine.ctx.caps.webgpu ? 'webgpu' : 'webgl',
      characters: characters ? 'on' : 'off',
    };
    offReady();
  });

  engine.start();
}

void main().catch(crash);
