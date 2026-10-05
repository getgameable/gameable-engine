/** The same guest runs in direct and wasm mode; only semantic chat events cross the boundary. */
import { camera, character, conversation, defineGame, prefab } from 'gameable';

const Greeter = prefab({ name: 'greeter', character: 'char.greeter' });
const CLIPS = ['idle', 'wave'];
const IDLE = new Float32Array([1, 0]);
const WAVE = new Float32Array([0, 1]);
let greeter = 0;
let active = false;
let waveRemaining = 0;

export default defineGame({
  assets: ['char.greeter'],
  world: { maxEntities: 16 },
  init(ctx) {
    active = false;
    waveRemaining = 0;
    greeter = ctx.spawn(Greeter, { x: 0, y: 0, z: 0 });
    character.setClipWeights(greeter, CLIPS, IDLE, 1);
    camera.set({ x: 0, y: 1.15, z: 3.4 }, { x: 0, y: 0, z: 0, w: 1 }, 50);
    camera.lookAt({ x: 0, y: 0.85, z: 0 });
  },
  update(ctx) {
    if (waveRemaining > 0) {
      waveRemaining -= ctx.dt;
      if (waveRemaining <= 0) character.setClipWeights(greeter, CLIPS, IDLE, 1);
    }
    for (const event of ctx.events) {
      if (event.tag !== 'conversation-event' || event.val.entity !== greeter) continue;
      const { kind, text } = event.val;
      if (kind === 'input') {
        if (active) conversation.command(greeter, 'ask', 'greeter', text);
      } else if (kind === 'status') {
        if (text === 'start') {
          active = true;
          conversation.command(greeter, 'start', 'greeter');
        } else if (text === 'end') {
          active = false;
          conversation.command(greeter, 'end', 'greeter');
        } else if (text === 'wave') {
          waveRemaining = 2.2;
          character.setClipWeights(greeter, CLIPS, WAVE, 1);
        } else if (
          active &&
          (text === 'interrupt' || text === 'microphone-on' || text === 'microphone-off')
        ) {
          conversation.command(greeter, text, 'greeter');
        }
      }
    }
  },
});
