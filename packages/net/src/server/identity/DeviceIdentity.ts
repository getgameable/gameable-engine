/**
 * `DeviceIdentity` — a browser known by a token this server signed:
 * `device.<random>.<hmac>`, where `<random>` is 16 random bytes and `<hmac>`
 * is HMAC-SHA256(secret, `device.<random>`), both base64url. The page keeps
 * it in `localStorage`; the id is `device:<random>`.
 */
import { constantTimeEqual, hmacKey, randomBytes, base64url, sign } from './hmac.js';
import { IdentityProvider, type IdentityAuth, type PlayerIdentity } from './IdentityProvider.js';

const PREFIX = 'device';
const TOKEN = /^device\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const RANDOM_BYTES = 16;

/**
 * A device token the server just made, and who it names.
 *
 * @example
 * ```ts
 * import { deviceIdentity, type MintedDevice } from 'gameable/net/server';
 *
 * const minted: MintedDevice = await deviceIdentity(secret).mint();
 * ```
 */
export interface MintedDevice {
  /** `device.<random>.<hmac>`: what the page keeps and sends on each join. */
  readonly token: string;
  /** Its identity: `device:<random>`. */
  readonly identity: PlayerIdentity;
}

/**
 * Device tokens: `mint` makes one, `resolve` verifies one. A token whose
 * HMAC does not match (forged, flipped, another server's secret) resolves
 * null; the comparison runs in constant time.
 *
 * @example
 * ```ts
 * import { DeviceIdentity } from 'gameable/net/server';
 *
 * const device = new DeviceIdentity(process.env.ROOMS_SECRET ?? '');
 * const { token } = await device.mint();
 * const who = await device.resolve({ token, headers: {} }); // { id: 'device:...', name: '', kind: 'device' }
 * ```
 */
export class DeviceIdentity extends IdentityProvider {
  private readonly key: Promise<CryptoKey>;

  /** @param secret The signing secret (`ROOMS_SECRET`); `identitiesFromEnv` checks its length. */
  constructor(secret: string) {
    super();
    if (secret === '') throw new Error('deviceIdentity: the secret is empty');
    this.key = hmacKey(secret);
  }

  /** @returns A fresh token and its identity. */
  async mint(): Promise<MintedDevice> {
    const random = base64url(randomBytes(RANDOM_BYTES));
    const mac = await sign(this.key, `${PREFIX}.${random}`);
    return { token: `${PREFIX}.${random}.${mac}`, identity: identityOf(random) };
  }

  async resolve(auth: IdentityAuth): Promise<PlayerIdentity | null> {
    const match = TOKEN.exec(auth.token ?? '');
    if (match === null) return null;
    const [, random, mac] = match;
    const expected = await sign(this.key, `${PREFIX}.${random}`);
    return constantTimeEqual(mac, expected) ? identityOf(random) : null;
  }
}

/**
 * @param random The token's random part.
 * @returns The device's identity.
 */
function identityOf(random: string): PlayerIdentity {
  return { id: `device:${random}`, name: '', kind: 'device' };
}

/**
 * Device tokens signed with `secret`.
 *
 * @param secret The signing secret, at least 32 bytes in production (`identitiesFromEnv`).
 * @returns The provider.
 *
 * @example
 * ```ts
 * import { deviceIdentity } from 'gameable/net/server';
 *
 * const device = deviceIdentity(process.env.ROOMS_SECRET ?? '');
 * ```
 */
export function deviceIdentity(secret: string): DeviceIdentity {
  return new DeviceIdentity(secret);
}
