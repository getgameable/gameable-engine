# gameable/conversation

## What

Optional Convorcher sessions, versioned story snapshots and synchronized PCM speech presentation. The separate `gameable/conversation/relay` entry is server-only.

## When to use

Story-driven NPC interviews. Convorcher owns objectives, personalities, phases and dialogue; the guest receives structural story events through its normal tick.

## Install

```sh
npm install --save-exact gameable
```

## Minimal example

```ts
import { conversation, createSpeechPlayer } from 'gameable/conversation';
const context = new AudioContext();
const player = createSpeechPlayer(context, {
  subtitle: console.log,
  expression: () => {},
  gesture: console.log,
  speaking: console.log,
  reset: () => {},
});
const interviews = conversation({
  characters: {
    guide: { storyId: 'guide-story', url: 'ws://localhost:8787/conversation?character=guide' },
  },
  player,
  onStory: console.log,
  onStatus: console.log,
  onError: console.error,
});
// From an explicit interview action; call update each host frame.
await context.resume();
interviews.start('guide');
```

## API

`conversation` provides `start`, `end`, `ask`, `interrupt`, `update` and `dispose`. Revisiting a character reconnects its retained session. `parseStorySnapshot` validates schema version 1; `acceptStorySnapshot` rejects other sessions/stories and old revisions. `createSpeechPlayer` drives subtitles, ARKit-52 expressions and gesture selection from the AudioContext clock.

`createConversationRelay` in the `/relay` export creates an HTTP server with `/transcribe` and `/conversation`. Supply server credentials, an explicit origin allow-list and a character/story allow-list; bind to loopback for a desktop prototype. Never import this entry into a browser bundle.

## Gotchas

Resume audio in a user gesture. Stream audio and facial data stay in the host; only semantic events cross the guest boundary. The queue caps pending speech at 30 seconds and 64 sentences. Legacy raw/deflated service audio is normalized at the relay. Interrupt/end/dispose clear queued speech and animation. The current Convorcher protocol has no request identifier: supersession uses connection generation and ordered response boundaries. The approved StoryState extension must be deployed for authoritative notebook progression; older servers remain compatible but do not emit snapshots. Animated GNM faces require WebGPU.

Prepared performances can be supplied through `characters[id].prefabs`, keyed by the Convorcher `NewResponse.data.prefab` selector. Each value is an array of already-loaded `SpeechChunk`s. Selecting a performance never synthesizes objective completion. Legacy wire turns are serialized; interruption immediately stops playback, while only the newest follow-up question waits for the old response's complete audio count. A 45-second timeout releases the connection if the provider stalls. Trailing Audio2Face frames are bounded and discarded when their audio ends.
