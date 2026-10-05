/**
 * Where the game runs on this page: the sandbox, direct or wasm.
 *
 * Two sandbox modes share one code path, which is the whole point of the
 * design: `import.meta.env.GAMEABLE_MODE` is `direct` under `npm run dev`, where
 * the game's TypeScript is imported and run as-is, and `wasm` after
 * `npm run build`, where the same TypeScript has been compiled to a
 * WebAssembly component. If the two ever behave differently, that is an
 * engine bug, not a configuration difference.
 */
import type { GameDefinition, HostApi } from 'gameable';
import { createSandbox, type Sandbox } from 'gameable/host';

/** A wasm guest, as `createSandbox` and Play Solo's authority load it. */
export interface WasmGuestUrls {
  /** The transpiled guest's module URL. */
  guestModuleUrl: string;
  /** Compiles one of its core modules. */
  getCoreModule: (path: string) => Promise<WebAssembly.Module>;
}

/**
 * The game built to wasm, where the plugin serves it (`dist/guest/` after a
 * build; `build/guest/` under `npm run dev`, once `npm run build:guest` ran).
 *
 * @returns The guest's module URL and its core-module loader.
 */
export function wasmGuest(): WasmGuestUrls {
  const base = new URL(import.meta.env.GAMEABLE_GUEST_URL, location.href);
  return {
    guestModuleUrl: base.href,
    getCoreModule: (path) => WebAssembly.compileStreaming(fetch(new URL(path, base).href)),
  };
}

/**
 * Build the sandbox the game runs in.
 *
 * @param host The host services the guest imports.
 * @param definition The game, run as-is in direct mode.
 * @returns The sandbox.
 */
export async function makeSandbox(host: HostApi, definition: GameDefinition): Promise<Sandbox> {
  if (import.meta.env.GAMEABLE_MODE === 'wasm') {
    return createSandbox({ mode: 'wasm', ...wasmGuest(), host });
  }
  // Direct mode: the same TypeScript, run in this realm through the same SDK
  // runtime. No build step, and the parity test keeps the two honest.
  return createSandbox({ mode: 'direct', game: definition, host });
}
