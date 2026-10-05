/**
 * Optional Convorcher session manager; import alone opens no connections.
 *
 * @example
 * ```ts
 * import { conversation } from 'gameable/conversation';
 * const interviews = conversation({ characters, player, onStory, onStatus, onError });
 * interviews.start('steward');
 * interviews.ask('Where were you at nine?');
 * interviews.end();
 * ```
 */
export { conversation } from './conversation';
/**
 * Audio-clock speech and facial playback.
 *
 * @example
 * ```ts
 * import { createSpeechPlayer } from 'gameable/conversation';
 * const player = createSpeechPlayer(audioContext, presentation);
 * player.enqueue({ pcm, text: 'Good evening.', frames: [] });
 * player.update();
 * ```
 */
export { createSpeechPlayer } from './playback';
/**
 * Versioned full-state validation and idempotent reduction.
 *
 * @example
 * ```ts
 * import { parseStorySnapshot, acceptStorySnapshot } from 'gameable/conversation';
 * const next = parseStorySnapshot(message.data);
 * if (next) current = acceptStorySnapshot(current, next, sessionId, storyId);
 * ```
 */
export { parseStorySnapshot, acceptStorySnapshot } from './protocol';
export type {
  ConversationOptions,
  ConversationCharacter,
  ConversationSocket,
  ConversationModule,
} from './conversation';
export type { SpeechChunk, SpeechPlayer, SpeechPresentation, FaceFrame } from './playback';
export type { StorySnapshot } from './protocol';
