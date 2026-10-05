/**
 * The host: everything that is not the game. You should rarely need to touch
 * this file; what the character does, and when, lives in `src/game.ts`.
 *
 * In order: read the exporter's inputs (`src/visit.ts`), pick the phone load
 * when this is a phone, boot the engine with the character package and the
 * place, build the stage (`src/stage.ts`), wire talking (`src/talk.ts`) and
 * the touch controls (`src/controls.ts`), run the game, and tell it what it
 * needs to know as short status lines (the table at the top of `game.ts`).
 */
import { parseManifest } from 'gameable/assets';
import { audio } from 'gameable/audio';
import { bindFeatures, createEngine, resolveFeatures } from 'gameable/core';
import { input } from 'gameable/input';
import { physics as physicsModule, type PhysicsService } from 'gameable/physics';
import { featuresOf, type GameDefinition, type HostApi } from 'gameable';
import { splat } from 'gameable/splat';
import {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createHostLoop,
  createSandbox,
  type HudRenderer,
  type Sandbox,
} from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';
import { clientFeatures } from 'gameable/host/features';
import sampleUrl from 'gameable/assets/aosrig_v0.glb?url';
import joltWasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';
import { Vector3 } from 'three/webgpu';
import { attachControls } from './controls';
import { floorBody, placeStage, whiteWorld, type Stage } from './stage';
import { CHARACTER, createTalk } from './talk';
import { createUi } from './ui';
import { applyBadge, loadPlan, loadVisit, wantsLite } from './visit';

declare global {
  interface Window {
    __AOS_READY__?: { mode: string; backend: string };
    __AOS_ERROR__?: string;
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const RETRY = 'visit-load-retry';

/** The tab's one retry flag; a browser that blocks storage gets no retry. */
function retryFlag(write?: '1' | null): string | null {
  try {
    if (write === '1') sessionStorage.setItem(RETRY, '1');
    else if (write === null) sessionStorage.removeItem(RETRY);
    return sessionStorage.getItem(RETRY);
  } catch {
    return '1';
  }
}

/**
 * Count the character package's bytes as they stream, for the progress bar;
 * nothing is downloaded twice. The place streams in behind the character and is not counted.
 */
function countBytes(
  watch: (url: string) => boolean,
  known: number,
  onBytes: (loaded: number, total: number) => void,
): () => void {
  const original = window.fetch.bind(window);
  let loaded = 0;
  // A compressed file's length is not the bytes it becomes: the package's own size stands in for
  // its files when the lookup gives it.
  let total = known;
  window.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(request, init);
    const url =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    if (!watch(new URL(url, location.href).href) || !response.body) return response;
    total +=
      response.headers.get('content-encoding') || known > 0
        ? 0
        : Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        loaded += value.byteLength;
        onBytes(loaded, total);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return () => {
    window.fetch = original;
  };
}

/** The game's definition: direct mode runs it, wasm mode only reads its `features`. */
async function loadDefinition(): Promise<GameDefinition> {
  return (await import('./game')).default;
}

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
  return createSandbox({ mode: 'direct', game: definition, host });
}

async function main(): Promise<void> {
  const { config, error } = await loadVisit();
  // The credit, as the publish lookup says (its words, its link, or hidden); a character's page
  // and a thing's page alike.
  const brand = document.getElementById('brand') as HTMLAnchorElement | null;
  const brandText = document.getElementById('brand-text');
  if (brand && brandText) applyBadge({ link: brand, label: brandText }, config.badge);
  if (config.thing) {
    // A thing (the studio's create-anything): no character, no conversation; it stands on the floor (src/thing.ts)
    const { thingPage } = await import('./thing');
    return thingPage({ ...config, thing: config.thing }, canvas);
  }
  const touch = matchMedia('(pointer: coarse)').matches;
  const lite = wantsLite(config.lite, {
    coarse: touch,
    shortSide: Math.min(innerWidth, innerHeight),
    memoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? 8,
  });
  const plan = loadPlan(config, lite);
  const pkg = plan.first;
  const placeSrc = config.setting ? (lite && config.setting.lite) || config.setting.splat : null;
  const walk = config.mode === 'hangout';
  const ui = createUi(config.name, config.mode, touch);
  if (error) ui.fail(error);
  // A fresh visit gets one retry of a failed load; a reload keeps the count.
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (navigation?.type === 'navigate') retryFlag(null);

  const dirOf = (src: string | null): string => (src ? src.slice(0, src.lastIndexOf('/') + 1) : '');
  const packageDirs = [dirOf(pkg), dirOf(plan.then)].filter((d) => d !== '');
  let ready = false;
  const uncount = countBytes(
    (url) => packageDirs.some((d) => url.startsWith(d)),
    plan.firstBytes ?? 0,
    (loaded, total) => {
      if (total > 0 && !ready) ui.progress(Math.min(0.99, loaded / total));
    },
  );

  const manifest = parseManifest({
    version: 1,
    assets: [
      pkg
        ? {
            id: 'char.visit',
            type: 'character',
            src: pkg,
            tags: ['character'],
            rig: { backend: 'aosrig-splat' },
          }
        : {
            id: 'char.visit',
            type: 'character',
            src: sampleUrl,
            tags: ['character'],
            rig: { backend: 'skinned' },
          },
      ...(placeSrc ? [{ id: 'place', type: 'splat' as const, src: placeSrc }] : []),
    ],
  });
  const modules = [
    input({ target: canvas }),
    splat(),
    audio(),
    ...(walk ? [physicsModule({ gravity: [0, -9.81, 0], wasmUrl: joltWasmUrl })] : []),
  ];
  const slot = createGameSlot();
  const definition = await loadDefinition();
  const loaded = await resolveFeatures(
    featuresOf(definition),
    clientFeatures({
      characters: {
        // A phone loads the character alone: no pose corrections with the full package. The lighter copy
        // (the level package) keeps its own shoulder fix: its buffers are a third of the full package's and
        // the correction adds under 1 MB. The mouth interior stays off.
        // A computer draws the lighter copy first and keeps its head and skeleton for the full one.
        extras: {
          mouth: false,
          corrective: !lite || (config.level !== null && pkg === config.level),
          keepSharedFiles: plan.then !== null,
        },
        // An optional part a package does not carry is normal: never a reason to reload.
        warn: () => undefined,
        onLoadFailed: ({ message }) => {
          if (characters?.entryOf(CHARACTER)?.ready) return;
          if (retryFlag() !== '1' && retryFlag('1') === '1') {
            location.reload();
            return;
          }
          ui.fail(
            `${config.name} could not be loaded (${message.slice(0, 80)}). Check the connection and reload.`,
          );
          // Talking still works: the game opens it once the character is "shown", here straight away.
          talk.tell('ready:1.6');
          ui.characterReady();
        },
        // The game's `character.say` (the greeting): a line in the chat.
        speech: { say: (_entity, text) => ui.say(text), stop: () => undefined },
      },
    }),
  );
  const engine = await createEngine({
    canvas,
    manifest,
    // 'auto': a browser without WebGPU still gets the page and the conversation.
    renderer: { backend: 'auto', antialias: false },
    modules: [...modules, ...loaded.flatMap((feature) => feature.modules), slot.module],
  });
  const webgpu = engine.ctx.caps.webgpu;
  const physics: PhysicsService | null = walk ? engine.get('physics') : null;

  let stage: Stage | null = null;
  if (config.setting) {
    const setting = config.setting;
    void placeStage(engine, { ...setting, splat: placeSrc ?? setting.splat }, physics)
      .then((s) => {
        stage = s;
      })
      .catch((e: unknown) =>
        ui.fail(`The place did not load (${e instanceof Error ? e.message : String(e)}).`),
      );
  } else {
    stage = whiteWorld(engine);
    if (physics) floorBody(physics);
  }

  const bound = await bindFeatures(loaded, engine);
  const characters = bound.get('characters') as CharacterBridge | undefined;
  if (!characters) throw new Error('visit needs features.characters');
  // The white world (no place): the contact level alone, a soft pool under each foot and never a
  // cast shape thrown to one side ("nothing there"). A place keeps the level the device picks.
  if (!config.setting) characters.shadows?.setQuality('contact');

  const talk = createTalk(engine, characters, ui, config);
  // The game's HUD model is words for this page, not an overlay: keep it and read it each
  // frame. (`hud: false` would drop it: the adapter then has no model at all.)
  let hudModel: { near?: number } | null = null;
  const hud: HudRenderer = {
    element: document.createElement('div'),
    get model() {
      return hudModel as HudRenderer['model'];
    },
    set(json) {
      if (json !== undefined) hudModel = JSON.parse(json) as { near?: number };
      return false;
    },
    clear: () => (hudModel = null),
    dispose: () => undefined,
  };
  const adapter = createEngineAdapter(engine, {
    modules,
    characters,
    placeholders: 'never',
    hud,
    conversation: (command) => talk.command(command),
  });
  talk.bind((event) => adapter.events.push(event));
  const host = createEngineHost(engine, adapter, { seed: 1 });
  const sandbox = await makeSandbox(host, definition);
  await slot.attach(createHostLoop(engine, sandbox, adapter, { seed: 1 }), engine.ctx);

  // What the game needs to know before anything else.
  talk.tell(`setup:${config.mode},${config.view},${config.setting ? 1 : 0}`);
  if (config.greeting) talk.tell(`greeting:${config.greeting}`);
  // The screen's shape, and how much of it the talk panel and the name card cover, so the
  // game frames the character in what is left.
  const aspect = (): void => {
    const h = Math.max(1, innerHeight);
    const panel = document.querySelector('.chat')?.getBoundingClientRect();
    const card = document.querySelector('.who')?.getBoundingClientRect();
    const bottom = panel ? (h - panel.top) / h : 0;
    const top = card && card.right > innerWidth * 0.35 ? card.bottom / h : 0.04;
    talk.tell(`aspect:${(innerWidth / h).toFixed(3)},${bottom.toFixed(3)},${top.toFixed(3)}`);
  };
  aspect();
  window.addEventListener('resize', aspect);

  const detach = attachControls(canvas, {
    walk,
    stage: () => stage,
    camera: engine.camera,
    goto: (x, z) => talk.tell(`goto:${x.toFixed(2)},${z.toFixed(2)}`),
  });

  let near: unknown = null;
  let roomSent = false;
  const headAt = new Vector3();
  const offFrame = engine.events.on('engine:frame', ({ frame }) => {
    talk.update();
    ui.frame();
    // The place's walls, once it is in: the game keeps the camera (and walkers) inside them.
    const room = stage?.room;
    if (room && !roomSent) {
      roomSent = true;
      talk.tell(`room:${room.map((n) => n.toFixed(2)).join(',')}`);
    }
    if (hudModel && hudModel.near !== near) {
      near = hudModel.near;
      ui.near(hudModel.near === 1);
    }
    if (ready || frame < 3) return;
    const entry = characters.entryOf(CHARACTER);
    if (!entry?.ready) return;
    ready = true;
    // A computer that drew the lighter copy: the full one loads behind it and takes over between two
    // frames (same skeleton, same pose). If it cannot, the lighter one stays, which is still the character.
    const then = plan.then;
    if (then && characters.upgrade) {
      characters
        .upgrade(CHARACTER, then)
        .catch(() => undefined)
        .finally(uncount);
    } else {
      uncount();
    }
    // the head joint: `Head` on the studio's skeleton, `c_head` on a version 1 rig
    (
      engine.scene.getObjectByName('Head') ?? engine.scene.getObjectByName('c_head')
    )?.getWorldPosition(headAt);
    talk.tell(`clips:${entry.clips.join(',')}`);
    const head = headAt.y > 0.3 ? headAt.y : 1.6;
    talk.tell(`ready:${head.toFixed(3)}`);
    aspect();
    ui.progress(1);
    ui.characterReady();
    window.__AOS_READY__ = {
      mode: import.meta.env.GAMEABLE_MODE,
      backend: webgpu ? 'webgpu' : 'webgl',
    };
  });

  window.addEventListener(
    'pagehide',
    () => {
      offFrame();
      detach();
      talk.dispose();
      ui.dispose();
      void engine.dispose();
    },
    { once: true },
  );
  engine.start();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  window.__AOS_ERROR__ = message;
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.hidden = false;
  }
  console.error(error);
});
