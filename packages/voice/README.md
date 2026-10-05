# gameable/voice

## What

Optional, host-side Voxy capture and Parlay transcription lifecycle. Nothing accesses the microphone until `start()`.

## When to use

Hands-free interviews with VAD and interruption. Keep typed input available when permission or transcription fails.

## Install

```sh
npm install --save-exact gameable @gameable/voxy
```

## Minimal example

```ts
import { voice } from 'gameable/voice';
const microphone = voice({
  playbackEchoGuardMs: 700, // Speaker-safe mode; explicit UI interruption.
  async createCapture() {
    const { VoxyCore } = await import('@gameable/voxy/core');
    return new VoxyCore({ sampleRate: 16000 });
  },
  async transcribe(pcm, signal) {
    const response = await fetch('/transcribe', { method: 'POST', body: pcm, signal });
    if (!response.ok) throw new Error('Transcription unavailable');
    return ((await response.json()) as { text: string }).text;
  },
  onText: console.log,
  onInterrupt: () => console.log('stop NPC speech'),
  onStatus: console.log,
  onError: console.error,
});
// Start VAD when the player enters the game; route audio only during interviews.
microphone.setTranscribing(false);
await microphone.start();
microphone.setTranscribing(true); // Interview starts; requires fresh speech.
microphone.setTranscribing(false); // Interview ends; VAD stays warm.
// On mute or leaving the game:
microphone.stop();
```

## API

`voice(options)` returns an engine module with `start`, `stop`, `setTranscribing`, `speaking` and `dispose`. `setTranscribing` cancels pending transcription and discards speech already underway, including when called with `true` to switch conversation targets. Disabling transcription keeps capture/VAD alive without uploading utterances or interrupting playback. Injecting the capture and transcription ports makes recorded tests independent of devices. `wavToPcm16` validates complete mono PCM16 WAV utterances at 16 kHz and returns raw PCM bytes. The server-only conversation relay accepts those bytes at `/transcribe`.

## Gotchas

Serve Voxy's exported model and worklet assets from your application. Inform Voxy when NPC playback starts/stops using `speaking`. With `playbackEchoGuardMs`, speech during playback and its echo tail is discarded, including an utterance that starts inside the guard and ends afterward. Provide an explicit interrupt button that stops playback; the player can speak after the tail expires. Omitting this option permits hands-free barge-in, appropriate for headphones. Browser echo cancellation alone cannot reliably distinguish speaker reverb from a player. Utterances are bounded to 30 seconds; disabling transcription or stopping capture cancels pending results. Credentials belong in a server relay. Games without this module have no Voxy dependency.
