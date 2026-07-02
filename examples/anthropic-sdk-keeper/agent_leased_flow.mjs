// An Anthropic SDK client whose API key NEVER enters its environment.
//
// The agent side is the genuine `@anthropic-ai/sdk` client making a real
// `messages.create` call over real HTTP. The only change versus an ungoverned
// setup is the client config:
//
//   baseURL: http://127.0.0.1:<broker>/<lease>     apiKey: a PLACEHOLDER
//
// keeper's egress broker checks the lease (path allowlist + rate + TTL +
// use-count), redeems it atomically, and injects the REAL key into the
// `x-api-key` header at the network boundary — on its own upstream request
// (`x-api-key` is how Anthropic API-key auth works; `--inject x-api-key`).
// The agent's placeholder x-api-key header is STRIPPED, never forwarded. The
// real key exists in exactly two places: keeper's encrypted vault, and the
// provider that verifies it. It is never in the agent's env, config, or logs.
//
// And the RESPONSE is sanitized on the way back: this demo's upstream plays a
// misconfigured provider that reflects the received key in a debug header —
// the broker redacts it before the agent sees it, so a reflecting upstream
// can't hand the raw key back into the agent's context.
//
//   Anthropic SDK ─▶ keeper broker ─▶ upstream API
//    placeholder      lease check +     verifies the REAL key,
//    broker baseURL   REAL key inject   (here: also reflects it — redacted)
//
// The upstream here is a local stub that plays api.anthropic.com: it REJECTS
// any request without the real key and returns a normal Messages API response
// — so the whole example runs OFFLINE with no Anthropic account, while the
// agent-side path (SDK → HTTP → broker → upstream) is exactly what production
// runs. Every grant / redeem / sanitize / deny / revoke lands in keeper's
// tamper-evident audit chain.
//
// Run (from a keeper checkout):  npm install && npm run demo
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Hermetic keeper state: a fresh vault in ./keeper-home (gitignored), keyed by
// a file master key inside it. Kept after the run so verify_audit.mjs can
// re-check the chain. Set env BEFORE importing keeper.
const KEEPER_HOME = path.join(here, 'keeper-home');
fs.rmSync(KEEPER_HOME, { recursive: true, force: true });
process.env.KEEPER_HOME = KEEPER_HOME;
delete process.env.KEEPER_PASSPHRASE;
delete process.env.KEEPER_KEYCHAIN;
delete process.env.KEEPER_DAEMON;

const { addSecret, grant, revoke, audit, lease: leaseMod } = await import('../../src/index.mjs');
const { startBroker } = await import('../../src/broker.mjs');

const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  console.log('   ✓ ' + msg);
};

// ── the provider side ─────────────────────────────────────────────────────────
// A stub upstream playing api.anthropic.com. Like the real thing, it 401s any
// request that doesn't carry the REAL key in x-api-key. The key is generated
// fresh per run and exists only here and in keeper's vault — nowhere on the
// agent's side. One deliberate misconfiguration: it reflects the key it
// received in a debug response header, the way verbose errors and debug
// endpoints do in the wild — which is exactly what the broker's response
// sanitizer exists to catch.
const REAL_KEY = 'sk-ant-real-' + crypto.randomBytes(12).toString('hex');
const seenByUpstream = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seenByUpstream.push({
      path: req.url,
      xApiKey: req.headers['x-api-key'] ?? null,
      anthropicVersion: req.headers['anthropic-version'] ?? null,
    });
    res.setHeader('x-debug-received-key', req.headers['x-api-key'] ?? 'none'); // the reflection
    if (req.headers['x-api-key'] !== REAL_KEY) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'msg_keeper_example', type: 'message', role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'All deployments green. (Served only because the broker injected the real key.)' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const UPSTREAM = 'http://127.0.0.1:' + upstream.address().port;

// ── the operator side ─────────────────────────────────────────────────────────
// Stash the key once (encrypted at rest), then mint a lease BOUND to this one
// upstream, ONE endpoint path, a TTL, a use budget, and a rate cap. The agent
// gets the opaque lease id — a capability, not a credential.
console.log('1. operator: keeper add anthropic:prod  (encrypted at rest in the vault)');
addSecret('anthropic:prod', REAL_KEY);
console.log('2. operator: grant a scoped lease — this upstream only, /v1/messages only, 120s, 5 uses');
const lease = grant('anthropic:prod', {
  ttlS: 120, uses: 5, upstream: UPSTREAM, inject: 'x-api-key',
  paths: ['/v1/messages'], rate: 30,
});

const broker = startBroker({ port: 0, onLog: (m) => console.log('   [broker] ' + m) });
await once(broker, 'listening');
const BROKER = 'http://127.0.0.1:' + broker.address().port;

// ── the agent side ─────────────────────────────────────────────────────────────
// The genuine Anthropic SDK. The ONLY non-default config is the base URL (the
// broker + lease) and a placeholder key. No real key anywhere.
const { default: Anthropic } = await import('@anthropic-ai/sdk');

const PLACEHOLDER = 'sk-ant-keeper-placeholder-not-a-key';
const anthropic = new Anthropic({ apiKey: PLACEHOLDER, baseURL: BROKER + '/' + lease.id });

console.log('3. agent: a real @anthropic-ai/sdk messages.create call — holding only the placeholder');
const { data: message, response: rawResponse } = await anthropic.messages
  .create({
    model: 'claude-opus-4-8',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'What is the deployment status?' }],
  })
  .withResponse();

console.log('\n── proofs ─────────────────────────────────────────────────────────');
const text = message.content.find((b) => b.type === 'text')?.text ?? '';
ok(text.includes('All deployments green'),
  'the agent completed its call through the leased channel');
ok(seenByUpstream.length === 1 && seenByUpstream[0].xApiKey === REAL_KEY,
  'upstream saw the REAL key in x-api-key — injected by the broker at egress');
ok(!seenByUpstream.some((s) => (s.xApiKey ?? '').includes(PLACEHOLDER)),
  "the agent's placeholder x-api-key header was STRIPPED, never forwarded");
ok(seenByUpstream[0].anthropicVersion != null,
  "the SDK's own protocol headers (anthropic-version) passed through untouched");
ok(!process.env.ANTHROPIC_API_KEY && !Object.values(process.env).includes(REAL_KEY),
  "the real key appears NOWHERE in the agent process's env");

// The upstream REFLECTED the key it received (debug header) — the broker's
// response sanitizer redacted it before the agent saw anything.
ok(rawResponse.headers.get('x-debug-received-key') === '[keeper:redacted]',
  'the upstream reflected the key; the agent received [keeper:redacted] instead');
ok(!JSON.stringify([...rawResponse.headers]).includes(REAL_KEY) && !JSON.stringify(message).includes(REAL_KEY),
  'the real key appears nowhere in anything the agent received');

// Scope: the same lease cannot reach an endpoint outside its path allowlist —
// a messages lease can't read /v1/organizations/keys — and a denial consumes NO use.
const usesBefore = leaseMod.peekLease(lease.id).lease.usesLeft;
const offPath = await fetch(BROKER + '/' + lease.id + '/v1/organizations/keys');
ok(offPath.status === 403, 'off-allowlist path (/v1/organizations/keys) → 403, audited');
ok(leaseMod.peekLease(lease.id).lease.usesLeft === usesBefore, 'the denial consumed no use');

// Kill switch: revoke the lease — the channel dies WITHOUT rotating the real key.
console.log('4. operator: keeper revoke — kill this agent\'s access, key unrotated');
revoke(lease.id);
const afterRevoke = await fetch(BROKER + '/' + lease.id + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
ok(afterRevoke.status === 403, 'post-revoke call → 403 denied');
ok(seenByUpstream.length === 1, 'nothing further ever reached the upstream');

// Every step above is in keeper's hash-chained, tip-authenticated audit.
const v = audit.verify();
ok(v.ok === true, `audit chain verifies intact (${v.entries} entries)`);
const events = audit.read().map((e) => e.event);
for (const must of ['add', 'grant', 'redeem', 'sanitize', 'deny', 'revoke']) {
  ok(events.includes(must), `audit records '${must}'`);
}

console.log('\naudit trail: ' + events.join(' → '));
console.log('\nANTHROPIC_SDK_KEEPER_PASS');
upstream.close();
broker.close();
process.exit(0);
