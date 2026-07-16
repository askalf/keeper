// An OpenAI Agents SDK agent whose API key NEVER enters its environment.
//
// The agent is the genuine `@openai/agents` runtime (an `Agent` run by the
// SDK's run loop, making a real HTTP model call through the real `openai`
// client). The only change versus an ungoverned setup is the client config:
//
//   baseURL: http://127.0.0.1:<broker>/<lease>/v1     apiKey: a PLACEHOLDER
//
// keeper's egress broker checks the lease (path allowlist + rate + TTL +
// use-count), redeems it atomically, and injects the REAL key into the
// Authorization header at the network boundary — on its own upstream request.
// The agent's placeholder auth header is STRIPPED, never forwarded. The real
// key exists in exactly two places: keeper's encrypted vault, and the provider
// that verifies it. It is never in the agent's env, config, code, or logs.
//
//   Agents SDK run loop ─▶ openai client ─▶ keeper broker ─▶ upstream API
//     the agent            placeholder key     lease check +     verifies the
//                          broker base URL     REAL key inject   REAL key
//
// The upstream here is a local stub that plays api.openai.com: it REJECTS any
// request without the real key and returns a normal chat completion — so the
// whole example runs OFFLINE with no OpenAI account, while the agent-side path
// (SDK → HTTP → broker → upstream) is exactly what production runs. Every
// grant / redeem / deny / revoke lands in keeper's tamper-evident audit chain.
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
// A stub upstream playing api.openai.com. Like the real thing, it 401s any
// request that doesn't carry the REAL key. The key is generated fresh per run
// and exists only here and in keeper's vault — nowhere on the agent's side.
const REAL_KEY = 'sk-real-' + crypto.randomBytes(12).toString('hex');
const seenByUpstream = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seenByUpstream.push({ path: req.url, auth: req.headers['authorization'] ?? null });
    if (req.headers['authorization'] !== 'Bearer ' + REAL_KEY) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-keeper-example', object: 'chat.completion', created: 1,
      model: 'gpt-4.1-mini',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant',
        content: 'All deployments green. (Served only because the broker injected the real key.)',
      } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
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
console.log('1. operator: keeper add openai:prod  (encrypted at rest in the vault)');
addSecret('openai:prod', REAL_KEY);
console.log('2. operator: grant a scoped lease — this upstream only, /v1/chat/completions only, 120s, 5 uses');
const lease = grant('openai:prod', {
  ttlS: 120, uses: 5, upstream: UPSTREAM, inject: 'bearer',
  paths: ['/v1/chat/completions'], rate: 30,
});

const broker = startBroker({ port: 0, onLog: (m) => console.log('   [broker] ' + m) });
await once(broker, 'listening');
const BROKER = 'http://127.0.0.1:' + broker.address().port;

// ── the agent side ─────────────────────────────────────────────────────────────
// The genuine Agents SDK + openai client. The ONLY non-default config is the
// base URL (the broker + lease) and a placeholder key. No real key anywhere.
const { Agent, run, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } = await import('@openai/agents');
const { default: OpenAI } = await import('openai');

const PLACEHOLDER = 'sk-keeper-placeholder-not-a-key';
setTracingDisabled(true);           // tracing would upload spans to OpenAI; stay offline
setOpenAIAPI('chat_completions');
setDefaultOpenAIClient(new OpenAI({ apiKey: PLACEHOLDER, baseURL: BROKER + '/' + lease.id + '/v1' }));

console.log('3. agent: a real @openai/agents Agent makes a real model call — holding only the placeholder');
const agent = new Agent({
  name: 'status-reporter',
  instructions: 'You report deployment status.',
  model: 'gpt-4.1-mini',
});
const result = await run(agent, 'What is the deployment status?');

console.log('\n── proofs ─────────────────────────────────────────────────────────');
ok(String(result.finalOutput).includes('All deployments green'),
  'the agent completed its run through the leased channel');
ok(seenByUpstream.length === 1 && seenByUpstream[0].auth === 'Bearer ' + REAL_KEY,
  'upstream saw the REAL key — injected by the broker at egress');
ok(!seenByUpstream.some((s) => (s.auth ?? '').includes(PLACEHOLDER)),
  "the agent's placeholder auth header was STRIPPED, never forwarded");
ok(!process.env.OPENAI_API_KEY && !Object.values(process.env).includes(REAL_KEY),
  "the real key appears NOWHERE in the agent process's env");

// Scope: the same lease cannot reach an endpoint outside its path allowlist —
// a chat lease can't read /v1/admin/keys — and a denial consumes NO use.
const usesBefore = leaseMod.peekLease(lease.id).lease.usesLeft;
const offPath = await fetch(BROKER + '/' + lease.id + '/v1/admin/keys');
ok(offPath.status === 403, 'off-allowlist path (/v1/admin/keys) → 403, audited');
ok(leaseMod.peekLease(lease.id).lease.usesLeft === usesBefore, 'the denial consumed no use');

// Kill switch: revoke the lease — the channel dies WITHOUT rotating the real key.
console.log('4. operator: keeper revoke — kill this agent\'s access, key unrotated');
revoke(lease.id);
const afterRevoke = await fetch(BROKER + '/' + lease.id + '/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
ok(afterRevoke.status === 403, 'post-revoke call → 403 denied');
ok(seenByUpstream.length === 1, 'nothing further ever reached the upstream');

// Every step above is in keeper's hash-chained, tip-authenticated audit.
const v = audit.verify();
ok(v.ok === true, `audit chain verifies intact (${v.entries} entries)`);
const events = audit.read().map((e) => e.event);
for (const must of ['add', 'grant', 'redeem', 'deny', 'revoke']) {
  ok(events.includes(must), `audit records '${must}'`);
}

console.log('\naudit trail: ' + events.join(' → '));
console.log('\nOPENAI_AGENTS_KEEPER_PASS');
upstream.close();
broker.close();
process.exit(0);
