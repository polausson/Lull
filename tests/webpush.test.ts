// Verifies the Web Push encryption against an independent decryption written with node:crypto,
// and the VAPID JWT against node:crypto signature verification. Run: npx tsx --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { encryptPayload, vapidAuthorization, sendPush, b64urlEncode, b64urlDecode } from '../supabase/functions/_shared/webpush.ts';

function makeBrowserSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) } };
}

// Independent RFC 8291 decryption (what the browser does).
function decrypt(body: Uint8Array, ecdh: crypto.ECDH, authSecret: Buffer): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  return pt.subarray(0, pt.length - 1).toString('utf8');
}

function makeVapid() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64urlEncode(ecdh.getPublicKey()), privateKey: b64urlEncode(ecdh.getPrivateKey()), subject: 'mailto:test@example.com' };
}

test('payload round-trips through independent decryption', async () => {
  const s = makeBrowserSubscription();
  const msg = JSON.stringify({ title: 'Sound detected', url: '/?event=abc', ü: 'åäö' });
  const body = await encryptPayload({ endpoint: 'https://x', ...s.keys }, new TextEncoder().encode(msg));
  assert.equal(decrypt(body, s.ecdh, s.auth), msg);
});

test('VAPID JWT verifies with the public key', async () => {
  const vapid = makeVapid();
  const header = await vapidAuthorization('https://web.push.apple.com/abc/def', vapid, 1_800_000_000);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  const [h, c, sig] = m![1].split('.');
  const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.exp, 1_800_000_000 + 43200);
  assert.equal(m![2], vapid.publicKey);
  const pub = b64urlDecode(vapid.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(sig)));
  assert.ok(ok, 'signature valid');
});

test('sendPush posts correct headers and reports gone subscriptions', async () => {
  const s = makeBrowserSubscription();
  const seen: { headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url === '/gone' ? 410 : 201;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const vapid = makeVapid();
  const r1 = await sendPush({ endpoint: `http://127.0.0.1:${port}/ok`, ...s.keys }, { a: 1 }, vapid, { topic: 'sound' });
  const r2 = await sendPush({ endpoint: `http://127.0.0.1:${port}/gone`, ...s.keys }, { a: 1 }, vapid);
  server.close();
  assert.ok(r1.ok && !r1.gone);
  assert.ok(!r2.ok && r2.gone);
  assert.equal(seen[0].headers['content-encoding'], 'aes128gcm');
  assert.equal(seen[0].headers.urgency, 'high');
  assert.equal(seen[0].headers.topic, 'sound');
  assert.equal(decrypt(seen[0].body, s.ecdh, s.auth), '{"a":1}');
});
