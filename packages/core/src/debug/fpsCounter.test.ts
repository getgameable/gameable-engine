import { expect, it } from 'vitest';
import { createEvents, type EngineEventMap } from '../events.js';
import { createFpsCounter } from './fpsCounter.js';
it('counts rendered frames, resets hidden time, and removes listeners on disposal', () => {
  let now = 0;
  const view = Object.assign(new EventTarget(), { performance: { now: () => now } });
  const document = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const value = { ownerDocument: document, textContent: '' } as unknown as HTMLElement;
  const events = createEvents<EngineEventMap>();
  const dispose = createFpsCounter({ events }, value);
  const frame = { frame: 0, dtReal: 0.1, alpha: 0, substeps: 6 };
  for (let i = 0; i < 5; i++) {
    now += 100;
    events.emit('engine:frame', frame);
  }
  expect(value.textContent).toBe('10');
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  now += 10000;
  events.emit('engine:frame', frame);
  expect(value.textContent).toBe('—');
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  now += 500;
  events.emit('engine:frame', frame);
  expect(value.textContent).toBe('2');
  dispose();
  dispose();
  now += 500;
  events.emit('engine:frame', frame);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(value.textContent).toBe('2');
});
