/**
 * The audio module's ended handles as pooled `sound-ended` guest events.
 */
import type { AudioEngine } from '@gameable/audio';
import type { GameEvent } from '@gameable/sdk';

/** One `sound-ended` event. */
type SoundEnded = Extract<GameEvent, { tag: 'sound-ended' }>;

/** Turns finished sounds into guest events from a pool rewound every step. */
export class SoundEvents {
  /**
   * Pooled `sound-ended` events. They are drained within the same fixed step
   * they are queued in, so the pool may be rewound every step.
   */
  private readonly pool: SoundEnded[] = [];

  /**
   * Drain the audio module's ended handles onto a guest event queue.
   *
   * @param audio The audio module, or null for none.
   * @param events The queue the next tick reads.
   * @returns Nothing.
   */
  drain(audio: AudioEngine | null, events: GameEvent[]): void {
    if (audio === null || audio.ended.length === 0) return;
    const ended = audio.ended;
    for (let i = 0; i < ended.length; i += 1) {
      // Rewound every step, because `fixedUpdate` drains the queue it pushes
      // onto before it returns.
      let event = this.pool[i] as SoundEnded | undefined;
      if (event === undefined) {
        event = { tag: 'sound-ended', val: { sound: 0, completed: true } };
        this.pool[i] = event;
      }
      event.val.sound = ended[i];
      event.val.completed = true;
      events.push(event);
    }
    ended.length = 0;
  }
}
