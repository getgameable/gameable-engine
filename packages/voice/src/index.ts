/**
 * Optional Voxy capture with abortable, complete-utterance transcription.
 *
 * @example
 * ```ts
 * import { voice } from 'gameable/voice';
 * const mic = voice({ createCapture, transcribe, onText, onInterrupt, onStatus, onError });
 * mic.setTranscribing(false);
 * await mic.start(); // start VAD when the player enters the game
 * mic.setTranscribing(true); // explicitly start an interview
 * mic.stop();
 * ```
 */
export { voice } from './voice';
/**
 * Validated WAV-to-Parlay conversion.
 *
 * @example
 * ```ts
 * import { wavToPcm16 } from 'gameable/voice';
 * const pcm = wavToPcm16(await utterance.audio.arrayBuffer());
 * ```
 */
export { wavToPcm16 } from './pcm';
export type { CaptureEvents, VoiceCapture, VoiceOptions, VoiceService, VoiceModule } from './voice';
