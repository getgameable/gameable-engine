/**
 * The sandbox: one game module, in one of two modes, behind one interface.
 *
 * `mode: 'wasm'` loads a `jco transpile`d component. `mode: 'direct'` runs the
 * very same SDK runtime in the host's own realm, with no build step — that is
 * what `npm run dev` uses. The two must stay bit-identical; `tests/boundary/`
 * hashes both and fails if they drift.
 *
 * A guest trap **permanently poisons** a component instance: every later call
 * fails with `cannot enter component instance`. The sandbox therefore latches
 * `dead` on the first failure and stops calling in; the host's job is to build
 * a new sandbox, not to retry.
 */
import { createGuest } from '@gameable/sdk';
import type {
  FrameOutput,
  GameDefinition,
  HostApi,
  HostFrameInput,
  HostGameConfig,
} from '@gameable/sdk';
import { quantizeInput } from './abi';
import { gameNamespace } from './guestExport';
import { hostBindings } from './host-bindings';
import { emptyOutput, toError } from './sandboxFailure';
import { minimalWasi, type MinimalWasiOptions } from './wasi-stubs';

/** One loaded game module. */
export interface Sandbox {
  /** How this sandbox runs its guest. */
  readonly mode: 'direct' | 'wasm';
  /** Call once, before the first `tick`. */
  init(config: HostGameConfig): void;
  /** One fixed simulation step. */
  tick(input: HostFrameInput): FrameOutput;
  /** Release guest-side resources. No further calls follow. */
  shutdown(): void;
  /** Serialise the whole guest state. */
  snapshot(): Uint8Array;
  /** Restore a state produced by `snapshot` from the same build. */
  restore(state: Uint8Array): void;
  /**
   * True once the guest has trapped or failed. A dead sandbox returns a safe
   * empty frame forever; rebuild it.
   */
  readonly dead: boolean;
  /** Why the sandbox died, when it did. */
  readonly error: Error | null;
}

/** Run the game's TypeScript directly, in the host realm. */
export interface DirectSandboxOptions {
  mode: 'direct';
  /** The game's `defineGame` result. */
  game: GameDefinition;
  /** Host services the guest imports. */
  host: HostApi;
}

/**
 * The `instantiate` a `jco transpile --instantiation async` module exports.
 *
 * It resolves to the component's exports by name; the host reads only the
 * versioned `gameable:engine/game@0.2.0` one (see `gameNamespace`).
 */
export type Instantiate = (
  getCoreModule: (path: string) => Promise<WebAssembly.Module>,
  imports: Record<string, unknown>,
  instantiateCore: typeof WebAssembly.instantiate,
) => Promise<Record<string, unknown>>;

/** The `game` namespace the component exports. */
export interface GuestNamespace {
  init(config: HostGameConfig): void;
  tick(input: HostFrameInput): FrameOutput;
  shutdown(): void;
  snapshot(): Uint8Array;
  restore(state: Uint8Array): void;
}

/** Load a `jco transpile`d component. */
export interface WasmSandboxOptions {
  mode: 'wasm';
  /**
   * URL of the transpiled `game.js`. Ignored when `instantiate` is given.
   * Dynamically imported, so bundlers see a runtime specifier.
   */
  guestModuleUrl?: string | URL;
  /** The transpiled module's `instantiate`, when it is already imported. */
  instantiate?: Instantiate;
  /** Compile one of the nine core wasm files by its relative path. */
  getCoreModule: (path: string) => Promise<WebAssembly.Module>;
  /** Host services the guest imports. */
  host: HostApi;
  /** WASI stub overrides. */
  wasi?: MinimalWasiOptions;
}

/** Either kind of sandbox. */
export type SandboxOptions = DirectSandboxOptions | WasmSandboxOptions;

/**
 * Wrap a guest namespace so a trap latches `dead` instead of cascading.
 *
 * @param guest The guest's five exports.
 * @param mode Which sandbox this is.
 * @param host Host services, used to log the failure.
 * @returns The sandbox.
 */
function wrap(guest: GuestNamespace, mode: 'direct' | 'wasm', host: HostApi): Sandbox {
  // Direct mode calls the guest in this realm, so nothing rounds the f32
  // fields of `frame-input` for it. Do it here, or the two modes drift.
  const quantize = mode === 'direct';
  let dead = false;
  let error: Error | null = null;
  const fallback = emptyOutput();

  /**
   * Latch the sandbox dead.
   *
   * @param err The thrown value.
   * @param what The call that failed.
   * @returns The error, already logged.
   */
  function die(err: unknown, what: string): Error {
    const wrapped = toError(err, what);
    if (!dead) {
      dead = true;
      error = wrapped;
      host.log('error', `${mode} sandbox is dead: ${wrapped.message}`);
    }
    return wrapped;
  }

  return {
    mode,
    get dead() {
      return dead;
    },
    get error() {
      return error;
    },
    init(config: HostGameConfig): void {
      try {
        guest.init(config);
      } catch (err) {
        throw die(err, 'init');
      }
    },
    tick(input: HostFrameInput): FrameOutput {
      if (dead) return fallback;
      try {
        return guest.tick(quantize ? quantizeInput(input) : input);
      } catch (err) {
        die(err, 'tick');
        return fallback;
      }
    },
    shutdown(): void {
      if (dead) return;
      try {
        guest.shutdown();
      } catch (err) {
        die(err, 'shutdown');
      }
    },
    snapshot(): Uint8Array {
      try {
        return guest.snapshot();
      } catch (err) {
        throw die(err, 'snapshot');
      }
    },
    restore(state: Uint8Array): void {
      try {
        guest.restore(state);
      } catch (err) {
        throw die(err, 'restore');
      }
    },
  };
}

/**
 * Build a direct-mode sandbox, synchronously.
 *
 * @param options The game definition and host services.
 * @returns A sandbox running the SDK runtime in this realm.
 *
 * @example
 * ```ts
 * import { createDirectSandbox } from 'gameable/host';
 *
 * const sandbox = createDirectSandbox({ mode: 'direct', game, host });
 * ```
 */
export function createDirectSandbox(options: DirectSandboxOptions): Sandbox {
  const guest = createGuest(options.host, options.game);
  return wrap(guest, 'direct', options.host);
}

/**
 * Build a sandbox in either mode.
 *
 * @param options Direct or wasm configuration.
 * @returns The sandbox, once the component (if any) is instantiated.
 *
 * @example
 * ```ts
 * import { createSandbox } from 'gameable/host';
 *
 * const sandbox = await createSandbox({
 *   mode: 'wasm',
 *   guestModuleUrl: new URL('./guest/game.js', import.meta.url),
 *   getCoreModule: (p) => fetch(new URL(p, base)).then((r) => WebAssembly.compileStreaming(r)),
 *   host,
 * });
 * ```
 */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  if (options.mode === 'direct') return createDirectSandbox(options);

  let instantiate = options.instantiate;
  if (!instantiate) {
    if (!options.guestModuleUrl) {
      throw new Error('createSandbox({ mode: "wasm" }) needs guestModuleUrl or instantiate');
    }
    const mod = (await import(/* @vite-ignore */ String(options.guestModuleUrl))) as {
      instantiate?: Instantiate;
    };
    if (!mod.instantiate) {
      throw new Error(
        `${String(options.guestModuleUrl)} has no "instantiate" export; transpile with --instantiation async`,
      );
    }
    instantiate = mod.instantiate;
  }

  const imports: Record<string, unknown> = {
    ...minimalWasi(options.wasi),
    ...hostBindings(options.host),
  };
  const root = await instantiate(options.getCoreModule, imports, WebAssembly.instantiate);
  return wrap(gameNamespace(root), 'wasm', options.host);
}
