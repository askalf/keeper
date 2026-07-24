// The audit chain is a CROSS-TOOL COMPATIBILITY SURFACE. strongroom vendors the
// primitive (src/chain.mjs, from redstamp) instead of depending on it over git,
// so nothing but these tests stops the two copies from silently drifting apart —
// and a drift is not a cosmetic bug: redstamp could no longer verify a strongroom
// audit log, and every already-written log on disk would stop verifying.
//
// The vectors below were computed with **redstamp's own implementation** (the
// `@askalf/redstamp/audit` module strongroom shipped through v0.3.0). They pin
// the hash construction AND the on-disk record shape. If you sync src/chain.mjs
// with upstream and this test goes red, the format changed — that is a breaking
// change to every existing audit log, not something to re-baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS, hashOf, ChainedFileAudit, verifyAuditFile } from '../src/chain.mjs';

const RECORDS = [
  { ts: '2026-01-01T00:00:00.000Z', event: 'add', name: 'OPENAI_API_KEY' },
  { ts: '2026-01-01T00:00:01.000Z', event: 'grant', name: 'OPENAI_API_KEY', lease: 'fp_abc123', ttlS: 300, uses: 1 },
  { ts: '2026-01-01T00:00:02.000Z', event: 'redeem', lease: 'fp_abc123', ok: true },
];

// Computed with @askalf/redstamp/audit @ 3da60b9 — the exact dependency the
// published @askalf/strongroom@0.3.0 resolved at install time.
const GOLDEN = [
  'c14a403b51d9a5031737b37470719d5afae4e174079ec6be100c2291dad71735',
  'e3c3163650696204fd4e4f3ff3424c938eeffeb0ff81defef89fb94bbabfbbeb',
  'f1447d595a4e2af9f3131f09f13d9c1d85a534fbc8846ad13e4bf8b162823697',
];

const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-chain-')), 'audit.jsonl');

test('the vendored chain reproduces redstamp\'s hashes byte for byte', () => {
  assert.equal(GENESIS, '0'.repeat(64));
  assert.equal(hashOf(GENESIS, RECORDS[0]), GOLDEN[0]);

  const p = tmpLog();
  const chain = new ChainedFileAudit(p);
  const entries = RECORDS.map((r) => chain.record(r));
  assert.deepEqual(entries.map((e) => e.hash), GOLDEN);
  assert.deepEqual(entries.map((e) => e.prev), [GENESIS, GOLDEN[0], GOLDEN[1]]);
});

test('the on-disk record shape is unchanged (record fields, then prev, then hash)', () => {
  const p = tmpLog();
  const chain = new ChainedFileAudit(p);
  RECORDS.forEach((r) => chain.record(r));

  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 3);
  // Field ORDER is part of the format: the hash is over JSON.stringify(rec), so
  // a reordered record serializes to a different hash on the next writer.
  assert.equal(
    lines[0],
    '{"ts":"2026-01-01T00:00:00.000Z","event":"add","name":"OPENAI_API_KEY"'
      + `,"prev":"${GENESIS}","hash":"${GOLDEN[0]}"}`,
  );
  assert.deepEqual(Object.keys(JSON.parse(lines[2])), ['ts', 'event', 'lease', 'ok', 'prev', 'hash']);
});

test('verifyAuditFile accepts the golden log and rejects an edited entry', () => {
  const p = tmpLog();
  const chain = new ChainedFileAudit(p);
  RECORDS.forEach((r) => chain.record(r));
  assert.deepEqual(verifyAuditFile(p), { ok: true, entries: 3 });

  // Rewrite the middle record's payload, keeping its hash — the classic
  // "make the denial look like an approval" edit.
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const tampered = JSON.parse(lines[1]);
  tampered.uses = 999;
  fs.writeFileSync(p, [lines[0], JSON.stringify(tampered), lines[2]].join('\n') + '\n');

  const v = verifyAuditFile(p);
  assert.equal(v.ok, false);
  assert.equal(v.at, 1);
});

test('a chain seeded from an existing file continues it across processes', () => {
  // How strongroom actually writes: one CLI invocation = one record, re-seeding
  // from the file. A regression here would re-root the chain at GENESIS and
  // silently break verification of everything already on disk.
  const p = tmpLog();
  RECORDS.forEach((r) => new ChainedFileAudit(p).record(r));
  assert.deepEqual(verifyAuditFile(p), { ok: true, entries: 3 });
  assert.deepEqual(
    fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).hash),
    GOLDEN,
  );
});

test('strongroom declares no runtime dependencies', () => {
  // The point of vendoring: `npm i @askalf/strongroom` must never need git, a
  // GitHub reachable network, or a registry lookup beyond strongroom itself —
  // it installs where the secrets are, including air-gapped and git-less images.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.optionalDependencies ?? {}, {});
  assert.deepEqual(pkg.peerDependencies ?? {}, {});
});
