# Read player input

## Goal

Move the player with `WASD` or the left stick, and fire with the left mouse
button or the right trigger — without a key code appearing anywhere in your
game code. When you are done, `input.axis2('move')` drives the character and
`input.pressed('fire')` fires exactly once per click.

## Files you will edit

- `src/game.ts` — declare the bindings.
- `src/systems/move.ts` — read the actions.

## Steps

1. Declare the action map in `src/game.ts`. Names are yours; bindings are
   `KeyboardEvent.code` values, friendly aliases (`'W'`, `'Space'`, `'LMB'`)
   or `Gamepad*` names.

   ```ts
   import { defineGame } from 'gameable';
   import { move } from './systems/move';

   export default defineGame({
     assets: './assets.json',
     world: 'arena',
     actions: {
       fire: ['LMB', 'GamepadRT'],
       jump: ['Space', 'GamepadA'],
       move: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] },
     },
     systems: [move],
   });
   ```

2. Read them in `src/systems/move.ts`. `axis2` returns `[x, y]` in -1..1, with
   `+y` forward; the tuple is reused every call, so destructure it instead of
   keeping the reference.

   ```ts
   import { input, type Ctx } from 'gameable';

   const SPEED = 5;

   export function move(ctx: Ctx): void {
     const [x, y] = input.axis2('move');
     ctx.player.velocity[0] = x * SPEED;
     ctx.player.velocity[2] = -y * SPEED;

     if (input.pressed('jump')) ctx.player.jump();
   }
   ```

3. Use the edge readers, not the held reader, for one-shot actions.
   `pressed('fire')` is true on exactly one **simulation step** per click —
   including a click that starts and ends between two rendered frames, and
   however many frames the display drew since the last step — while
   `down('fire')` stays true for as long as the button is held, which is what
   an automatic weapon wants.

   ```ts
   if (input.pressed('fire')) fireOnce();
   if (input.down('fire')) holdTrigger();
   ```

4. For a mouse-look camera, ask for pointer lock and read the frame's delta.
   Deltas are zero unless the lock is held, so this is safe to run always.

   ```ts
   import { input, type Ctx } from 'gameable';

   const SENSITIVITY = 0.0022;

   export function look(ctx: Ctx): void {
     if (input.pressed('fire') && !input.locked) input.requestPointerLock();
     ctx.camera.yaw -= input.mouse.dx * SENSITIVITY;
     ctx.camera.pitch -= input.mouse.dy * SENSITIVITY;
   }
   ```

## Verify

```sh
npm run dev
```

Hold `W` and the player walks forward; the left stick does the same. Click and
the weapon fires once per click, not once per frame. Then assert it headlessly:

```sh
npm test
```

```ts
// tests/smoke.spec.ts
it('fires once per click', () => {
  harness.mouseDown(0);
  harness.frame();
  expect(harness.shots).toBe(1);
  harness.frame(); // still held, no second shot
  expect(harness.shots).toBe(1);
});
```

## See also

- [Engine modules](../concepts/modules.md)
- [The engine loop](../concepts/engine-loop.md)
- [`gameable/input` API](../api/@gameable.input.md), and `packages/input/README.md`
- [Build your first FPS](../start/02-first-fps.md)
