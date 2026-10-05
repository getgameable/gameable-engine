/**
 * DOM capture: turns browser events into the packed {@link InputState}.
 *
 * The capture keeps its own "live" mirror of what is held right now, updated
 * by event handlers, and folds it into a set of **pending** edges in
 * {@link InputCapture.beginFrame}. Edges are computed by comparing against the
 * previous fold, so an input that goes down and up between two frames still
 * produces both edges rather than being lost.
 *
 * **Edges belong to the fixed step that consumes them.** Rendering runs at the
 * display's rate; game logic runs at the simulation's. A 144 Hz display draws
 * roughly 2.4 frames per 60 Hz step and a headless browser with vsync off
 * draws dozens, so an edge published and cleared once per *rendered* frame is
 * usually gone before any fixed step reads it. Instead:
 *
 * - `beginFrame` folds new DOM events into the pending sets and publishes only
 *   **level** state — what is held, where the pointer is, the modifier flags.
 *   Pending edges and accumulated deltas are left alone, so they survive a
 *   frame that runs no fixed step at all.
 * - {@link InputCapture.consume} publishes the pending edges and the
 *   accumulated mouse deltas into `state` and clears them. The `input` module
 *   calls it from `fixedUpdate`, which is exactly once per simulation step.
 *   Because consuming clears, a frame with N fixed steps delivers each edge to
 *   the **first** step only; the remaining steps see no edge, which is the same
 *   thing a 60 Hz display would have shown.
 * - `endFrame` clears the *published* edges so a frame that consumed nothing
 *   does not show the previous step's edges. It no longer throws away input.
 *
 * Nothing in `beginFrame`, `consume` or `endFrame` allocates: the bitsets, the
 * mouse object and every gamepad slot are created once by `createInputState`.
 * The one unavoidable exception is `navigator.getGamepads()`, which allocates
 * its own array; it is only called while at least one pad is connected.
 */
import { KEY_INDEX, KEY_WORDS, pointerKeyIndex } from './keycodes';
import {
  clearEdges,
  createInputState,
  GAMEPAD_AXES,
  Mods,
  resetInputState,
  setBit,
  type InputState,
} from './state';

/**
 * Options for {@link createInputCapture}.
 *
 * @example
 * ```ts
 * import { createInputCapture, type InputCaptureOptions } from 'gameable/input';
 *
 * const options: InputCaptureOptions = { pointerLock: true };
 * const capture = createInputCapture(window, options);
 * capture.dispose();
 * ```
 */
export interface InputCaptureOptions {
  /**
   * Enable pointer lock. A `mousedown` on the target then requests the lock,
   * and mouse deltas switch to `movementX`/`movementY`. Default false.
   */
  pointerLock?: boolean;
  /**
   * Call `preventDefault()` on game keys while focused: the scroll keys
   * always, and everything except escape and the F-keys while pointer-locked.
   * Never fires for a browser shortcut (ctrl/meta/alt) or for a key typed into
   * an editable element. Default true.
   */
  preventDefault?: boolean;
  /** Poll `navigator.getGamepads()` each frame. Default true. */
  gamepads?: boolean;
  /** How many gamepad slots to preallocate. Default 4. */
  gamepadSlots?: number;
  /**
   * Whether the target starts focused, before any `focus`/`blur` event.
   *
   * Defaults to `document.hasFocus()` where that exists and to `true` where it
   * does not. Pass it explicitly in a headless environment: jsdom reports
   * `hasFocus() === false` for a document nobody clicked, which would leave
   * `preventDefault` disabled for keys a test dispatches straight at the
   * window.
   */
  focused?: boolean;
  /**
   * Called when the browser refuses pointer lock — a `pointerlockerror`, or a
   * rejected `requestPointerLock()`. {@link InputCapture.lockDenied} carries
   * the same answer for code that would rather poll than subscribe.
   */
  onLockDenied?: () => void;
}

/**
 * A live DOM capture. The engine loop drives `beginFrame` / `endFrame` once per
 * rendered frame and `consume` once per fixed step; game code reads
 * {@link InputCapture.state}.
 *
 * @example
 * ```ts
 * import { createInputCapture, isDown, keyIndex } from 'gameable/input';
 *
 * const capture = createInputCapture(window);
 * capture.beginFrame();
 * capture.consume(); // one fixed step
 * console.log(isDown(capture.state, keyIndex('W'))); // false
 * capture.endFrame();
 * capture.dispose();
 * ```
 */
export interface InputCapture {
  /** The packed state, mutated in place every frame. */
  readonly state: InputState;
  /**
   * True when the last pointer-lock request was refused — no user gesture, a
   * sandboxed frame, or the user pressing escape too recently. Cleared by the
   * next {@link InputCapture.requestPointerLock} and by a successful lock.
   */
  readonly lockDenied: boolean;
  /**
   * Fold accumulated DOM events into the pending edges and publish the level
   * state — keys held, modifiers, pointer position, gamepad axes. Pending
   * edges and mouse deltas are **not** published here; they wait for
   * {@link InputCapture.consume}.
   */
  beginFrame(): void;
  /**
   * Take one fixed step's worth of input: publish the pending key, mouse and
   * gamepad edges plus the accumulated mouse deltas into `state`, then clear
   * them so the next step starts empty.
   *
   * Call once per fixed simulation step, before the step reads `state`. The
   * `input` module does this from its `fixedUpdate`.
   */
  consume(): void;
  /**
   * Clear the *published* edges and deltas. Unconsumed input is untouched and
   * is still waiting for the next {@link InputCapture.consume}.
   */
  endFrame(): void;
  /** Ask the browser for pointer lock. Needs a user gesture to succeed. */
  requestPointerLock(): void;
  /** Release pointer lock if it is held. */
  exitPointerLock(): void;
  /** Remove every listener and return the state to neutral. */
  dispose(): void;
}

/**
 * The pointer-lock and gamepad APIs as they really are: `lib.dom` declares
 * them unconditionally, but jsdom, older Safari and headless shells do not
 * implement all of them. Spelling the members optional keeps the guards
 * honest instead of asserting a browser that may not exist.
 */
type LockableElement = Omit<Element, 'requestPointerLock'> & {
  requestPointerLock?: () => unknown;
};

/** {@link LockableElement}, for the document half of the pointer-lock API. */
type LockableDocument = Omit<Document, 'exitPointerLock'> & {
  exitPointerLock?: () => unknown;
  readonly pointerLockElement: Element | null;
};

/** {@link LockableElement}, for `navigator.getGamepads`. */
type GamepadNavigator = Omit<Navigator, 'getGamepads'> & {
  getGamepads?: () => (Gamepad | null)[];
};

/*
 * The three lookups below are `Set`s, not arrays: `shouldPrevent` runs on every
 * keydown, and `Array.includes` on a twelve-entry array is a linear scan.
 */

/** Keys whose default action scrolls the page; suppressed whenever focused. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/** Codes that are never swallowed, so the user can always leave the game. */
const NEVER_PREVENTED: ReadonlySet<string> = new Set([
  'Escape',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

/** Tag names that own their keyboard input. */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Whether a DOM target owns its keyboard input, including editable descendants.
 *
 * @param target Event target.
 * @returns True for a field or contenteditable element.
 */
function ownsKeyboard(target: EventTarget | null): boolean {
  for (
    let element = target as Element | null;
    element?.getAttribute !== undefined;
    element = element.parentElement
  ) {
    if (EDITABLE_TAGS.has(element.tagName)) return true;
    const editable = element.getAttribute('contenteditable');
    if (editable !== null) return editable !== 'false';
  }
  return false;
}

/**
 * Attach DOM listeners to `target` and collect input into a packed state.
 *
 * Keyboard, focus and gamepad-connection events are attached to the owning
 * window (a canvas only receives key events when it is focusable); mouse,
 * wheel and context-menu events are attached to `target` itself;
 * `pointerlockchange` is attached to the owning document.
 *
 * @param target The element that owns the pointer — usually the canvas — or a
 *   window.
 * @param options See {@link InputCaptureOptions}.
 *
 * @returns A live capture; call `dispose()` when the engine shuts down.
 *
 * @example
 * ```ts
 * import { createInputCapture, keyIndex, wasPressed } from 'gameable/input';
 *
 * const capture = createInputCapture(window, { pointerLock: true });
 * // Resolve the index once, never inside the frame body.
 * const SPACE = keyIndex('Space');
 *
 * function frame(): void {
 *   capture.beginFrame();
 *   capture.consume(); // one fixed step's worth of edges
 *   if (wasPressed(capture.state, SPACE)) console.log('jump');
 *   capture.endFrame();
 * }
 *
 * frame();
 * capture.dispose();
 * ```
 */
export function createInputCapture(
  target: HTMLElement | Window,
  options: InputCaptureOptions = {},
): InputCapture {
  const {
    pointerLock = false,
    preventDefault = true,
    gamepads = true,
    gamepadSlots,
    onLockDenied,
  } = options;

  const isWindow = 'document' in target;
  const win: Window = isWindow ? target : (target.ownerDocument.defaultView ?? globalThis.window);
  const doc: LockableDocument = isWindow ? target.document : target.ownerDocument;
  const lockElement: LockableElement = isWindow ? doc.documentElement : target;
  const mouseTarget: EventTarget = target;

  const state = createInputState(gamepadSlots);

  // Live mirrors, folded into the pending sets by beginFrame.
  const liveKeys = new Uint32Array(KEY_WORDS);
  const prevKeys = new Uint32Array(KEY_WORDS);
  // Transitions seen since the last fold. They make an input that goes down and
  // up inside one frame still report both edges, instead of vanishing between
  // two identical snapshots.
  const pressedKeys = new Uint32Array(KEY_WORDS);
  const releasedKeys = new Uint32Array(KEY_WORDS);
  // Edges waiting for a fixed step. They accumulate across however many frames
  // are rendered between two steps, and are cleared only by `consume`.
  const pendingPressedKeys = new Uint32Array(KEY_WORDS);
  const pendingReleasedKeys = new Uint32Array(KEY_WORDS);
  let liveButtons = 0;
  let prevButtons = 0;
  let pressedButtons = 0;
  let releasedButtons = 0;
  let pendingMousePressed = 0;
  let pendingMouseReleased = 0;
  let liveMods = 0;
  let accDx = 0;
  let accDy = 0;
  let accWheel = 0;
  let lastX = 0;
  let lastY = 0;
  let haveMousePosition = false;
  // `hasFocus()` is the only honest starting value, but it is missing in some
  // headless shells and false in jsdom, hence the option and the `?? true`.
  let focused = options.focused ?? hasFocus(doc) ?? true;
  let locked = false;
  let lockDenied = false;
  let connectedPads = 0;
  // One past the highest gamepad slot that has ever held a connected pad.
  // Polling stops there, so four preallocated slots do not cost four scans.
  let padHighWater = 0;
  // Set by every handler that changes something `fold` publishes; `fold` clears
  // it. A frame with no DOM traffic at all then costs nothing.
  let dirty = true;

  // Gamepad edges follow the same accumulate-until-consumed rule. `Int32Array`
  // rather than `Uint32Array` because these are the same 32-bit masks the
  // `GamepadState` fields hold, and `|=` in JS produces a signed result.
  const padPrevButtons = new Int32Array(state.gamepads.length);
  const padPendingPressed = new Int32Array(state.gamepads.length);
  const padPendingReleased = new Int32Array(state.gamepads.length);

  /**
   * Is this key index currently held in the live mirror?
   *
   * @param index A frozen key index, already known to be valid.
   *
   * @returns True when the bit is set.
   */
  const held = (index: number): boolean => (liveKeys[index >> 5] & (1 << (index & 31))) !== 0;

  /**
   * Update the modifier mirror from any event that carries modifier state.
   *
   * @param event A keyboard or mouse event.
   */
  const readMods = (event: KeyboardEvent | MouseEvent): void => {
    let bits = 0;
    if (event.shiftKey) bits |= Mods.Shift;
    if (event.ctrlKey) bits |= Mods.Ctrl;
    if (event.altKey) bits |= Mods.Alt;
    if (event.metaKey) bits |= Mods.Meta;
    if (event.getModifierState('CapsLock')) bits |= Mods.CapsLock;
    if (event.getModifierState('NumLock')) bits |= Mods.NumLock;
    liveMods = bits;
  };

  /**
   * Should this keydown have its default action suppressed?
   *
   * @param event The keydown event.
   *
   * @returns True when `preventDefault()` should be called.
   */
  const shouldPrevent = (event: KeyboardEvent): boolean => {
    if (!preventDefault || !focused) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (NEVER_PREVENTED.has(event.code)) return false;
    const tag = (event.target as Element | null)?.tagName;
    if (tag !== undefined && EDITABLE_TAGS.has(tag)) return false;
    return locked || SCROLL_KEYS.has(event.code);
  };

  /**
   * Handle a keydown: set the live bit, refresh modifiers, suppress scrolling.
   *
   * @param event The keydown event.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (ownsKeyboard(event.target)) return;
    dirty = true;
    readMods(event);
    const index = KEY_INDEX[event.code] as number | undefined;
    // `event.repeat` and a re-fired keydown must not look like a new press.
    if (index !== undefined && !held(index)) {
      setBit(liveKeys, index, true);
      setBit(pressedKeys, index, true);
    }
    if (shouldPrevent(event)) event.preventDefault();
  };

  /**
   * Handle a keyup: clear the live bit and refresh modifiers.
   *
   * @param event The keyup event.
   */
  const onKeyUp = (event: KeyboardEvent): void => {
    const index = KEY_INDEX[event.code] as number | undefined;
    if (ownsKeyboard(event.target) && (index === undefined || !held(index))) return;
    dirty = true;
    readMods(event);
    if (index !== undefined) {
      setBit(liveKeys, index, false);
      setBit(releasedKeys, index, true);
    }
  };

  /**
   * Handle mouse motion: accumulate `movementX/Y` while locked, otherwise the
   * client-space difference since the last event.
   *
   * @param event The mousemove event.
   */
  const onMouseMove = (event: MouseEvent): void => {
    dirty = true;
    if (locked) {
      accDx += (event.movementX as number | undefined) ?? 0;
      accDy += (event.movementY as number | undefined) ?? 0;
    } else {
      if (haveMousePosition) {
        accDx += event.clientX - lastX;
        accDy += event.clientY - lastY;
      }
      haveMousePosition = true;
    }
    lastX = event.clientX;
    lastY = event.clientY;
  };

  /**
   * Handle a mouse button going down. The button is mirrored into the key
   * bitset at its reserved index so `'LMB'` behaves like any other binding.
   *
   * @param event The mousedown event.
   */
  const onMouseDown = (event: MouseEvent): void => {
    dirty = true;
    readMods(event);
    const bit = 1 << event.button;
    if ((liveButtons & bit) === 0) {
      liveButtons |= bit;
      pressedButtons |= bit;
      const index = pointerKeyIndex(event.button);
      setBit(liveKeys, index, true);
      setBit(pressedKeys, index, true);
    }
    if (pointerLock && !locked) requestPointerLock();
  };

  /**
   * Handle a mouse button coming up.
   *
   * @param event The mouseup event.
   */
  const onMouseUp = (event: MouseEvent): void => {
    dirty = true;
    readMods(event);
    const bit = 1 << event.button;
    liveButtons &= ~bit;
    releasedButtons |= bit;
    const index = pointerKeyIndex(event.button);
    setBit(liveKeys, index, false);
    setBit(releasedKeys, index, true);
  };

  /**
   * Accumulate wheel movement, normalised to lines.
   *
   * @param event The wheel event.
   */
  const onWheel = (event: WheelEvent): void => {
    dirty = true;
    accWheel += toLines(event);
    if (preventDefault && locked) event.preventDefault();
  };

  /**
   * Suppress the context menu so right-click can be a game button.
   *
   * @param event The contextmenu event.
   */
  const onContextMenu = (event: Event): void => {
    if (preventDefault) event.preventDefault();
  };

  /**
   * Drop every held input when focus is lost, so nothing sticks down.
   */
  const onBlur = (): void => {
    dirty = true;
    focused = false;
    liveKeys.fill(0);
    liveButtons = 0;
    liveMods = 0;
    accDx = 0;
    accDy = 0;
    accWheel = 0;
    haveMousePosition = false;
  };

  /**
   * Mark the target focused again.
   */
  const onFocus = (): void => {
    dirty = true;
    focused = true;
  };

  /**
   * Release gameplay input when a text field takes focus, including pending presses.
   *
   * @param event Bubbling DOM focus event.
   */
  const onFieldFocus = (event: Event): void => {
    if (!ownsKeyboard(event.target)) return;
    onBlur();
    focused = true;
    pressedKeys.fill(0);
    pendingPressedKeys.fill(0);
    pressedButtons = 0;
    pendingMousePressed = 0;
  };

  /**
   * Track pointer-lock ownership; a lock change invalidates the last known
   * absolute position.
   */
  const onPointerLockChange = (): void => {
    dirty = true;
    locked = doc.pointerLockElement === lockElement;
    if (locked) lockDenied = false;
    haveMousePosition = false;
    accDx = 0;
    accDy = 0;
  };

  /**
   * The browser refused the lock: no user gesture, a sandboxed frame, or the
   * user pressing escape a moment ago. Nothing about the capture is broken, so
   * this is reported rather than thrown.
   */
  const onPointerLockError = (): void => {
    denyLock();
  };

  /**
   * Count a connected pad, so polling only starts once one exists.
   */
  const onGamepadConnected = (): void => {
    connectedPads += 1;
  };

  /**
   * Uncount a disconnected pad.
   */
  const onGamepadDisconnected = (): void => {
    connectedPads = Math.max(0, connectedPads - 1);
  };

  /**
   * Poll `navigator.getGamepads()` into the preallocated slots.
   *
   * Button edges go into {@link padPendingPressed} / {@link padPendingReleased}
   * rather than onto the slot, for the same reason the keyboard's do: the pad
   * is polled once per rendered frame and read once per fixed step.
   */
  const pollGamepads = (): void => {
    if (!gamepads || connectedPads === 0) return;
    const nav = win.navigator as GamepadNavigator;
    const pads = nav.getGamepads?.();
    if (!pads) return;
    // Scan only as far as the browser reports pads, plus any slot that has held
    // one before and may still owe a release. Slots past that are already
    // neutral and re-clearing them every frame is pure cost.
    const scan = Math.min(state.gamepads.length, Math.max(pads.length, padHighWater));
    for (let i = 0; i < scan; i += 1) {
      const slot = state.gamepads[i];
      const src = i < pads.length ? pads[i] : null;
      slot.index = i;
      if (!src?.connected) {
        // A pad that vanishes releases everything it was holding.
        padPendingReleased[i] |= padPrevButtons[i];
        padPrevButtons[i] = 0;
        slot.buttons = 0;
        slot.connected = false;
        slot.axes.fill(0);
        continue;
      }
      let bits = 0;
      const buttonCount = Math.min(src.buttons.length, 32);
      for (let b = 0; b < buttonCount; b += 1) {
        if (src.buttons[b].pressed) bits |= 1 << b;
      }
      const previous = padPrevButtons[i];
      padPendingPressed[i] |= bits & ~previous;
      padPendingReleased[i] |= previous & ~bits;
      padPrevButtons[i] = bits;
      slot.buttons = bits;
      slot.connected = true;
      if (i >= padHighWater) padHighWater = i + 1;
      const axisCount = Math.min(src.axes.length, GAMEPAD_AXES);
      for (let a = 0; a < axisCount; a += 1) slot.axes[a] = src.axes[a];
      // The standard mapping reports only four axes; the triggers are the
      // analogue value of buttons 6 and 7.
      if (src.axes.length < GAMEPAD_AXES) {
        slot.axes[4] = buttonCount > 6 ? src.buttons[6].value : 0;
        slot.axes[5] = buttonCount > 7 ? src.buttons[7].value : 0;
      }
    }
  };

  /**
   * Ask the browser for pointer lock.
   */
  function requestPointerLock(): void {
    lockDenied = false;
    const result: unknown = lockElement.requestPointerLock?.();
    // Chrome rejects when the call is not inside a user gesture; that is not
    // an engine error, and an unhandled rejection would look like one. It is
    // still a refusal, so it is reported exactly like `pointerlockerror`.
    if (result instanceof Promise) {
      result.catch(() => {
        denyLock();
      });
    }
  }

  /**
   * Record a refused pointer-lock request and tell whoever asked.
   */
  function denyLock(): void {
    lockDenied = true;
    onLockDenied?.();
  }

  /**
   * Release pointer lock if this target holds it.
   */
  function exitPointerLock(): void {
    if (doc.pointerLockElement === lockElement) doc.exitPointerLock?.();
  }

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  win.addEventListener('gamepadconnected', onGamepadConnected);
  win.addEventListener('gamepaddisconnected', onGamepadDisconnected);
  mouseTarget.addEventListener('mousemove', onMouseMove as EventListener);
  mouseTarget.addEventListener('mousedown', onMouseDown as EventListener);
  mouseTarget.addEventListener('mouseup', onMouseUp as EventListener);
  mouseTarget.addEventListener('wheel', onWheel as EventListener, { passive: !preventDefault });
  mouseTarget.addEventListener('contextmenu', onContextMenu);
  doc.addEventListener('pointerlockchange', onPointerLockChange);
  doc.addEventListener('pointerlockerror', onPointerLockError);
  doc.addEventListener('focusin', onFieldFocus);

  /**
   * Fold everything the DOM handlers have seen since the last call into the
   * pending edge sets, and publish the level state that goes with it.
   *
   * Idempotent: calling it twice with no events in between changes nothing,
   * which is what lets both `beginFrame` and `consume` start with it — and is
   * why a fold with nothing to do can return immediately. An idle frame then
   * costs one flag test instead of eight word merges and a dozen field writes,
   * and a frame that runs several fixed steps folds once, not once per step.
   */
  const fold = (): void => {
    if (!dirty) return;
    dirty = false;
    for (let i = 0; i < KEY_WORDS; i += 1) {
      const down = liveKeys[i];
      const previous = prevKeys[i];
      state.keysDown[i] = down;
      pendingPressedKeys[i] |= (down & ~previous) | pressedKeys[i];
      pendingReleasedKeys[i] |= (previous & ~down) | releasedKeys[i];
      prevKeys[i] = down;
      pressedKeys[i] = 0;
      releasedKeys[i] = 0;
    }
    state.mods = liveMods;
    state.focused = focused;

    const { mouse } = state;
    mouse.x = lastX;
    mouse.y = lastY;
    mouse.buttons = liveButtons;
    mouse.locked = locked;
    pendingMousePressed |= (liveButtons & ~prevButtons) | pressedButtons;
    pendingMouseReleased |= (prevButtons & ~liveButtons) | releasedButtons;
    prevButtons = liveButtons;
    pressedButtons = 0;
    releasedButtons = 0;
  };

  return {
    state,

    get lockDenied(): boolean {
      return lockDenied;
    },

    beginFrame(): void {
      fold();
      pollGamepads();
    },

    consume(): void {
      // Fold first: a host may drive `consume` without a `beginFrame`, and an
      // event that arrived a microsecond ago still belongs to this step.
      fold();
      for (let i = 0; i < KEY_WORDS; i += 1) {
        state.keysPressed[i] = pendingPressedKeys[i];
        state.keysReleased[i] = pendingReleasedKeys[i];
        pendingPressedKeys[i] = 0;
        pendingReleasedKeys[i] = 0;
      }

      const { mouse } = state;
      mouse.pressed = pendingMousePressed;
      mouse.released = pendingMouseReleased;
      pendingMousePressed = 0;
      pendingMouseReleased = 0;
      // Deltas accumulate across rendered frames too: a step that follows three
      // frames of mouse movement gets all three frames' worth, exactly once.
      mouse.dx = accDx;
      mouse.dy = accDy;
      mouse.wheel = accWheel;
      accDx = 0;
      accDy = 0;
      accWheel = 0;

      for (let i = 0; i < state.gamepads.length; i += 1) {
        const slot = state.gamepads[i];
        slot.pressed = padPendingPressed[i];
        slot.released = padPendingReleased[i];
        padPendingPressed[i] = 0;
        padPendingReleased[i] = 0;
      }
    },

    endFrame(): void {
      // Only the published edges; the pending ones are still owed to a step.
      clearEdges(state);
    },

    requestPointerLock,
    exitPointerLock,

    dispose(): void {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('gamepadconnected', onGamepadConnected);
      win.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      mouseTarget.removeEventListener('mousemove', onMouseMove as EventListener);
      mouseTarget.removeEventListener('mousedown', onMouseDown as EventListener);
      mouseTarget.removeEventListener('mouseup', onMouseUp as EventListener);
      mouseTarget.removeEventListener('wheel', onWheel as EventListener);
      mouseTarget.removeEventListener('contextmenu', onContextMenu);
      doc.removeEventListener('pointerlockchange', onPointerLockChange);
      doc.removeEventListener('pointerlockerror', onPointerLockError);
      doc.removeEventListener('focusin', onFieldFocus);
      exitPointerLock();
      resetInputState(state);
      liveKeys.fill(0);
      prevKeys.fill(0);
      pressedKeys.fill(0);
      releasedKeys.fill(0);
      pendingPressedKeys.fill(0);
      pendingReleasedKeys.fill(0);
      padPrevButtons.fill(0);
      padPendingPressed.fill(0);
      padPendingReleased.fill(0);
      liveButtons = 0;
      prevButtons = 0;
      pressedButtons = 0;
      releasedButtons = 0;
      pendingMousePressed = 0;
      pendingMouseReleased = 0;
      liveMods = 0;
      accDx = 0;
      accDy = 0;
      accWheel = 0;
      connectedPads = 0;
      padHighWater = 0;
      lockDenied = false;
      dirty = true;
    },
  };
}

/**
 * Normalise a wheel event to lines, the unit `mouse-state.wheel` documents.
 *
 * @param event The wheel event.
 *
 * @returns The delta in lines; positive scrolls down.
 */
function toLines(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY; // already lines
  if (event.deltaMode === 2) return event.deltaY * 3; // pages
  return event.deltaY / 100; // pixels; ~100px per line in every major browser
}

/**
 * `document.hasFocus()`, where the environment implements it.
 *
 * @param doc The owning document.
 *
 * @returns Whether the document has focus, or `undefined` when it cannot say.
 */
function hasFocus(doc: LockableDocument): boolean | undefined {
  const maybe: { hasFocus?: () => boolean } = doc;
  return typeof maybe.hasFocus === 'function' ? maybe.hasFocus() : undefined;
}
