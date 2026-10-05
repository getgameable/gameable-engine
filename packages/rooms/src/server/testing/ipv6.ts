/**
 * Whether this machine has an IPv6 loopback. A Docker container on an
 * IPv4-only bridge may have none, and the tests that use `::1` as a second
 * client address skip there instead of failing with `EADDRNOTAVAIL`.
 */
import { createServer } from 'node:net';

/**
 * @param host An address to bind.
 * @returns True when a server can listen on it (port 0), false on any bind error.
 */
export function canListenOn(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, host, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * @param file The test file, for the log line.
 * @returns True when `::1` can be bound; logs the skip once when it cannot.
 */
export async function hasIpv6Loopback(file: string): Promise<boolean> {
  const ok = await canListenOn('::1');
  if (!ok) console.warn(`[rooms tests] ${file}: no IPv6 loopback here (::1); the ::1 cases are skipped`);
  return ok;
}
