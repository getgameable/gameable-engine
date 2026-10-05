/**
 * Raw HTTP probes for the room server tests: a matchmaking POST and a bare
 * WebSocket upgrade, each with whatever Origin the test names (or none),
 * answering only the status code.
 */
import { request } from 'node:http';

/**
 * @param port The server's port.
 * @param path `/matchmake/<method>/<room>`.
 * @param origin The Origin header, or undefined for none.
 * @returns The response status.
 */
export function postStatus(port: number, path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin !== undefined) headers.origin = origin;
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

/**
 * A WebSocket upgrade to `path`, never completed: 101 means the transport
 * took it, anything else is the status it answered instead.
 *
 * @param port The server's port.
 * @param path The upgrade path (`/<process>/<room>?sessionId=...`).
 * @param origin The Origin header, or undefined for none.
 * @param host The server address to connect to; `127.0.0.1` by default.
 * @param extra More headers (a forged `host`...).
 * @returns 101, or the refusal's status.
 */
export function upgradeStatus(
  port: number,
  path: string,
  origin?: string,
  host = '127.0.0.1',
  extra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...extra,
    };
    if (origin !== undefined) headers.origin = origin;
    const req = request({ host, port, path, headers });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** What `post` sends besides the path. */
export interface PostOptions {
  /** The Origin header; undefined for none. */
  origin?: string;
  /** More headers (`x-forwarded-for`...). */
  headers?: Record<string, string>;
  /** The JSON body; `{}` by default. */
  body?: object;
  /** The server address to connect to; `127.0.0.1` by default (`::1` is another client address). */
  host?: string;
}

/**
 * A matchmaking POST that answers its status and its body text.
 *
 * @param port The server's port.
 * @param path `/matchmake/<method>/<room>`.
 * @param options Origin, headers, body.
 * @returns The status and the body.
 */
export function post(
  port: number,
  path: string,
  options: PostOptions = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...options.headers,
    };
    if (options.origin !== undefined) headers.origin = options.origin;
    const host = options.host ?? '127.0.0.1';
    const req = request({ host, port, path, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(options.body ?? {}));
  });
}

/**
 * @param port The server's port.
 * @returns `GET /health`'s status and parsed body.
 */
export async function getHealth(port: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
  return { status: res.status, body: await res.json() };
}
