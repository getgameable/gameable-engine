/**
 * The host: everything that is not the game.
 *
 * It boots the engine, registers the host modules, loads the arena and its
 * collider, creates the sandbox the game runs in, and gets out of the way.
 * You should rarely need to touch this file — gameplay lives in
 * `src/game.ts`.
 *
 * When `src/game.ts` declares `features.multiplayer`, the page is a room's
 * client instead (`src/online.ts`, loaded only then): no physics here, the
 * client loop shows the authority's world, and `?room=` picks the room. With
 * no `?room=` it plays solo, the authority running in this page. See
 * `docs/recipes/play-with-friends.md`. With `features.multiplayer.predict`
 * the page keeps a physics world after all, holding only the arena's
 * collider and this player's own character body, which it predicts.
 *
 * The sandbox is direct under `npm run dev` and wasm after `npm run build`
 * (`src/sandbox.ts`); the two must behave the same.
 */
import { audio } from 'gameable/audio';
import { bindFeatures, createEngine, resolveFeatures, type Engine } from 'gameable/core';
import { input } from 'gameable/input';
import { leaveRoom } from 'gameable/net/page';
import { physics } from 'gameable/physics';
import { featuresOf, type GameDefinition } from 'gameable';
import { splat } from 'gameable/splat';
import {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createHostLoop,
} from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { DirectionalLight, HemisphereLight } from 'three/webgpu';

import { addEnvironmentCollider, buildManifest, joltWasmUrl } from './hostAssets';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { makeSandbox } from './sandbox';
import { multiplayerOn, pageFeatures, pageModules, predictOn } from './session';
import { HERO, installTestHooks } from './testHooks';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('error') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const warning = document.getElementById('warn') as HTMLElement;
const query = new URLSearchParams(location.search);
const testMode = query.get('test') === '1';
const seed = Number(query.get('seed') ?? 0x5eed1234);
/**
 * `?gnm=1` swaps the guide's skinned head for a real GNM splat head.
 *
 * Off by default because that head is a 7.8 MB baked rig pack that is not in
 * this repository — see "Give the guide a face" in README.md. With it off the
 * guide is the same skinned character as everybody else.
 */
const gnmMode = query.get('gnm') === '1';

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
 * Boot everything.
 *
 * @returns Resolves once the loop is running.
 */
async function main(): Promise<void> {
  const definition = await loadDefinition();
  const online = multiplayerOn(definition);
  const predict = online && predictOn(definition);
  const inputModule = input({ pointerLock: !testMode, target: canvas });
  const modules = pageModules(
    online,
    {
      physics: () => physics({ ...PHYSICS_OPTIONS, wasmUrl: joltWasmUrl }),
      others: [inputModule, audio(), splat()],
    },
    predict,
  );
  // `createEngine` needs its module list up front and the game module needs the
  // booted engine, so the slot books the place and is filled in below.
  const slot = createGameSlot();
  const onlineBoot = online ? await import('./online') : null;
  const room = onlineBoot ? await onlineBoot.chooseOnlineRoom(definition, seed, showWarning) : null;
  const loaded = await resolveFeatures(featuresOf(definition), pageFeatures(room?.multiplayer));

  const engine = await createEngine({
    canvas,
    manifest: buildManifest(gnmMode),
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
  // A room's client has no physics world (the authority owns the collider),
  // unless it predicts: then the collider is the only static body in its own.
  if (!online || predict) await addEnvironmentCollider(engine.get('physics'));

  // The character stack is the optional half of `gameable/host`: the game
  // declares `features.characters`, and the page loads it only then.
  const bound = await bindFeatures(loaded, engine);
  const characters = bound.get('characters') as CharacterBridge | undefined;

  const adapter = createEngineAdapter(engine, { modules, characters });
  const host = createEngineHost(engine, adapter, { seed });
  const sandbox = await makeSandbox(host, definition);
  const hero =
    onlineBoot && room
      ? await onlineBoot.attachOnline(room, {
          engine,
          adapter,
          sandbox,
          slot,
          definition,
          seed,
          predict,
          fail: crash,
        })
      : null;
  if (hero === null)
    await slot.attach(createHostLoop(engine, sandbox, adapter, { seed }), engine.ctx);

  canvas.addEventListener('click', () => {
    inputModule.service?.requestPointerLock();
    hint.classList.add('hidden');
  });

  if (testMode && characters) installTestHooks(adapter, engine, characters, hero ?? (() => HERO));

  const offReady = engine.events.on('engine:frame', ({ frame }) => {
    if (frame < 3) return;
    window.__AOS_READY__ = {
      mode: import.meta.env.GAMEABLE_MODE,
      backend: engine.ctx.caps.webgpu ? 'webgpu' : 'webgl',
      characters: characters ? (gnmMode ? 'gnm' : 'on') : 'off',
    };
    offReady();
  });

  engine.start();
}

void main().catch(crash);
