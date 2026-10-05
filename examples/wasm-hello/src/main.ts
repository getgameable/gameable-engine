/**
 * The smallest possible host.
 *
 * A Gameable studio splat character, a camera, a one-entry manifest,
 * and the three calls that put a game module behind the wasm boundary —
 * `createEngineAdapter`, `createEngineHost`, `createHostLoop`. The fourth call,
 * `createCharacterBridge`, is what turns the guest's `spawn-character` into a
 * person standing in front of the camera.
 *
 * `?mode=` on the URL is only a label; which sandbox is built is decided at
 * build time by `gameable/vite` and read from
 * `import.meta.env.GAMEABLE_MODE`. `npm run dev` gives you `direct`;
 * `npm run build` gives you `wasm`. The same `src/game.ts` runs either way.
 */
import { parseManifest } from 'gameable/assets';
import { audio } from 'gameable/audio';
import { createEngine } from 'gameable/core';
import { input } from 'gameable/input';
import type { HostApi } from 'gameable';
import { splat } from 'gameable/splat';
import {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createHostLoop,
  createSandbox,
  type Sandbox,
} from 'gameable/host';
import { Color } from 'three/webgpu';
import { createUi } from './ui';
import { createTalkHost } from './talk';
import { readConfig } from './config';

declare global {
  interface Window {
    /** Set once the first frames have been drawn, for the e2e suite. */
    __AOS_READY__?: { mode: string; backend: string };
    /** Anything that went wrong, so a failure is a message and not a blank canvas. */
    __AOS_ERROR__?: string;
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLElement;
const ui = createUi();

/** Report startup and asynchronous character-loading failures in the page. */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  window.__AOS_ERROR__ = message;
  status.textContent = message;
  status.classList.add('gm-error');
  console.error(error);
}

/**
 * Build the sandbox for whichever mode this bundle was built for.
 *
 * @param host The host services the guest imports.
 * @returns The sandbox.
 */
async function makeSandbox(host: HostApi): Promise<Sandbox> {
  if (import.meta.env.GAMEABLE_MODE === 'wasm') {
    const base = new URL(import.meta.env.GAMEABLE_GUEST_URL, location.href);
    return createSandbox({
      mode: 'wasm',
      guestModuleUrl: base.href,
      getCoreModule: (path) => WebAssembly.compileStreaming(fetch(new URL(path, base).href)),
      host,
    });
  }
  const loaded = await import('./game');
  return createSandbox({ mode: 'direct', game: loaded.default, host });
}

/**
 * Boot the engine and start the loop.
 *
 * @returns Resolves once the loop is running.
 */
async function main(): Promise<void> {
  const modules = [input({ target: canvas }), splat(), audio()];
  const slot = createGameSlot();

  // Vite copies public/ into the build. BASE_URL also supports /play/wasm-hello/.
  // The guest sees only char.greeter; the descriptor resolves its sibling files.
  // A host may point ?character= at any exported character (see ./config).
  const config = readConfig();
  const manifest = parseManifest({
    version: 1,
    assets: [
      {
        id: 'char.greeter',
        type: 'character',
        src: config.character,
        tags: ['character'],
        rig: { backend: 'aosrig-splat' },
      },
    ],
  });

  const engine = await createEngine({
    canvas,
    manifest,
    renderer: { backend: 'webgpu', antialias: false },
    modules: [...modules, slot.module],
  });
  if (!engine.ctx.caps.webgpu) {
    await engine.dispose();
    throw new Error(
      'This Gameable character needs WebGPU. Open the example in a WebGPU-enabled browser.',
    );
  }
  engine.scene.background = new Color(
    getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
  );

  const { createCharacterBridge } = await import('gameable/host/characters');
  const characters = createCharacterBridge({
    engine,
    renderer: engine.renderer,
    scene: engine.scene,
    warn: (message) =>
      fail(
        `${message}. Import the complete Gameable studio export with npm run import:character -w examples/wasm-hello -- /path/to/extracted-character, then reload.`,
      ),
  });

  // `placeholders: 'always'` stays on. The bridge hides the box the moment the
  // rig is drawing. Loading errors are also surfaced in the status card.
  const talk = createTalkHost(engine, characters, ui, config);
  const adapter = createEngineAdapter(engine, {
    modules,
    characters,
    placeholders: 'always',
    hud: false,
    conversation: (command) => talk.command(command),
  });
  talk.bind((event) => adapter.events.push(event));
  const host = createEngineHost(engine, adapter, { seed: 1 });
  const sandbox = await makeSandbox(host);
  await slot.attach(createHostLoop(engine, sandbox, adapter, { seed: 1 }), engine.ctx);

  if (!window.__AOS_ERROR__) status.textContent = 'Loading your Gameable character…';

  let ready = false;
  const offFrame = engine.events.on('engine:frame', ({ frame }) => {
    talk.update();
    ui.frame(performance.now());
    if (ready || window.__AOS_ERROR__) return;
    if (frame < 3 || !characters.entryOf(1)?.ready) return;
    status.textContent = 'Gameable character';
    ready = true;
    ui.characterReady();
    window.__AOS_READY__ = {
      mode: import.meta.env.GAMEABLE_MODE,
      backend: engine.ctx.caps.webgpu ? 'webgpu' : 'webgl',
    };
  });

  window.addEventListener(
    'pagehide',
    () => {
      offFrame();
      talk.dispose();
      ui.dispose();
      void engine.dispose();
    },
    { once: true },
  );

  engine.start();
}

void main().catch(fail);
