// keeper's use in the platform/fleet: ship a LEASE to the device, not a key.
// The credential never lands on the device; a compromised device yields a
// scoped, revocable lease; revoke kills it without rotating the real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
process.env.KEEPER_HOME = path.join(os.tmpdir(), 'keeper-plat-' + process.pid);
const { addSecret, grant, revoke } = await import('../src/index.mjs');
const { startBroker } = await import('../src/broker.mjs');
const listen = (s) => new Promise((r) => s.on('listening', () => r(s.address().port)));

test('platform: the device runs on a lease via the broker — key never on the device; revoke kills it', async () => {
  let sawKey = null;
  const api = http.createServer((req, res) => { sawKey = req.headers['authorization'] || null; res.statusCode = 200; res.end('ok'); });
  api.listen(0, '127.0.0.1');
  const ap = await listen(api);

  // FLEET: store the task key in keeper, grant a scoped lease, "dispatch" only the lease id
  addSecret('TASK_KEY', 'sk-prod-key');
  const lease = grant('TASK_KEY', { ttlS: 300, uses: 50, upstream: `http://127.0.0.1:${ap}`, inject: 'bearer', paths: ['/v1/*'] });
  assert.ok(lease.id.startsWith('lease_') && !lease.id.includes('sk-prod-key'), 'the device gets a lease, not the key');

  // DEVICE: call the API through the broker — the key reaches the upstream, never the device
  const broker = startBroker({ port: 0 });
  const bp = await listen(broker);
  assert.equal((await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/models`)).status, 200);
  assert.equal(sawKey, 'Bearer sk-prod-key', 'the real key is injected at egress, not held by the device');

  // SCOPE: a path outside the lease's allowlist is refused even with a valid lease
  assert.equal((await fetch(`http://127.0.0.1:${bp}/${lease.id}/admin/keys`)).status, 403);

  // RESPONSE: revoke the lease → the device can no longer use it (no key rotation needed)
  revoke(lease.id);
  assert.equal((await fetch(`http://127.0.0.1:${bp}/${lease.id}/v1/models`)).status, 403);

  api.close(); broker.close();
});
