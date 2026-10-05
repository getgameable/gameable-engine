import { describe, expect, it, vi } from 'vitest';
import { conversation, type ConversationSocket } from './conversation';
import { acceptStorySnapshot, parseStorySnapshot } from './protocol';
import { createSpeechPlayer } from './playback';
import { asAudioContext, createFakeAudioContext } from '@gameable/audio/testing';
import { decodeConvorcherAudio } from './relay';
import { deflateRawSync } from 'node:zlib';
const snapshot = {
  schemaVersion: 1,
  sessionId: 'session-1',
  storyId: 'case',
  revision: 0,
  currentPhase: 'alibi',
  completedObjectives: [],
  playerState: {},
  transitionCause: 'connection',
};
class Socket implements ConversationSocket {
  readyState = 1;
  onopen: ConversationSocket['onopen'] = null;
  onmessage: ConversationSocket['onmessage'] = null;
  onclose: ConversationSocket['onclose'] = null;
  onerror: ConversationSocket['onerror'] = null;
  sent: string[] = [];
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(type: string, data: unknown = {}, message?: string): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, message }) } as MessageEvent<unknown>);
  }
}
describe('conversation', () => {
  it('validates full snapshots and ignores duplicate, stale and wrong-session updates', () => {
    const first = parseStorySnapshot(snapshot)!;
    expect(acceptStorySnapshot(null, first, 'session-1', 'case')).toEqual(first);
    const next = parseStorySnapshot({
      ...snapshot,
      revision: 2,
      completedObjectives: ['log'],
      playerState: { key: 'missing' },
    })!;
    expect(acceptStorySnapshot(next, first, 'session-1', 'case')).toBe(next);
    expect(acceptStorySnapshot(next, next, 'session-1', 'case')).toBe(next);
    expect(acceptStorySnapshot(null, next, 'other', 'case')).toBeNull();
    expect(parseStorySnapshot({ ...snapshot, revision: -1 })).toBeNull();
    expect(parseStorySnapshot({ ...snapshot, completedObjectives: [{}] })).toBeNull();
  });
  it('keeps sessions on revisits and rejects disconnected callbacks and interrupted audio', () => {
    const sockets: Socket[] = [];
    const urls: string[] = [];
    const onStory = vi.fn();
    const enqueue = vi.fn();
    const mod = conversation({
      characters: {
        steward: { storyId: 'case', url: 'ws://localhost/conversation?character=steward' },
      },
      connect: (url) => {
        urls.push(url);
        const s = new Socket();
        sockets.push(s);
        return s;
      },
      player: { enqueue, stop: vi.fn(), update: vi.fn(), dispose: vi.fn() },
      onStory,
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    expect(sockets).toHaveLength(0);
    mod.start('steward');
    const s = sockets[0];
    s.receive('session', {}, 'session-1');
    s.receive('StoryState', snapshot);
    s.receive('StoryState', snapshot);
    expect(onStory).toHaveBeenCalledOnce();
    expect(mod.ask('Where were you?')).toBe(true);
    s.receive('NewResponse');
    s.receive('TextOut', { id: 1, sentenceNum: 0, text: 'The kitchen.' });
    mod.interrupt();
    s.receive('AudioOut', { id: 1, sentenceNum: 0, audio: 'AAA=', encoding: 'pcm16' });
    expect(enqueue).not.toHaveBeenCalled();
    const late = s.onmessage!;
    mod.end();
    mod.start('steward');
    expect(new URL(urls[1]).searchParams.get('session_id')).toBe('session-1');
    late({
      data: JSON.stringify({ type: 'StoryState', data: { ...snapshot, revision: 99 } }),
    } as MessageEvent<unknown>);
    expect(onStory).toHaveBeenCalledOnce();
    mod.dispose();
  });
  it('serializes interrupted wire turns and retains only the newest question', () => {
    const socket = new Socket();
    const enqueue = vi.fn();
    const mod = conversation({
      characters: { npc: { storyId: 'case', url: 'ws://localhost' } },
      connect: () => socket,
      player: { enqueue, stop: vi.fn(), update: vi.fn(), dispose: vi.fn() },
      onStory: vi.fn(),
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    mod.start('npc');
    socket.receive('session', {}, 'session-1');
    mod.ask('old');
    mod.ask('superseded');
    mod.ask('newest');
    expect(socket.sent).toHaveLength(1);
    socket.receive('NewResponse');
    socket.receive('TextOut', { id: 1, sentenceNum: 0, text: 'stale' });
    socket.receive('ResponseComplete', { sentenceCount: 1 });
    expect(socket.sent).toHaveLength(1);
    socket.receive('AudioOut', { id: 1, sentenceNum: 0, audio: 'AAA=', encoding: 'pcm16' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]) as unknown).toEqual({ type: 'TextIn', message: 'newest' });
    socket.receive('NewResponse');
    socket.receive('TextOut', { id: 2, sentenceNum: 0, text: 'current' });
    socket.receive('AudioOut', { id: 2, sentenceNum: 0, audio: 'AAA=', encoding: 'pcm16' });
    expect(enqueue).toHaveBeenCalledOnce();
    mod.dispose();
  });
  it('keeps prepared performances separate from authoritative story updates', () => {
    const socket = new Socket();
    const onStory = vi.fn();
    const enqueue = vi.fn();
    const performance = { pcm: new Uint8Array(32), text: 'Denial', gesture: 'deny', frames: [] };
    const mod = conversation({
      characters: {
        npc: { storyId: 'case', url: 'ws://localhost', prefabs: { deny: [performance] } },
      },
      connect: () => socket,
      player: { enqueue, stop: vi.fn(), update: vi.fn(), dispose: vi.fn() },
      onStory,
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    mod.start('npc');
    socket.receive('session', {}, 'session-1');
    mod.ask('Question');
    socket.receive('NewResponse', { prefab: 'deny' });
    socket.receive('ResponseComplete', { sentenceCount: 0 });
    expect(enqueue).toHaveBeenCalledWith(performance);
    expect(onStory).not.toHaveBeenCalled();
    socket.receive('StoryState', snapshot);
    expect(onStory).toHaveBeenCalledOnce();
    mod.dispose();
  });
  it('normalizes raw and compressed service PCM and bounds inflation', () => {
    const pcm = Buffer.alloc(32000);
    pcm.writeInt16LE(1234, 10);
    expect(decodeConvorcherAudio(deflateRawSync(pcm).toString('base64'))).toEqual(pcm);
    expect(decodeConvorcherAudio(Buffer.from([1, 2, 3, 4]).toString('base64'))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(() =>
      decodeConvorcherAudio(deflateRawSync(Buffer.alloc(1_000_000)).toString('base64')),
    ).toThrow('limit');
  });
  it('drives subtitles, expressions and gestures by the playback clock, then resets', () => {
    const fake = createFakeAudioContext();
    const subtitle = vi.fn();
    const gesture = vi.fn();
    const speaking = vi.fn();
    const expression = vi.fn<(weights: Float32Array) => void>();
    const context = asAudioContext(fake);
    context.createBuffer = (_channels, length, sampleRate) =>
      ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }) as unknown as AudioBuffer;
    const player = createSpeechPlayer(context, {
      subtitle,
      gesture,
      speaking,
      expression,
      reset: vi.fn(),
    });
    player.enqueue({
      pcm: new Uint8Array(32000),
      text: 'An alibi',
      gesture: 'deny',
      frames: [
        { timeCode: 0, blendshapeWeights: new Array<number>(52).fill(0) },
        { timeCode: 1, blendshapeWeights: new Array<number>(52).fill(1) },
      ],
    });
    player.update();
    expect(subtitle).not.toHaveBeenCalled();
    fake.currentTime = 0.52;
    player.update();
    expect(subtitle).toHaveBeenCalledWith('An alibi');
    expect(gesture).toHaveBeenCalledWith('deny');
    expect(expression.mock.calls[0][0][0]).toBeCloseTo(0.5);
    player.stop();
    expect(subtitle).toHaveBeenLastCalledWith('');
    expect(fake.sources[0].stopCount).toBe(1);
    expect(speaking).toHaveBeenLastCalledWith(false);
    expect(() => {
      player.enqueue({ pcm: new Uint8Array(960002), text: '', frames: [] });
    }).toThrow();
  });
});
