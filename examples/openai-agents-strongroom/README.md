# Example: an OpenAI Agents SDK agent that never holds its API key

Run a real **OpenAI Agents SDK** agent (the `@openai/agents` runtime — an
`Agent` executed by the SDK's run loop, making a genuine HTTP model call
through the genuine `openai` client) whose API key **never enters its
environment, config, or code**. The only change versus an ungoverned setup is
two lines of client config:

```js
new OpenAI({
  apiKey: 'sk-keeper-placeholder-not-a-key',              // a placeholder
  baseURL: 'http://127.0.0.1:<broker>/<lease>/v1',        // the keeper broker
})
```

keeper's egress broker checks the lease (upstream binding + path allowlist +
TTL + use budget + rate cap), redeems it atomically, and injects the **real**
key into the `Authorization` header at the network boundary — on its own
upstream request. The agent's placeholder auth header is stripped, never
forwarded. The real key exists in exactly two places: keeper's encrypted
vault, and the provider that verifies it.

```
Agents SDK run loop ──▶ openai client ──▶ keeper broker ──▶ upstream API
    the agent           placeholder key     lease check +      verifies the
                        broker base URL     REAL key inject    REAL key
```

This is the antidote to the leaked-agent-key failure mode: a long-lived key in
the agent's env leaks to logs, traces, crash dumps, and poisoned tools. A
lease leaks nothing — it is bound to one upstream and specific paths, it
expires, it has a use budget, and revoking it kills the agent's access
instantly **without rotating the real key**.

The upstream here is a local stub that plays `api.openai.com`: it rejects any
request without the real key and returns a normal chat completion — so the
whole example runs **offline with no OpenAI account**, while the agent-side
path (SDK → HTTP → broker → upstream) is exactly what production runs.

## Files

| File | What it is |
|------|------------|
| `agent_leased_flow.mjs` | the OpenAI Agents SDK agent; its model calls go through a keeper broker lease |
| `verify_audit.mjs` | re-verifies the run's audit chain and proves it is tamper-evident (mid-chain edit + tail truncation both caught) |
| `evidence/` | captured stdout, `audit.jsonl`, verify output, and exact version provenance from a real run |
| `package.json` | pinned Agents SDK + openai client versions |

## Run

From a keeper checkout:

```bash
cd examples/openai-agents-strongroom
npm install
npm run demo      # -> OPENAI_AGENTS_KEEPER_PASS
npm run verify    # -> AUDIT_VERIFY_PASS  (re-checks the audit the demo left behind)
```

## What the run proves

1. **The agent works normally** — the genuine Agents SDK run loop completes a
   model call through the leased channel.
2. **The upstream saw the real key** — injected by the broker at egress; the
   agent's placeholder header was stripped, never forwarded.
3. **The agent never held the key** — it appears nowhere in the agent
   process's env; the client holds only a placeholder.
4. **The lease is scoped** — the same lease that serves `/v1/chat/completions`
   gets a 403 on `/v1/admin/keys`, and the denial consumes no use.
5. **Revocation is instant** — `keeper revoke` kills the channel; the real key
   is never rotated, and nothing further reaches the upstream.
6. **Everything is audited** — add → grant → redeem → deny → revoke, in a
   hash-chained, tip-authenticated log that fails verification on a one-byte
   mid-chain edit **and** on tail truncation.

## Adapting this to your stack

Any framework that takes an OpenAI-compatible `baseURL` (LangChain, CrewAI,
LlamaIndex, plain `openai`/`anthropic` clients, …) inherits this pattern
unchanged: point the base URL at `http://127.0.0.1:<port>/<lease>` and hand
the framework a placeholder key. For Anthropic clients, grant with
`inject: 'x-api-key'`.

One honest caveat about this demo's shape: everything here runs in one process
so the example is self-contained. In a real deployment the vault and broker
live in your control plane (the process that runs `keeper serve` /
`startBroker`), and the agent runs as a separate process that receives only
the lease id — it has no path to the master key at all. That is exactly how
the askalf platform runs keeper in production: the orchestrator holds the
vault, spawned agents get a lease and a placeholder, and the real keys never
enter any agent's environment.
