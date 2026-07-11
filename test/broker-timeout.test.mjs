// Broker upstream timeout — a black-hole upstream (accepts the socket, never
// sends response headers) must get a bounded 504, and the per-lease concurrency
// slot must be RELEASED: before this, N hung requests through a --concurrency N
// lease wedged it permanently (every later call 429'd until a broker restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
process.env.KEEPER_HOME = path.join(os.tmpdir(), 'keeper-broker-tmo-' + process.pid);
const { addSecret, grant, audit } = await import('../src/index.mjs');
const { checkLease } = await import('../src/lease.mjs');
const { startBroker } = await import('../src/broker.mjs');

const up = (server) => new Promise((res) => server.on('listening', () => res(server.address().port)));
const SECRET = 'sk-timeout-secret-0123456789abcdef';

// Stub upstream whose FIRST request is a black hole (accepted, never answered);
// every later request answers normally — so the same lease/upstream can prove
// the slot recovered.
function blackHoleOnce() {
  let hang = true;
  const stub = http.createServer((req, res) => { if (hang) { hang = false; return; } res.end('ok'); });
  stub.listen(0, '127.0.0.1');
  return stub;
}

test('hung upstream → bounded 504 (audited), and the concurrency slot is released, not wedged', async () => {
  const stub = blackHoleOnce();
  addSecret('TMO', SECRET);
  const lease = grant('TMO', { uses: 10, upstream: `http://127.0.0.1:${await up(stub)}`, inject: 'bearer', concurrency: 1 });
  const broker = startBroker({ port: 0, timeoutMs: 400 });
  const bp = await up(broker);

  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/hang`);
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 504, 'hung upstream answered with 504');
  assert.ok(elapsed < 5000, `bounded by ~timeoutMs, not the upstream's patience (took ${elapsed}ms)`);
  const bodyText = await r.text();
  assert.match(bodyText, /upstream timeout/, 'structured, named error');
  assert.ok(!bodyText.includes(SECRET), 'the error leaks no secret');
  assert.ok(!bodyText.includes(lease.id), 'the error leaks no raw lease id');
  assert.ok(audit.read().some((e) => e.event === 'deny' && e.reason === 'timeout' && e.via === 'broker'), 'timeout audited as deny/timeout');

  // the exact failure mode from the issue: a --concurrency 1 lease that just
  // timed out serves the very next request (slot recovered, not 429)
  assert.equal((await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/ok`)).status, 200, 'lease usable immediately after a timeout');

  // documented semantics: the hung request's use WAS spent — the secret was
  // injected and the request left the box (10 - hung - ok = 8)
  assert.equal(checkLease(lease.id).lease.usesLeft, 8, 'timed-out request consumed its use');

  broker.close(); stub.close(); stub.closeAllConnections?.();
});

test('KEEPER_BROKER_TIMEOUT_MS sets the default when no timeoutMs option is given', async () => {
  const stub = blackHoleOnce();
  addSecret('TMOENV', SECRET);
  const lease = grant('TMOENV', { uses: 5, upstream: `http://127.0.0.1:${await up(stub)}`, inject: 'bearer' });
  process.env.KEEPER_BROKER_TIMEOUT_MS = '300';
  let broker;
  try { broker = startBroker({ port: 0 }); } finally { delete process.env.KEEPER_BROKER_TIMEOUT_MS; }
  const bp = await up(broker);

  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/hang`);
  assert.equal(r.status, 504);
  assert.ok(Date.now() - t0 < 5000, 'env-configured timeout applied');

  broker.close(); stub.close(); stub.closeAllConnections?.();
});

test('a healthy upstream is unaffected by the timeout (response inside the bound relays normally)', async () => {
  const stub = http.createServer((req, res) => setTimeout(() => res.end('slow-but-fine'), 100));
  stub.listen(0, '127.0.0.1');
  addSecret('TMOOK', SECRET);
  const lease = grant('TMOOK', { uses: 5, upstream: `http://127.0.0.1:${await up(stub)}`, inject: 'bearer' });
  const broker = startBroker({ port: 0, timeoutMs: 2000 });
  const bp = await up(broker);

  const r = await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/ok`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'slow-but-fine');

  broker.close(); stub.close(); stub.closeAllConnections?.();
});
