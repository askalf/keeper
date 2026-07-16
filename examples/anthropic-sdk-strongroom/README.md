# Example: an Anthropic SDK client that never holds its API key

Run the genuine **Anthropic SDK** (`@anthropic-ai/sdk`, a real
`messages.create` call over real HTTP) with an API key that **never enters its
environment, config, or code**. The only change versus an ungoverned setup is
two lines of client config:

```js
new Anthropic({
  apiKey: 'sk-ant-keeper-placeholder-not-a-key',      // a placeholder
  baseURL: 'http://127.0.0.1:<broker>/<lease>',        // the keeper broker
})
```

keeper's egress broker checks the lease (upstream binding + path allowlist +
TTL + use budget + rate cap), redeems it atomically, and injects the **real**
key into the `x-api-key` header at the network boundary — on its own upstream
request (`x-api-key` is how Anthropic API-key auth works, hence
`--inject x-api-key`; the SDK's own `anthropic-version` protocol header passes
through untouched). The agent's placeholder `x-api-key` is stripped, never
forwarded. The real key exists in exactly two places: keeper's encrypted
vault, and the provider that verifies it.

**And the response comes back sanitized.** This demo's upstream deliberately
misbehaves the way real debug endpoints and verbose errors do: it reflects the
key it received in a response header. The broker's response sanitizer redacts
it — the agent receives `[keeper:redacted]`, and the real key appears nowhere
in anything the agent ever sees. Without that, a reflecting upstream would
hand the raw key straight back into the agent's context.

```
Anthropic SDK ──▶ keeper broker ──▶ upstream API
 placeholder       lease check +      verifies the REAL key
 broker baseURL    REAL key inject    (reflects it — redacted on the way back)
```

This is the antidote to the leaked-agent-key failure mode: a long-lived key in
the agent's env leaks to logs, traces, crash dumps, and poisoned tools. A
lease leaks nothing — it is bound to one upstream and specific paths, it
expires, it has a use budget, and revoking it kills the agent's access
instantly **without rotating the real key**.

The upstream here is a local stub that plays `api.anthropic.com`: it rejects
any request without the real key and returns a normal Messages API response —
so the whole example runs **offline with no Anthropic account**, while the
agent-side path (SDK → HTTP → broker → upstream) is exactly what production
runs.

## Files

| File | What it is |
|------|------------|
| `agent_leased_flow.mjs` | the Anthropic SDK client; its model calls go through a keeper broker lease |
| `verify_audit.mjs` | re-verifies the run's audit chain and proves it is tamper-evident (mid-chain edit + tail truncation both caught) |
| `evidence/` | captured stdout, `audit.jsonl`, verify output, and exact version provenance from a real run |
| `package.json` | pinned Anthropic SDK version |

## Run

From a keeper checkout:

```bash
cd examples/anthropic-sdk-strongroom
npm install
npm run demo      # -> ANTHROPIC_SDK_KEEPER_PASS
npm run verify    # -> AUDIT_VERIFY_PASS  (re-checks the audit the demo left behind)
```

## What the run proves

1. **The client works normally** — a genuine `messages.create` call completes
   through the leased channel.
2. **The upstream saw the real key** — injected into `x-api-key` by the broker
   at egress; the agent's placeholder header was stripped, never forwarded,
   and the SDK's `anthropic-version` header passed through untouched.
3. **The agent never held the key** — it appears nowhere in the agent
   process's env; the client holds only a placeholder.
4. **A reflected key can't come back** — the upstream echoes the key it
   received; the agent sees `[keeper:redacted]`, and the real key appears
   nowhere in anything the agent received. Audited as a `sanitize` event.
5. **The lease is scoped** — the same lease that serves `/v1/messages` gets a
   403 on `/v1/organizations/keys`, and the denial consumes no use.
6. **Revocation is instant** — `keeper revoke` kills the channel; the real key
   is never rotated, and nothing further reaches the upstream.
7. **Everything is audited** — add → grant → redeem → sanitize → deny →
   revoke, in a hash-chained, tip-authenticated log that fails verification on
   a one-byte mid-chain edit **and** on tail truncation.

## Adapting this to your stack

This is the `x-api-key` variant of the pattern; the sibling
[`openai-agents-strongroom`](../openai-agents-strongroom/) example is the
`Authorization: Bearer` variant. Any client that takes a base URL inherits it
unchanged: point the base URL at `http://127.0.0.1:<port>/<lease>`, hand the
client a placeholder key, and grant the lease with the matching `--inject`
(`x-api-key` for Anthropic, `bearer` for OpenAI-compatible APIs, or any custom
`Header-Name`).

One honest caveat about this demo's shape: everything here runs in one process
so the example is self-contained. In a real deployment the vault and broker
live in your control plane (the process that runs `keeper serve` /
`startBroker`), and the agent runs as a separate process that receives only
the lease id — it has no path to the master key at all. That is exactly how
the askalf platform runs keeper in production: the orchestrator holds the
vault, spawned agents get a lease and a placeholder, and the real keys never
enter any agent's environment.
