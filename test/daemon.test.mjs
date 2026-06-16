// The redeem-daemon: a doer redeems a lease over a local socket WITHOUT ever
// holding the master key. The daemon (which holds the key) does the atomic,
// audited redeem and returns the secret only for a valid lease + valid token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
process.env.KEEPER_HOME = path.join(os.tmpdir(), 'keeper-daemon-' + process.pid);
const { addSecret, grant } = await import('../src/index.mjs');
const { startDaemon } = await import('../src/daemon.mjs');
const { redeemViaDaemon, checkViaDaemon } = await import('../src/client.mjs');

const SOCK = process.platform === 'win32'
  ? '\\\\.\\pipe\\keeper-test-' + process.pid
  : path.join(os.tmpdir(), 'keeper-test-' + process.pid + '.sock');
const TOKEN = 'test-token-abc';
let daemon;

before(async () => {
  daemon = startDaemon({ socketPath: SOCK, infoFile: path.join(process.env.KEEPER_HOME, 'daemon.json'), token: TOKEN, onLog: () => {} });
  await once(daemon.server, 'listening');
});
after(() => daemon.close());

test('a doer redeems a lease through the daemon (no key in the client)', async () => {
  addSecret('GH_TOKEN', 'ghp_secret_value');
  const l = grant('GH_TOKEN', { ttlS: 120, uses: 1 });
  const r = await redeemViaDaemon(l.id, { socketPath: SOCK, token: TOKEN });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'ghp_secret_value');
});

test('the daemon enforces its token', async () => {
  addSecret('K', 'v');
  const l = grant('K', { ttlS: 120, uses: 1 });
  const bad = await redeemViaDaemon(l.id, { socketPath: SOCK, token: 'wrong' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unauthorized');
  // the lease was NOT consumed by the rejected call — it still redeems
  const good = await redeemViaDaemon(l.id, { socketPath: SOCK, token: TOKEN });
  assert.equal(good.value, 'v');
});

test('single-use is honored through the daemon', async () => {
  addSecret('ONE', 'once');
  const l = grant('ONE', { ttlS: 120, uses: 1 });
  assert.equal((await redeemViaDaemon(l.id, { socketPath: SOCK, token: TOKEN })).value, 'once');
  const again = await redeemViaDaemon(l.id, { socketPath: SOCK, token: TOKEN });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'exhausted');
});

test('check is non-consuming and never returns the secret', async () => {
  addSecret('C', 'cv');
  const l = grant('C', { ttlS: 120, uses: 1 });
  const chk = await checkViaDaemon(l.id, { socketPath: SOCK, token: TOKEN });
  assert.equal(chk.ok, true);
  assert.equal(chk.value, undefined);            // check never leaks the value
  assert.equal((await redeemViaDaemon(l.id, { socketPath: SOCK, token: TOKEN })).value, 'cv'); // still redeemable
});

test('an unknown lease is denied, not thrown', async () => {
  const r = await redeemViaDaemon('lease_does_not_exist', { socketPath: SOCK, token: TOKEN });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
});
