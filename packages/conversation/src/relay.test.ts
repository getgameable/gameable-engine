import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createConversationRelay, transcribeParlay, type RelayOptions } from './relay';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function options(url: string): RelayOptions {
  return {
    convorcherUrl: url,
    convorcherKey: 'server-secret',
    parlayUrl: url,
    parlayKey: 'transcriber-secret',
    origins: ['http://game.local'],
    characters: { steward: { character: 'blackthorn-steward', story: 'blackthorn-steward' } },
  };
}
it('forwards complete mono PCM16 utterances and cancels pending transcription', async () => {
  const upstream = new WebSocketServer({ port: 0 });
  cleanup.push(() => {
    for (const peer of upstream.clients) peer.terminate();
    upstream.close();
  });
  await once(upstream, 'listening');
  const config = options(`ws://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`);
  const received = new Promise<unknown>((resolve) =>
    upstream.once('connection', (peer) => {
      peer.once('message', (raw) => {
        resolve(JSON.parse((raw as Buffer).toString()) as unknown);
        peer.send(
          JSON.stringify({ text: 'Transcription: starting', provider: '', duration_ms: 0 }),
        );
        peer.send(JSON.stringify({ text: 'Where were you?', provider: 'test' }));
      });
    }),
  );
  expect(
    await transcribeParlay(config, new Uint8Array([0, 0, 1, 0]), new AbortController().signal),
  ).toBe('Where were you?');
  expect(await received).toEqual({
    api_key: 'transcriber-secret',
    audio: 'AAABAA==',
    sample_rate: 16000,
    channels: 1,
  });
  const controller = new AbortController();
  const pending = transcribeParlay(config, new Uint8Array(32), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('Cancelled');
});
it('isolates credentials, rejects other origins and closes active websocket peers', async () => {
  const upstream = new WebSocketServer({ port: 0 });
  cleanup.push(() => {
    for (const peer of upstream.clients) peer.terminate();
    upstream.close();
  });
  await once(upstream, 'listening');
  const config = options(`ws://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`);
  let query: URLSearchParams | undefined;
  upstream.on('connection', (peer, request) => {
    query = new URL(request.url!, 'http://localhost').searchParams;
    peer.send(JSON.stringify({ type: 'session', message: 'session-1' }));
    peer.on('message', () => {
      peer.send(
        JSON.stringify({ type: 'Error', message: 'server-secret', data: { key: 'server-secret' } }),
      );
    });
  });
  const relay = createConversationRelay(config);
  cleanup.push(() => relay.close());
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const url = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`;
  expect(
    (
      await fetch(`${url}/transcribe`, {
        method: 'POST',
        headers: { Origin: 'http://evil.local' },
        body: 'x',
      })
    ).status,
  ).toBe(403);
  const client = new WebSocket(`${url.replace('http', 'ws')}/conversation?character=steward`, {
    origin: 'http://game.local',
  });
  cleanup.push(() => {
    client.terminate();
  });
  const [hello] = (await once(client, 'message')) as [Buffer];
  expect(JSON.parse(hello.toString()) as unknown).toEqual({
    type: 'session',
    message: 'session-1',
  });
  expect(query?.get('api_key')).toBe('server-secret');
  const error = once(client, 'message');
  client.send(JSON.stringify({ type: 'TextIn', message: 'Question' }));
  const [raw] = (await error) as [Buffer];
  expect(raw.toString()).not.toContain('server-secret');
  const closed = once(client, 'close');
  relay.close();
  await closed;
});
