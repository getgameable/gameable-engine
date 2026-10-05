# gameable/input

## What

The input `EngineModule`. It attaches the DOM listeners, collects keyboard,
mouse (including pointer-lock deltas) and gamepad into the packed
`input-state` block of `frame-input`, and resolves named actions like `fire`
and `move`.

The state is exactly the WIT record, so it crosses the wasm boundary without a
translation layer:

- `keysDown` / `keysPressed` / `keysReleased` — 256 bits each, in
  `Uint32Array(8)`. Key `c` is bit `c & 31` of word `c >> 5`.
- `mods` — `Mods.Shift | Mods.Ctrl | …`, in `input-mods` flag order.
- `mouse` — `{ x, y, dx, dy, wheel, buttons, pressed, released, locked }`.
- `gamepads` — preallocated slots of
  `{ index, connected, buttons, pressed, released, axes: Float32Array(6) }`.
- `focused` — false means "treat input as neutral".

The index table in `src/keycodes.ts` maps `KeyboardEvent.code` to bit index and
is **frozen forever**: recordings, replays and compiled guests encode those
numbers, so codes may only ever be appended. Indexes 0..127 are the shared
keyboard table, imported from `gameable/sdk/keycodes` rather than copied, so
host and guest agree bit for bit by construction. 128..247 are free for appends.
Mouse buttons are mirrored into the reserved pointer block at the top
(`Mouse0`..`Mouse4`, 248+), which the guest table leaves empty, so `'LMB'` reads
exactly like `'Space'`.

## When to use

Always. Every template registers it. Game code inside the guest should read it
through `sdk`'s `input` facade rather than importing this package directly;
host-side code — a camera rig, a debug overlay, an editor tool — reads the
service.

Use `createInputCapture` on its own when you want the packed state without the
engine (a test harness, a record/replay tool, a standalone viewer).

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { input } from 'gameable/input';

const module = input({
  pointerLock: true,
  actions: {
    fire: ['LMB', 'GamepadRT'],
    jump: ['Space', 'GamepadA'],
    move: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] },
  },
});

// The engine calls init, then beginFrame once per rendered frame, fixedUpdate
// once per simulation step, and endFrame after rendering.
const { actions, state } = module.init(ctx);

// Resolve the handles once, at startup; never look an action up by name in a
// frame body.
const JUMP = actions.handle('jump');
const MOVE = actions.handle('move');

module.beginFrame();
module.fixedUpdate(1 / 60);

if (actions.pressed(JUMP)) console.log('jump');
const [x, y] = actions.axis2(MOVE);
console.log(x, y, state.mouse.dx, state.mouse.dy);

module.endFrame();
```

## API

- `input(options?): InputModule` — the `EngineModule` factory. `id` is
  `'input'`, `order` is `-100`, and `init` returns the service, so the engine
  publishes it as `engine.get('input')`.
  `options`: `target`, `actions`, `pointerLock`, `preventDefault`, `gamepads`,
  `gamepadSlots`, `focused`, `onLockDenied`.
- `InputService` — `{ state, actions, requestPointerLock, exitPointerLock,
lockDenied, consume }`.
- `createInputCapture(target, options?)` — the DOM layer:
  `{ state, lockDenied, beginFrame, consume, endFrame, requestPointerLock,
exitPointerLock, dispose }`. `beginFrame` folds the frame's DOM events into the pending edges
  and publishes the level state; `consume` hands one fixed step the edges and
  mouse deltas that have accumulated since the previous step and clears them;
  `endFrame` clears the published edges.
- `createActionMap(bindings, state?)` — returns
  `{ names, handle, down, pressed, released, axis2, bind }`. `handle(name)`
  mints the small integer the four readers also accept, so a frame body does no
  string work at all. Bindings are `'KeyW'`,
  `'W'`, `'Space'`, `'LMB'`, `'RMB'`, `'GamepadA'`, `'GamepadRT'`, … An axis2
  action is
  `{ axis2: [negX, posX, negY, posY], gamepadAxes?, deadzone?, invertGamepadY? }`.
- `createInputState(slots?)`, `isDown`, `wasPressed`, `wasReleased`,
  `axis2(state, negX, posX, negY, posY, out?)`, `setBit`, `clearEdges`,
  `resetInputState` — the pure state layer.
- `keyIndex(nameOrCode)`, `keyIndex2` (the other half of `'Shift'`),
  `KEY_INDEX`, `KEY_NAMES`, `pointerKeyIndex`,
  `gamepadButtonIndex`, `GAMEPAD_BUTTON_INDEX`, `Mods`, `MouseButtons`.

## Gotchas

- Text fields, selects and contenteditable descendants own their keyboard input:
  typing does not produce gameplay keys. Focusing a field releases held gameplay
  input and cancels pending presses, so movement cannot stick while typing.

- `pressed` and `released` belong to a **fixed step**, not to a rendered frame.
  They are published by `fixedUpdate` (`capture.consume()`) and cleared by
  `endFrame`, so read them from a `fixedUpdate`, never from `update`. A frame
  that runs no fixed step publishes no edges and loses none: they wait.
- A frame that runs several fixed steps delivers each edge to the **first**
  step only. That is deliberate — it is what a 60 Hz display would have shown,
  and it stops one press from firing a weapon twice on a slow frame.
- `mouse.dx` / `dy` / `wheel` follow the same rule: they accumulate across
  every rendered frame since the last step and are handed over whole, exactly
  once.
- A tap that starts and ends inside one frame still reports both edges, with
  `down` false. Test `pressed`, not `down`, for a fire button.
- `axis2` returns a **reused** tuple. Destructure it or copy it; do not keep
  the reference. Pass your own `out` if you need two axes at once.
- Pointer-lock deltas are only non-zero while the lock is held, and
  `requestPointerLock` only succeeds inside a user gesture. With
  `pointerLock: true` a `mousedown` on the target requests it for you.
- `wheel` is in lines, not pixels: a pixel-mode wheel event is divided by 100.
- Blur clears everything held, so a key does not stick down while the tab is
  in the background. The release edge arrives on the next fixed step.
- Gamepads are only polled once a `gamepadconnected` event has fired, which in
  every browser means after the player has pressed a button on the pad.
- The key table is append-only. Adding a code in the middle silently
  reinterprets every recording ever made.
- The keyboard half of the table is not written here. `src/keycodes.ts` imports
  `KEY_NAMES` from `gameable/sdk/keycodes` — a dependency-free table module
  that pulls in no game runtime — and builds the host index from it, so host and
  guest cannot drift. Indexes 128..247 and the pointer block are the host's own.
  See [ADR 0013](../../adr/0013-single-key-table.md).
- `down` / `pressed` / `released` / `axis2` take either a name or a handle.
  Resolve the handle once with `actions.handle('jump')` and keep it: the name
  path costs a map lookup per read, the handle path is an array index.
- The capture only folds DOM events when a handler has actually seen one, so a
  frame with no input costs a flag test. Nothing observable changes: `fold` was
  already idempotent.
- `focused` seeds from `document.hasFocus()`. jsdom answers `false` for a
  document nobody clicked, which switches `preventDefault` off, so a headless
  test that dispatches keys at the window should pass `focused: true` (or
  dispatch a `focus` event first).
- A refused pointer lock is reported, not thrown: `capture.lockDenied` goes
  true and `onLockDenied` fires, for the `pointerlockerror` event and for a
  rejected `requestPointerLock()` alike. Show "click to play" rather than
  assuming the mouse is captured.
- The module imports `EngineModule` / `EngineContext` from `gameable/core`
  and merges `InputService` into core's `EngineServices`, so
  `engine.get('input')` is typed with no cast. Core does not depend on input,
  so there is no cycle. The capture and state layers stay engine-free: import
  `createInputCapture` on its own in a harness or a recorder.
