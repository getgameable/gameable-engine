import type { EngineModule } from '@gameable/core';
import { acceptStorySnapshot, parseStorySnapshot, record, type StorySnapshot } from './protocol';
import type { FaceFrame, SpeechPlayer, SpeechChunk } from './playback';

/** Browser connection surface; injectable for service replay tests. */
export interface ConversationSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(text: string): void;
  close(): void;
}
/** Story configuration is host-owned; game code names only a character id. */
export interface ConversationCharacter {
  storyId: string;
  url: string;
  /** This character's prepared performances, selected by the service. */
  prefabs?: Readonly<Record<string, readonly SpeechChunk[] | undefined>>;
}
/** Optional conversation dependencies and callbacks. */
export interface ConversationOptions {
  characters: Readonly<Record<string, ConversationCharacter | undefined>>;
  connect?(url: string): ConversationSocket;
  player: SpeechPlayer;
  /** Prepared performances keyed by Convorcher prefab id; no story mutations. */
  prefabs?: Readonly<Record<string, readonly SpeechChunk[] | undefined>>;
  onStory(character: string, snapshot: StorySnapshot): void;
  onStatus(status: string): void;
  onError(message: string): void;
}
/** Session control. Ending an interview retains its session and story revision. */
export interface ConversationModule extends EngineModule {
  start(character: string): void;
  end(): void;
  ask(text: string): boolean;
  interrupt(): void;
}
interface Session {
  id: string;
  story: StorySnapshot | null;
}
interface Sentence {
  text: string;
  gesture?: string;
  frames?: FaceFrame[];
  pcm?: Uint8Array;
  id: number;
}
/**
 * Build an optional session manager. Construction does not connect to any service.
 *
 * @param options Explicit character allow-list, playback and callbacks.
 * @returns An engine module. Call start only after an interview is requested.
 */
export function conversation(options: ConversationOptions): ConversationModule {
  const sessions = new Map<string, Session>();
  const sentences = new Map<number, Sentence>();
  let socket: ConversationSocket | undefined;
  let character = '';
  let generation = 0;
  let accepting = false;
  let awaitingResponse = true;
  let disposed = false;
  let nextSentence = 0;
  let lastId = -1;
  let responseFloor = -1;
  let inFlight = false;
  let pendingQuestion = '';
  let expectedSentences: number | undefined;
  const receivedAudio = new Set<number>();
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  const sendQuestion = (text: string): void => {
    inFlight = true;
    accepting = true;
    awaitingResponse = true;
    responseFloor = lastId;
    expectedSentences = undefined;
    receivedAudio.clear();
    clearTimeout(responseTimer);
    responseTimer = setTimeout(fail, 45_000);
    socket?.send(JSON.stringify({ type: 'TextIn', message: text }));
    options.onStatus('thinking');
  };
  const finishResponse = (): void => {
    if (expectedSentences === undefined || receivedAudio.size < expectedSentences) return;
    inFlight = false;
    clearTimeout(responseTimer);
    if (pendingQuestion !== '') {
      const text = pendingQuestion;
      pendingQuestion = '';
      sendQuestion(text);
    } else options.onStatus('ready');
  };
  const interrupt = (): void => {
    accepting = false;
    sentences.clear();
    options.player.stop();
  };
  const end = (): void => {
    generation++;
    clearTimeout(responseTimer);
    inFlight = false;
    pendingQuestion = '';
    receivedAudio.clear();
    interrupt();
    if (socket !== undefined) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socket = undefined;
    }
    options.onStatus('closed');
  };
  const fail = (): void => {
    end();
    options.onError('Conversation unavailable; retry the interview or continue exploring');
  };
  const flush = (): void => {
    for (;;) {
      const sentence = sentences.get(nextSentence);
      if (sentence?.pcm === undefined) return;
      if (sentence.pcm.length > 0)
        options.player.enqueue({
          pcm: sentence.pcm,
          text: sentence.text,
          frames: sentence.frames ?? [],
          gesture: sentence.gesture,
        });
      sentences.delete(nextSentence++);
    }
  };
  const receive = (raw: unknown): void => {
    if (typeof raw !== 'string' || raw.length > 4_000_000)
      throw new Error('Invalid conversation message');
    const message = record(JSON.parse(raw));
    const data = record(message.data);
    const session = sessions.get(character);
    const config = options.characters[character];
    if (session === undefined || config === undefined) return;
    if (message.type === 'session') {
      if (typeof message.message !== 'string' || message.message.length > 256)
        throw new Error('Missing session identity');
      if (session.id !== message.message) session.story = null;
      session.id = message.message;
      options.onStatus('ready');
    } else if (message.type === 'StoryState') {
      const next = parseStorySnapshot(data);
      if (next === null) throw new Error('Invalid story snapshot');
      const accepted = acceptStorySnapshot(session.story, next, session.id, config.storyId);
      if (accepted !== session.story && accepted !== null) {
        session.story = accepted;
        options.onStory(character, accepted);
      }
    } else if (message.type === 'NewResponse') {
      if (!inFlight) return;
      options.player.stop();
      awaitingResponse = false;
      sentences.clear();
      nextSentence = 0;
      responseFloor = lastId;
      if (accepting && typeof data.prefab === 'string' && data.prefab !== '') {
        const performance = config.prefabs?.[data.prefab] ?? options.prefabs?.[data.prefab];
        if (performance === undefined) {
          options.onError('The selected performance is unavailable');
        } else {
          for (const chunk of performance) options.player.enqueue(chunk);
        }
        awaitingResponse = true;
      }
    } else if (message.type === 'ResponseComplete' && inFlight) {
      if (
        !Number.isInteger(data.sentenceCount) ||
        (data.sentenceCount as number) < 0 ||
        (data.sentenceCount as number) > 64
      )
        throw new Error('Invalid response length');
      expectedSentences = data.sentenceCount as number;
      finishResponse();
    } else if (message.type === 'Error') {
      clearTimeout(responseTimer);
      inFlight = false;
      pendingQuestion = '';
      interrupt();
      options.onError('The conversation service returned an error');
    } else if (
      inFlight &&
      !awaitingResponse &&
      (message.type === 'TextOut' ||
        message.type === 'AudioOut' ||
        message.type === 'AudioAnimation')
    ) {
      if (!Number.isSafeInteger(data.id) || !Number.isSafeInteger(data.sentenceNum))
        throw new Error('Missing sentence identity');
      const id = data.id as number;
      const number = data.sentenceNum as number;
      if (id <= responseFloor || number < nextSentence) return;
      if (number < 0 || number >= nextSentence + 64) throw new Error('Sentence queue full');
      lastId = Math.max(id, lastId);
      if (message.type !== 'TextOut') receivedAudio.add(number);
      if (!accepting) {
        finishResponse();
        return;
      }
      let sentence = sentences.get(number);
      if (message.type === 'TextOut') {
        if (typeof data.text !== 'string' || data.text.length > 8192)
          throw new Error('Invalid subtitle');
        sentence = { id, text: data.text };
        const animations = Array.isArray(data.animations) ? data.animations : [];
        const name = record(animations[0]).Name ?? record(animations[0]).name;
        if (typeof name === 'string') sentence.gesture = name;
        sentences.set(number, sentence);
      } else {
        if (sentence === undefined || sentence.id !== id) return;
        if (
          typeof data.audio !== 'string' ||
          data.audio.length > 1_280_000 ||
          data.encoding !== 'pcm16'
        )
          throw new Error('Relay did not normalize PCM');
        const binary = atob(data.audio);
        sentence.pcm = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const frames = data.frames ?? [];
        if (!Array.isArray(frames) || frames.length > 1800)
          throw new Error('Invalid facial frames');
        sentence.frames = frames.map((value: unknown) => {
          const f = record(value);
          if (
            typeof f.timeCode !== 'number' ||
            !Array.isArray(f.blendshapeWeights) ||
            !f.blendshapeWeights.every((v: unknown) => typeof v === 'number')
          )
            throw new Error('Invalid facial frame');
          return { timeCode: f.timeCode, blendshapeWeights: f.blendshapeWeights };
        });
        // Empty audio denotes a skipped/failed sentence on Convorcher.
        flush();
        finishResponse();
      }
    }
  };
  return {
    id: 'conversation',
    init() {
      return this;
    },
    start(id) {
      if (disposed) throw new Error('Conversation module disposed');
      const config = options.characters[id];
      if (config === undefined) throw new Error('Unknown conversation character');
      end();
      character = id;
      lastId = -1;
      responseFloor = -1;
      const ownGeneration = generation;
      let session = sessions.get(id);
      if (session === undefined) {
        session = { id: '', story: null };
        sessions.set(id, session);
      }
      const url = new URL(config.url);
      if (session.id !== '') url.searchParams.set('session_id', session.id);
      options.onStatus('connecting');
      try {
        const fresh = options.connect?.(url.href) ?? new WebSocket(url.href);
        socket = fresh;
        fresh.onopen = () => {
          if (ownGeneration === generation) options.onStatus('connected');
        };
        fresh.onmessage = (event: MessageEvent<unknown>) => {
          if (ownGeneration === generation) {
            try {
              receive(event.data);
            } catch {
              fail();
            }
          }
        };
        fresh.onerror = () => {
          if (ownGeneration === generation) fail();
        };
        fresh.onclose = () => {
          if (ownGeneration === generation) fail();
        };
      } catch {
        fail();
      }
    },
    end,
    ask(text) {
      if (
        socket?.readyState !== 1 ||
        sessions.get(character)?.id === '' ||
        text.trim() === '' ||
        text.length > 4096
      )
        return false;
      interrupt();
      // Legacy Convorcher has no per-request identity. Serialize wire turns,
      // retaining only the latest interrupted question, so an old NewResponse
      // cannot be mistaken for the answer to a newer question.
      if (inFlight) {
        pendingQuestion = text.trim();
        options.onStatus('waiting for interrupted response');
      } else sendQuestion(text.trim());
      return true;
    },
    interrupt,
    update() {
      options.player.update();
    },
    dispose() {
      end();
      disposed = true;
      sessions.clear();
      options.player.dispose();
    },
  };
}
