/**
 * Test doubles for Play Solo. Not exported from the package.
 *
 * `standInGuest` is a transpiled-guest stand-in: a JavaScript module with the
 * `instantiate` export `jco transpile` emits, whose game makes an empty world.
 * It goes through `createSandbox({ mode: 'wasm' })` exactly as a real
 * component does, so the authority's lifecycle is testable in the root suite
 * without a componentize build. The real tiny-game component is exercised by
 * `tests/boundary/solo.test.ts`.
 */
import type { WasmGuest } from '../server/room/createEngineRoomGame.js';

const STAND_IN = `
const camera = {
  mode: 'first-person', projection: 'perspective',
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  target: undefined, fovYDeg: 75, near: 0.1, far: 1000, follow: undefined,
  armLength: 0, offset: { x: 0, y: 0, z: 0 },
};
export async function instantiate() {
  let ticks = 0;
  return { 'gameable:engine/game@0.2.0': {
    init() {},
    tick() {
      ticks += 1;
      if (TRAP_AFTER >= 0 && ticks > TRAP_AFTER) throw new Error('trap');
      return { transforms: new Float32Array(0), commands: [], localCommands: [], camera, hud: undefined };
    },
    shutdown() {},
    snapshot() { return new Uint8Array(0); },
    restore() {},
  } };
}`;

/**
 * @param trapAfter Ticks before the stand-in's `tick` throws; default never.
 * @returns A wasm-mode guest whose game is an empty world.
 */
export function standInGuest(trapAfter = -1): WasmGuest {
  const source = STAND_IN.replaceAll('TRAP_AFTER', String(trapAfter));
  return {
    guestModuleUrl: `data:text/javascript,${encodeURIComponent(source)}`,
    getCoreModule: (): Promise<WebAssembly.Module> =>
      Promise.reject(new Error('the stand-in has no core modules')),
  };
}

/**
 * @param ms How long the macrotask waits.
 * @returns A promise that settles after pending microtasks and one macrotask.
 */
export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @returns A wasm-mode guest that runs the tiny game (see `tinyStandIn.ts`). */
export function tinyStandInGuest(): WasmGuest {
  return {
    guestModuleUrl: new URL('./tinyStandIn.ts', import.meta.url).href,
    getCoreModule: (): Promise<WebAssembly.Module> =>
      Promise.reject(new Error('the stand-in has no core modules')),
  };
}
