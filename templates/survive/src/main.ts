/**
 * The host: everything that is not the game. The third-person template's
 * multiplayer boot, always on, minus its GNM guide; its test hook
 * (`src/testHooks.ts`, under `?test=1`) only reports the room.
 *
 * It boots the engine, registers the host modules, loads the arena and its
 * collider, creates the sandbox the game runs in, and gets out of the way.
 * Gameplay lives in `src/game.ts`.
 *
 * The game declares `multiplayer`, so this page is always a room's client:
 * the client loop shows the authority's world and runs the game's `client`
 * systems. Without a `?room=` it plays solo: the authority runs in this page
 * too (`gameable/net/solo`), as the game's wasm guest on its own headless
 * engine, with the Jolt world, the arena's collider and the page's physics
 * options from `src/physicsOptions.ts`, never a copy. `?room=CODE` joins that
 * room on the room server, `?room=new` makes one and `?room=quick` takes any
 * open one (`gameable/net/page`); the badge in the corner shows the code,
 * a copy-link button and the connection's state.
 *
 * Two sandbox modes share one code path, which is the whole point of the
 * design: `import.meta.env.GAMEABLE_MODE` is `direct` under `npm run dev`, where
 * the game's TypeScript is imported and run as-is, and `wasm` after
 * `npm run build`, where the same TypeScript has been compiled to a
 * WebAssembly component. If the two ever behave differently, that is an
 * engine bug, not a configuration difference.
 */
import { audio } from 'gameable/audio';
import { bindFeatures, createEngine, resolveFeatures, type Engine } from 'gameable/core';
import { input } from 'gameable/input';
import { attachRoomClient } from 'gameable/net/client';
import { chooseRoom, leaveRoom, roomMode } from 'gameable/net/page';
import { DEFAULT_MAX_ENTITIES, featuresOf, type GameDefinition, type HostApi } from 'gameable';
import { splat } from 'gameable/splat';
import {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createSandbox,
  type Sandbox,
} from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { listPublicRooms } from 'gameable/host/features';
import { DirectionalLight, HemisphereLight } from 'three/webgpu';

import { buildManifest } from './hostAssets';
import { GAME_NAME, pageFeatures } from './session';
import { installTestHooks } from './testHooks';

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
 * Warn loudly, in the console and on screen, without stopping the page.
 *
 * @param message What is wrong and what to do.
 */
function showWarning(message: string): void {
  console.warn(message);
  warning.textContent = message;
  warning.classList.add('visible');
}

/**
 * Show a failure instead of a black screen.
 *
 * @param error What went wrong.
 * @returns Nothing.
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
 * Import the game's definition.
 *
 * It is imported in both modes: direct mode runs it, wasm mode only reads its
 * `features` (the game itself runs inside the compiled guest).
 *
 * @returns The definition.
 */
async function loadDefinition(): Promise<GameDefinition> {
  return (await import('./game')).default;
}

/**
 * Build the client guest: the game's `client` systems, on this page.
 *
 * @param host The host services the guest imports.
 * @param definition The game, run as-is in direct mode.
 * @returns The sandbox.
 */
async function makeSandbox(host: HostApi, definition: GameDefinition): Promise<Sandbox> {
  if (import.meta.env.GAMEABLE_MODE === 'wasm') {
    const base = new URL(import.meta.env.GAMEABLE_GUEST_URL, location.href);
    return createSandbox({
      mode: 'wasm',
      guestModuleUrl: base.href,
      getCoreModule: (path) => WebAssembly.compileStreaming(fetch(new URL(path, base).href)),
      host,
    });
  }
  // Direct mode: the same TypeScript, run in this realm through the same SDK
  // runtime. No build step, and the parity test keeps the two honest.
  return createSandbox({ mode: 'direct', game: definition, host });
}

/**
 * Boot everything.
 *
 * @returns Resolves once the loop is running.
 */
async function main(): Promise<void> {
  const inputModule = input({ pointerLock: true, target: canvas });
  // No physics on the page: a client never steps it. The authority's Jolt
  // world (in this page when solo, on the room server online) is the only one.
  const modules = [inputModule, audio(), splat()];
  // `createEngine` needs its module list up front and the game module needs the
  // booted engine, so the slot books the place and is filled in below.
  const slot = createGameSlot();
  const definition = await loadDefinition();
  // Only a solo page loads the in-page authority (`src/solo.ts`).
  const room = await chooseRoom(roomMode(query), {
    game: GAME_NAME,
    name: 'You',
    startSolo: async () => (await import('./solo')).playSolo(definition, seed, showWarning),
  });
  const loaded = await resolveFeatures(featuresOf(definition), pageFeatures(room));

  const engine = await createEngine({
    canvas,
    manifest: buildManifest(),
    modules: [...modules, ...loaded.flatMap((feature) => feature.modules), slot.module],
    fixedHz: 60,
    renderer: { backend: 'auto' },
    debug: import.meta.env.DEV,
  });
  booted = engine;

  // The placeholder meshes are lit; the splat is not. One key light and a sky
  // fill is all this scene needs.
  const sky = new HemisphereLight(0xbfd4ff, 0x30302c, 1.4);
  const sun = new DirectionalLight(0xfff3e0, 2.1);
  sun.position.set(6, 12, 4);
  engine.scene.add(sky, sun);

  await engine.assets.load('env.arena');
  engine.get('splat').add('env.arena');

  // The character stack is the optional half of `gameable/host`: the game
  // declares `features.characters`, and the page loads it only then.
  const bound = await bindFeatures(loaded, engine);
  const characters = bound.get('characters') as CharacterBridge | undefined;

  const adapter = createEngineAdapter(engine, { modules, characters });
  const host = createEngineHost(engine, adapter, { seed });
  const sandbox = await makeSandbox(host, definition);
  // The client loop (attaching it starts the join, now that the page has
  // loaded), Play Solo's authority on this page's frames, and the badge: the
  // room code, a copy-link button, and why a join failed.
  const net = engine.get('net');
  await attachRoomClient({
    engine,
    net,
    adapter,
    sandbox,
    slot,
    room,
    loop: { seed, entityBase: definition.world?.maxEntities ?? DEFAULT_MAX_ENTITIES },
    onDead: (error) => {
      crash(error ?? new Error('the client loop stopped'));
    },
    // "Browse rooms": the public rooms of this game; the rooms client loads when it opens.
    badge: { browse: { game: GAME_NAME, list: listPublicRooms } },
  });
  if (query.get('test') === '1') installTestHooks(net);

  canvas.addEventListener('click', () => {
    inputModule.service?.requestPointerLock();
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
