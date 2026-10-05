/**
 * The end-to-end suite's way in: `window.__AOS_TEST__`, installed with
 * `?test=1`, plus the page's `__AOS_READY__` and `__AOS_ERROR__` globals.
 *
 * Host code, split out of `src/main.ts`.
 */
import type { Engine } from 'gameable/core';
import type { EngineAdapterHandle } from 'gameable/host';
import type { CharacterBridge } from 'gameable/host/characters';

/** The entity the declarative `player` block spawns on a page without multiplayer. */
export const HERO = 1;

/** Highest entity id `__AOS_TEST__.characters()` scans. This game spawns a dozen. */
const MAX_REPORTED_ENTITY = 64;

/** Eye-gaze angles at the tail of a GNM control vector: pitch/yaw per eye. */
const GAZE_CHANNELS = 4;

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
   * Tap a key: down and up across one simulation step.
   *
   * The interact and dialogue systems act on the *press edge*, so a test that
   * only calls `press` and waits gets one action and then a held key.
   *
   * @param code A DOM key code.
   * @returns Resolves once the press and release have both been simulated.
   */
  tap(code: string): Promise<void>;
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
   * The hero's world position, as the host has it.
   *
   * @returns The position.
   */
  hero(): { x: number; y: number; z: number };
  /**
   * What the guest last asked an entity's animation to do.
   *
   * @param entity Entity id; the hero is 1.
   * @returns The recorded intent, or null.
   */
  animation(entity?: number): unknown;
  /**
   * What the character bridge is drawing, for every entity that has a
   * character: the hero and both NPCs.
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
  /** The guest's own locomotion state name. */
  state: string;
  /** Largest absolute value in the expression half of the control vector. */
  expressionPeak: number;
  /** Largest absolute eye-gaze angle, in radians. */
  gazePeak: number;
  /** Largest head/neck aim angle the animator asked the rig for, in radians. */
  aimPeak: number;
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

/**
 * Expose synthetic input, so the end-to-end suite can play the game.
 *
 * Pointer lock needs a user gesture a headless browser cannot produce, so the
 * hooks dispatch the very same DOM events the input module listens for rather
 * than reaching inside it: what the test drives is what a player drives.
 *
 * @param adapter The engine adapter, for the HUD model and the transforms.
 * @param engine The booted engine, for the camera.
 * @param characters The character bridge.
 * @param hero The entity the player controls: {@link HERO}, or the room's
 *   `net.localEntity` on a multiplayer page.
 * @returns Nothing.
 */
export function installTestHooks(
  adapter: EngineAdapterHandle,
  engine: Engine,
  characters: CharacterBridge,
  hero: () => number = () => HERO,
): void {
  /** Give up on a `tick` that the loop can never satisfy, in milliseconds. */
  const TICK_TIMEOUT_MS = 30_000;

  /** Reused read-back buffer for `hero()`. */
  const position = new Float32Array(3);

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

  /**
   * Press a key and let it up again, a step later.
   *
   * One `keydown` is enough: `gameable/input` accumulates its edges until a
   * fixed step consumes them, so a press dispatched between two rendered
   * frames reaches the next simulation step however many frames a vsync-free
   * headless browser draws in between.
   *
   * @param code A DOM key code.
   * @returns Resolves once the release has been simulated too.
   */
  const tap = async (code: string): Promise<void> => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    await tick(1);
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    await tick(2);
  };

  window.__AOS_TEST__ = {
    press: (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    },
    release: (code) => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    },
    tap,
    tick,
    hud: () => adapter.hudModel,
    camera: () => ({
      x: engine.camera.position.x,
      y: engine.camera.position.y,
      z: engine.camera.position.z,
    }),
    hero: () => {
      adapter.transforms.getPosition(hero(), position);
      return { x: position[0], y: position[1], z: position[2] };
    },
    animation: (entity = hero()) => adapter.animationOf(entity),
    characters: () => {
      const out: CharacterReport[] = [];
      // The bridge is keyed by entity and this template never spawns more than
      // a handful, so a scan is cheaper than an enumeration API nothing else
      // would use.
      for (let entity = 1; entity <= MAX_REPORTED_ENTITY; entity += 1) {
        const entry = characters.entryOf(entity);
        if (entry === null) continue;
        const controls = entry.controls;
        // The gaze angles are the last four channels; everything before them is
        // the expression. Reporting the peak of each keeps the assertion simple
        // without shipping 68 floats across the boundary.
        const gazeStart = controls === null ? 0 : Math.max(0, controls.length - GAZE_CHANNELS);
        let expressionPeak = 0;
        let gazePeak = 0;
        if (controls !== null) {
          for (let i = 0; i < gazeStart; i += 1) {
            expressionPeak = Math.max(expressionPeak, Math.abs(controls[i]));
          }
          for (let i = gazeStart; i < controls.length; i += 1) {
            gazePeak = Math.max(gazePeak, Math.abs(controls[i]));
          }
        }
        // The head aim is a delta quaternion per neck joint; its angle is what
        // a test wants to see move when `look-at` arrives.
        let aimPeak = 0;
        const overrides = entry.animator?.jointOverrides;
        if (overrides !== undefined) {
          for (const rotation of overrides.values()) {
            aimPeak = Math.max(aimPeak, 2 * Math.acos(Math.min(1, Math.abs(rotation[3]))));
          }
        }
        out.push({
          entity,
          bundleId: entry.bundleId,
          kind: entry.kind,
          ready: entry.ready,
          clips: [...entry.clips],
          state: entry.state,
          expressionPeak,
          gazePeak,
          aimPeak,
        });
      }
      return out;
    },
  };
}
