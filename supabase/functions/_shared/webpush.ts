// Dependency-free Web Push sender (RFC 8291 aes128gcm encryption + RFC 8292 VAPID).
// Uses only WebCrypto, so it runs unchanged in Supabase Edge Functions (Deno) and Node 20+.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string;   // base64url, 16 bytes
}

export interface VapidConfig {
  publicKey: string;  // base64url, 65-byte uncompressed point (as printed by `npx web-push generate-vapid-keys`)
  privateKey: string; // base64url, 32-byte scalar
  subject: string;    // "mailto:you@example.com" or an https URL
}

export interface PushOptions {
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Bytes {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Encrypts a payload for one subscription. Returns the aes128gcm message body. */
export async function encryptPayload(sub: PushSubscriptionKeys, payload: Uint8Array): Promise<Bytes> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid subscription keys');

  const asKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const recordSize = 4096;
  if (payload.length + 17 + 86 > recordSize) throw new Error('payload too large');
  const plaintext = concat(payload, new Uint8Array([2])); // 0x02 = last-record delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Builds the VAPID Authorization header value for an endpoint. */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const pub = b64urlDecode(vapid.publicKey);
  if (pub.length !== 65) throw new Error('invalid VAPID public key');
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: vapid.privateKey,
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,
    sub: vapid.subject,
  })));
  const signingInput = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export interface PushResult {
  endpoint: string;
  status: number;
  ok: boolean;
  gone: boolean; // subscription expired/unsubscribed — delete it
  error?: string;
}

export async function sendPush(sub: PushSubscriptionKeys, data: unknown, vapid: VapidConfig, opts: PushOptions = {}): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
    const headers: Record<string, string> = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSeconds ?? 120),
      Urgency: opts.urgency ?? 'high',
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
    };
    if (opts.topic) headers.Topic = opts.topic;
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    const text = res.ok ? '' : (await res.text()).slice(0, 300);
    return { endpoint: sub.endpoint, status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, error: text || undefined };
  } catch (e) {
    return { endpoint: sub.endpoint, status: 0, ok: false, gone: false, error: String(e) };
  }
}
