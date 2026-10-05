import { createServer, type Server } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { record } from './protocol';
import type { RelayServices } from './services';

export {
  GAMEABLE_CONVERSATION_URL,
  GAMEABLE_TRANSCRIPTION_URL,
  servicesFromEnv,
  type RelayServices,
  type ServiceEnv,
} from './services';

/**
 * Server-only credentials and explicit service/character allow-lists. The
 * services usually come from {@link servicesFromEnv}.
 */
export interface RelayOptions extends RelayServices {
  /** Allowed browser origins; never wildcard this credential-bearing relay. */
  origins: readonly string[];
  /** Game id to upstream character and story. */
  characters: Readonly<Record<string, { character: string; story: string }>>;
}
/**
 * Normalize Convorcher's legacy raw-or-deflate payload with a bounded inflate.
 *
 * @param encoded Base64 audio.
 * @returns Little-endian mono PCM16.
 */
export function decodeConvorcherAudio(encoded: string): Buffer {
  if (encoded.length > 1_280_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('Invalid audio');
  const bytes = Buffer.from(encoded, 'base64');
  let pcm = bytes;
  try {
    const inflated = inflateRawSync(bytes, { maxOutputLength: 960000 });
    if (inflated.length > bytes.length + 64) pcm = inflated;
  } catch (error) {
    // Legacy service sends incompressible PCM unmarked. Size-limit errors are
    // never a reason to play compressed bytes as raw samples.
    if (record(error).code === 'ERR_BUFFER_TOO_LARGE')
      throw new Error('Audio exceeds limit', { cause: error });
  }
  if (pcm.length > 960000 || pcm.length % 2 !== 0) throw new Error('Invalid PCM length');
  return pcm;
}
/**
 * Transcribe one complete bounded utterance; credentials never leave this entry point.
 *
 * @param options Service configuration.
 * @param pcm Raw mono PCM16 at 16 kHz.
 * @param signal Abort when the browser disconnects or interrupts.
 * @returns Transcript text.
 */
export function transcribeParlay(
  options: RelayOptions,
  pcm: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  if (pcm.length < 2 || pcm.length > 960000 || pcm.length % 2 !== 0)
    return Promise.reject(new Error('Invalid utterance'));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const ws = new WebSocket(options.parlayUrl, { maxPayload: 65536, handshakeTimeout: 10000 });
    let done = false;
    const finish = (error?: Error, text = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      ws.close();
      if (error !== undefined) reject(error);
      else resolve(text);
    };
    const abort = (): void => {
      finish(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      finish(new Error('Transcription timed out'));
    }, 40000);
    signal.addEventListener('abort', abort, { once: true });
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          api_key: options.parlayKey,
          audio: Buffer.from(pcm).toString('base64'),
          sample_rate: 16000,
          channels: 1,
        }),
      );
    });
    ws.on('message', (raw) => {
      try {
        const msg = record(
          JSON.parse(
            (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString(
              'utf8',
            ),
          ),
        );
        if (msg.error !== undefined) finish(new Error('Transcription service error'));
        else if (
          typeof msg.text === 'string' &&
          typeof msg.provider === 'string' &&
          msg.provider.trim() !== ''
        )
          finish(undefined, msg.text.slice(0, 4096));
      } catch {
        finish(new Error('Invalid transcription response'));
      }
    });
    ws.on('error', () => {
      finish(new Error('Transcription connection failed'));
    });
    ws.on('close', () => {
      finish(new Error('Transcription connection closed'));
    });
  });
}
/**
 * Create an internal desktop relay. Caller binds it to loopback and owns shutdown.
 *
 * @param options Server-only keys, upstream addresses and allowed origins.
 * @returns An unbound Node HTTP server; close() also tears down WebSockets.
 * @example
 * ```ts
 * import { createConversationRelay } from 'gameable/conversation/relay';
 * const server = createConversationRelay(options);
 * server.listen(8787, '127.0.0.1');
 * ```
 */
export function createConversationRelay(options: RelayOptions): Server {
  const allowed = (origin: string | undefined): boolean =>
    origin !== undefined && options.origins.includes(origin);
  let transcriptionCount = 0;
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (!allowed(origin)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin ?? '');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204).end();
      return;
    }
    if (req.url !== '/transcribe' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    if (transcriptionCount >= 2) {
      res.writeHead(429).end();
      return;
    }
    transcriptionCount++;
    let finished = false;
    const release = (): void => {
      if (!finished) {
        finished = true;
        transcriptionCount--;
      }
    };
    const controller = new AbortController();
    res.on('close', () => {
      controller.abort();
      release();
    });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 960000) {
        res.writeHead(413).end();
        req.destroy();
        release();
        return;
      }
      chunks.push(data);
    });
    req.on('error', () => {
      controller.abort();
      release();
    });
    req.on('end', () => {
      if (size > 960000 || controller.signal.aborted) return;
      void transcribeParlay(options, Buffer.concat(chunks), controller.signal)
        .then((text) => {
          if (!res.destroyed) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ text }));
          }
        })
        .catch(() => {
          if (!res.destroyed) res.writeHead(502).end('{"error":"Transcription unavailable"}');
        })
        .finally(release);
    });
  });
  server.requestTimeout = 45000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const peers = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('character') ?? '';
    const config = Object.hasOwn(options.characters, id) ? options.characters[id] : undefined;
    const session = url.searchParams.get('session_id');
    if (
      !allowed(req.headers.origin) ||
      url.pathname !== '/conversation' ||
      config === undefined ||
      peers.size >= 8 ||
      (session !== null && !/^[a-zA-Z0-9-]{1,128}$/.test(session))
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstreamUrl = new URL('/ws', options.convorcherUrl);
      upstreamUrl.searchParams.set('api_key', options.convorcherKey);
      upstreamUrl.searchParams.set('character', config.character);
      upstreamUrl.searchParams.set('story', config.story);
      upstreamUrl.searchParams.set('features', 'storyteller,ttsaf');
      upstreamUrl.searchParams.set('mode', 'blendshapes');
      upstreamUrl.searchParams.set('transmission', 'json');
      if (session !== null) upstreamUrl.searchParams.set('session_id', session);
      const upstream = new WebSocket(upstreamUrl, {
        maxPayload: 4_000_000,
        handshakeTimeout: 10000,
      });
      peers.add(client);
      peers.add(upstream);
      const close = (): void => {
        client.close();
        upstream.close();
        peers.delete(client);
        peers.delete(upstream);
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
      client.on('message', (raw) => {
        try {
          const msg = record(
            JSON.parse(
              (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString(
                'utf8',
              ),
            ),
          );
          if (
            msg.type !== 'TextIn' ||
            typeof msg.message !== 'string' ||
            msg.message.length > 4096 ||
            upstream.readyState !== WebSocket.OPEN ||
            upstream.bufferedAmount > 8192
          ) {
            close();
            return;
          }
          upstream.send(JSON.stringify({ type: 'TextIn', message: msg.message }));
        } catch {
          close();
        }
      });
      upstream.on('message', (raw) => {
        try {
          const msg = record(
            JSON.parse(
              (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString(
                'utf8',
              ),
            ),
          );
          if (msg.type === 'AudioOut' || msg.type === 'AudioAnimation') {
            const data = record(msg.data);
            const pcm = decodeConvorcherAudio(typeof data.audio === 'string' ? data.audio : '');
            msg.data = { ...data, audio: pcm.toString('base64'), encoding: 'pcm16' };
          }
          // Error details may contain an upstream URL with credentials.
          if (msg.type === 'Error') msg.message = 'Conversation service error';
          if (msg.type === 'Error') msg.data = {};
          if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 4_000_000) {
            close();
            return;
          }
          client.send(JSON.stringify(msg));
        } catch {
          close();
        }
      });
    });
  });
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    for (const peer of peers) peer.terminate();
    peers.clear();
    wss.close();
    return closeServer(callback);
  };
  return server;
}
