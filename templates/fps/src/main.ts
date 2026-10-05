/**
 * The host: everything that is not the game.
 *
 * It boots the engine, registers the host modules, loads the arena and its
 * collider, creates the sandbox the game runs in, and gets out of the way.
 * You should rarely need to touch this file — gameplay lives in
 * `src/game.ts`.
 *
 * Two sandbox modes share one code path, which is the whole point of the
 * design: `import.meta.env.GAMEABLE_MODE` is `direct` under `npm run dev`, where
 * the game's TypeScript is imported and run as-is, and `wasm` after
 * `npm run build`, where the same TypeScript has been compiled to a
 * WebAssembly component. If the two ever behave differently, that is an
 * engine bug, not a configuration difference.
 */
import { parseManifest, type AssetManifest } from 'gameable/assets';
import { parseCollider } from 'gameable/placeholder';
import { audio } from 'gameable/audio';
import { bindFeatures, createEngine, resolveFeatures, type Engine } from 'gameable/core';
import { input } from 'gameable/input';
import { loadJolt, meshShapeFromGeometry, physics, type PhysicsService } from 'gameable/physics';
import { featuresOf, type GameDefinition, type HostApi } from 'gameable';
import { splat } from 'gameable/splat';
import {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createHostLoop,
  createSandbox,
  type EngineAdapterHandle,
  type Sandbox,
} from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { clientFeatures } from 'gameable/host/features';
import { DirectionalLight, HemisphereLight } from 'three/webgpu';

import manifestDocument from './assets.json';

// The placeholder pack ships inside `gameable/placeholder`. `?url`
// hands the bundler the file, so it is copied into `dist/` with a hashed name
// — the one thing a bare path in `assets.json` cannot do for you.
import arenaUrl from 'gameable/assets/arena.spz?url';
import colliderUrl from 'gameable/assets/arena.collider.bin?url';
import hitUrl from 'gameable/assets/hit.wav?url';
import pickupUrl from 'gameable/assets/pickup.wav?url';
import shotUrl from 'gameable/assets/shot.wav?url';
import stepUrl from 'gameable/assets/step.wav?url';
// The enemies, the same way: one 3.1 MB skinned GLB with idle, walk, run and
// wave inside it, loaded once and cloned six times.
import aosrigUrl from 'gameable/assets/aosrig_v0.glb?url';
import joltWasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';

/** `@placeholder/<file>` in `src/assets.json` resolves through this table. */
const PLACEHOLDER_URLS: Readonly<Record<string, string>> = {
  'arena.spz': arenaUrl,
  'arena.collider.bin': colliderUrl,
  'hit.wav': hitUrl,
  'pickup.wav': pickupUrl,
  'shot.wav': shotUrl,
  'step.wav': stepUrl,
};

/** `@aosrig/<file>` in `src/assets.json` resolves through this table. */
const AOSRIG_URLS: Readonly<Record<string, string>> = {
  'aosrig_v0.glb': aosrigUrl,
};

/** The `src` prefixes `buildManifest` rewrites, and what each resolves through. */
const PACKAGED_ASSETS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['@placeholder/', PLACEHOLDER_URLS],
  ['@aosrig/', AOSRIG_URLS],
];

/** Highest entity id `__AOS_TEST__.characters()` scans. This game spawns ten. */
const MAX_REPORTED_ENTITY = 64;

/** Body id for the arena's static collision mesh; the guest mints from 1 up. */
const ENVIRONMENT_BODY = 1_000_000;

/** `staticGeometry` is bit 1 of the WIT `collision-layers` flags. */
const LAYER_STATIC_GEOMETRY = 1 << 1;

/** What the test hook exposes, when `?test=1` is on the URL. */
export interface TestHooks {
  /**
   * Hold a key down, by DOM `code`.
   *
   * @param code A DOM key code such as `KeyW`.
   */
  press(code: string): void;
  /**
   * Let a key up.
   *
   * @param code A DOM key code.
   */
  release(code: string): void;
  /**
   * Hold a mouse button down.
   *
   * @param button DOM button index; 0 is the left button.
   */
  mouseDown(button?: number): void;
  /**
   * Let a mouse button up.
   *
   * @param button DOM button index.
   */
  mouseUp(button?: number): void;
  /**
   * Wait for `n` fixed simulation steps.
   *
   * Steps, not rendered frames: a headless browser with vsync disabled runs
   * `requestAnimationFrame` at several hundred hertz, so counting frames would
   * measure the machine rather than the game.
   *
   * @param n How many simulation steps to wait for.
   * @returns Resolves once the simulation has advanced that far.
   */
  tick(n: number): Promise<void>;
  /**
   * The HUD model currently on screen.
   *
   * @returns Whatever the guest last sent.
   */
  hud(): unknown;
  /**
   * The engine camera's world position.
   *
   * @returns The position.
   */
  camera(): { x: number; y: number; z: number };
  /**
   * What the character bridge is drawing, for every entity that has a
   * character: the six enemies.
   *
   * @returns One plain record per live character, safe to send over the
   *   Playwright boundary.
   */
  characters(): CharacterReport[];
}

/** One live character, flattened for the end-to-end suite. */
export interface CharacterReport {
  /** Entity id. */
  entity: number;
  /** Manifest id of the bundle. */
  bundleId: string;
  /** Which renderer the character ended up on. */
  kind: string;
  /** True once the rig is drawing. */
  ready: boolean;
  /** Every clip the rig registered, by name. Empty until it is ready. */
  clips: string[];
  /** The guest's own AI state name. */
  state: string;
}

declare global {
  interface Window {
    /** Set once the first frames have been drawn. The e2e suite waits on it. */
    __AOS_READY__?: { mode: string; backend: string; characters: string };
    /** Anything that went wrong, so a failure is a message and not a black canvas. */
    __AOS_ERROR__?: string;
    /** Synthetic input, exposed only with `?test=1`. */
    __AOS_TEST__?: TestHooks;
  }
}

/** The features this page can load; the game's `features` pick from them. */
const FEATURES = clientFeatures();

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('error') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const query = new URLSearchParams(location.search);
const testMode = query.get('test') === '1';
const seed = Number(query.get('seed') ?? 0x5eed1234);

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

window.addEventListener('error', (event) => {
  fail(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  fail(event.reason);
});

/** The manifest as it is written on disk, before the URLs are filled in. */
interface RawManifest {
  version: 1;
  baseUrl?: string;
  assets: { src: string; collider?: { src?: string } }[];
}

/**
 * Rewrite `@placeholder/...` and `@aosrig/...` sources onto the URLs the
 * bundler minted.
 *
 * Everything else is left alone: drop your own files in `public/` and write
 * their path — `"/models/rifle.glb"` — straight into `src/assets.json`.
 *
 * @returns The manifest, validated.
 */
function buildManifest(): AssetManifest {
  const raw = manifestDocument as unknown as RawManifest;

  /**
   * Resolve one `src`.
   *
   * @param src The manifest `src`.
   * @returns A URL the browser can fetch.
   */
  const resolve = (src: string): string => {
    for (const [prefix, table] of PACKAGED_ASSETS) {
      if (!src.startsWith(prefix)) continue;
      const file = src.slice(prefix.length);
      const url = table[file];
      if (url === undefined) throw new Error(`unknown packaged asset "${src}"`);
      return url;
    }
    return src;
  };

  // Rebuilt field by field rather than spread, because `parseManifest` rejects
  // any key it does not know: add a `$schema` for editor completion and a
  // spread would hand it straight to the validator.
  return parseManifest({
    version: raw.version,
    baseUrl: raw.baseUrl ?? '/',
    assets: raw.assets.map((entry) => ({
      ...entry,
      src: resolve(entry.src),
      collider:
        entry.collider?.src === undefined
          ? entry.collider
          : { ...entry.collider, src: resolve(entry.collider.src) },
    })),
  });
}

/**
 * Load the arena's collision mesh and give it to the physics world.
 *
 * A splat is scenery — there is no geometry in it a solver can use — so the
 * arena ships a baked triangle mesh alongside it. One static body, built once.
 *
 * @param world The physics service.
 * @returns Resolves once the body is in the world.
 */
async function addEnvironmentCollider(world: PhysicsService): Promise<void> {
  const response = await fetch(colliderUrl);
  if (!response.ok) throw new Error(`collider ${colliderUrl}: HTTP ${String(response.status)}`);
  const mesh = parseCollider(await response.arrayBuffer());
  const jolt = await loadJolt({ wasmUrl: joltWasmUrl });
  const shape = meshShapeFromGeometry(jolt, mesh.positions, mesh.indices);
  world.addBody({
    id: ENVIRONMENT_BODY,
    shape: 'mesh',
    dims: [],
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: LAYER_STATIC_GEOMETRY,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
    geometry: shape,
  });
  // The world took its own reference; ours is done with it.
  shape.Release();
}

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
 * Build the sandbox the game runs in.
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
 * Expose synthetic input, so the end-to-end suite can play the game.
 *
 * Pointer lock needs a user gesture a headless browser cannot produce, so the
 * hooks dispatch the very same DOM events the input module listens for rather
 * than reaching inside it: what the test drives is what a player drives.
 *
 * @param adapter The engine adapter, for the HUD model.
 * @param engine The booted engine, for the camera.
 * @param characters The character bridge, for what is actually drawing.
 * @returns Nothing.
 */
function installTestHooks(
  adapter: EngineAdapterHandle,
  engine: Engine,
  characters: CharacterBridge,
): void {
  /** Give up on a `tick` that the loop can never satisfy, in milliseconds. */
  const TICK_TIMEOUT_MS = 30_000;

  /**
   * Wait for `n` fixed simulation steps.
   *
   * @param n How many steps.
   * @returns Resolves once `time.elapsed` has advanced by `n * fixedDt`.
   */
  const tick = (n: number): Promise<void> =>
    new Promise((done) => {
      const { time, config } = engine.ctx;
      // A hair under, because `elapsed` accumulates in f64 and the comparison
      // must not need an exact landing.
      const target = time.elapsed + Math.max(1, n) * config.fixedDt - config.fixedDt * 0.001;
      const deadline = performance.now() + TICK_TIMEOUT_MS;
      /** One animation frame. */
      const step = (): void => {
        if (time.elapsed >= target || performance.now() > deadline) done();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

  window.__AOS_TEST__ = {
    press: (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    },
    release: (code) => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    },
    mouseDown: (button = 0) => {
      canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    },
    mouseUp: (button = 0) => {
      canvas.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
    },
    tick,
    hud: () => adapter.hudModel,
    camera: () => ({
      x: engine.camera.position.x,
      y: engine.camera.position.y,
      z: engine.camera.position.z,
    }),
    characters: () => {
      const out: CharacterReport[] = [];
      // The bridge is keyed by entity and this template never spawns more than
      // a handful, so a scan is cheaper than an enumeration API nothing else
      // would use.
      for (let entity = 1; entity <= MAX_REPORTED_ENTITY; entity += 1) {
        const entry = characters.entryOf(entity);
        if (entry === null) continue;
        out.push({
          entity,
          bundleId: entry.bundleId,
          kind: entry.kind,
          ready: entry.ready,
          clips: [...entry.clips],
          state: entry.state,
        });
      }
      return out;
    },
  };
}

/**
 * Boot everything.
 *
 * @returns Resolves once the loop is running.
 */
async function main(): Promise<void> {
  const inputModule = input({ pointerLock: !testMode, target: canvas });
  const modules = [
    physics({ gravity: [0, -9.81, 0], wasmUrl: joltWasmUrl }),
    inputModule,
    audio(),
    splat(),
  ];
  // `createEngine` needs its module list up front and the game module needs the
  // booted engine, so the slot books the place and is filled in below.
  const slot = createGameSlot();
  const definition = await loadDefinition();
  const loaded = await resolveFeatures(featuresOf(definition), FEATURES);

  const engine = await createEngine({
    canvas,
    manifest: buildManifest(),
    modules: [...modules, ...loaded.flatMap((feature) => feature.modules), slot.module],
    fixedHz: 60,
    renderer: { backend: 'auto' },
    debug: import.meta.env.DEV,
  });

  // The placeholder meshes are lit; the splat is not. One key light and a sky
  // fill is all this scene needs.
  const sky = new HemisphereLight(0xbfd4ff, 0x30302c, 1.4);
  const sun = new DirectionalLight(0xfff3e0, 2.1);
  sun.position.set(6, 12, 4);
  engine.scene.add(sky, sun);

  await engine.assets.load('env.arena');
  engine.get('splat').add('env.arena');
  await addEnvironmentCollider(engine.get('physics'));

  // The character stack is the optional half of `gameable/host`: the game
  // declares `features.characters`, and the page loads it only then.
  const bound = await bindFeatures(loaded, engine);
  const characters = bound.get('characters') as CharacterBridge | undefined;

  const adapter = createEngineAdapter(engine, { modules, characters });
  const host = createEngineHost(engine, adapter, { seed });
  const sandbox = await makeSandbox(host, definition);
  await slot.attach(createHostLoop(engine, sandbox, adapter, { seed }), engine.ctx);

  canvas.addEventListener('click', () => {
    inputModule.service?.requestPointerLock();
    hint.classList.add('hidden');
  });

  if (testMode && characters) installTestHooks(adapter, engine, characters);

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

void main().catch(fail);
