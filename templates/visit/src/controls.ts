/**
 * The visitor's hands on a touch screen, turned into the input the game
 * already reads, so one game file serves a mouse and a thumb alike:
 *
 * - one finger dragging on the stage is a mouse drag (look / orbit),
 * - two fingers pinching are the mouse wheel (zoom),
 * - the thumb stick presses W, A, S and D (hangout),
 * - a tap or click on the floor is `goto:<x>,<z>` for the game (hangout).
 *
 * The events are the same DOM events the engine's input module listens for,
 * dispatched on the same elements; nothing reaches inside the engine.
 */
import type { Camera } from 'three/webgpu';
import type { Stage } from './stage';

/** How far a press may wander and still be a tap. */
const TAP_PX = 10;
const TAP_MS = 450;

/**
 * Attach the controls.
 *
 * @param canvas The stage's canvas (the input module's target).
 * @param options What the page wants from taps and whether the stick is shown.
 * @returns A function that detaches everything.
 */
export function attachControls(
  canvas: HTMLCanvasElement,
  options: {
    walk: boolean;
    stage: () => Stage | null;
    camera: Camera;
    goto: (x: number, z: number) => void;
  },
): () => void {
  const touches = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  let down: { x: number; y: number; t: number } | null = null;
  const mouse = (type: string, x: number, y: number): void => {
    canvas.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }),
    );
  };
  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onDown = (e: PointerEvent): void => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) mouse('mousedown', e.clientX, e.clientY);
    else if (touches.size === 2) {
      mouse('mouseup', e.clientX, e.clientY);
      pinch = spread();
    }
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) mouse('mousemove', e.clientX, e.clientY);
    else if (touches.size === 2) {
      const now = spread();
      // Fingers apart zoom in: a negative wheel.
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: (pinch - now) * 1.5, bubbles: true }));
      pinch = now;
    }
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && touches.delete(e.pointerId) && touches.size === 0)
      mouse('mouseup', e.clientX, e.clientY);
    const tap =
      down !== null &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_PX &&
      performance.now() - down.t < TAP_MS;
    down = null;
    if (!tap || !options.walk) return;
    const rect = canvas.getBoundingClientRect();
    const hit = options
      .stage()
      ?.pick(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
        options.camera,
      );
    if (hit) options.goto(hit.x, hit.z);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // The thumb stick: a direction becomes held walking keys.
  const stick = document.getElementById('stick') as HTMLElement;
  const held = new Set<string>();
  const press = (code: string, on: boolean): void => {
    if (on === held.has(code)) return;
    if (on) held.add(code);
    else held.delete(code);
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true }));
  };
  const steer = (dx: number, dy: number): void => {
    const r = Math.min(1, Math.hypot(dx, dy));
    const a = Math.atan2(dy, dx);
    stick.style.setProperty('--sx', `${String(Math.cos(a) * r * 34)}px`);
    stick.style.setProperty('--sy', `${String(Math.sin(a) * r * 34)}px`);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    press('KeyW', y < -0.35);
    press('KeyS', y > 0.35);
    press('KeyA', x < -0.35);
    press('KeyD', x > 0.35);
  };
  const onStick = (e: PointerEvent): void => {
    e.preventDefault();
    if (e.type === 'pointerdown') stick.setPointerCapture(e.pointerId);
    if (e.type === 'pointerup' || e.type === 'pointercancel') return steer(0, 0);
    if (!stick.hasPointerCapture(e.pointerId)) return;
    const rect = stick.getBoundingClientRect();
    steer(
      (e.clientX - rect.left - rect.width / 2) / (rect.width / 2),
      (e.clientY - rect.top - rect.height / 2) / (rect.height / 2),
    );
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  stick.hidden = !(options.walk && touch);
  // The stick sits just above the talk panel and its history, however tall they grow.
  const panel = document.getElementById('conversation');
  const lift = new ResizeObserver(() => {
    if (panel) stick.style.setProperty('--panel', `${String(panel.offsetHeight)}px`);
  });
  if (panel && !stick.hidden) lift.observe(panel);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
    stick.addEventListener(type, onStick as EventListener);

  return () => {
    lift.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      stick.removeEventListener(type, onStick as EventListener);
    for (const code of held) press(code, false);
  };
}
