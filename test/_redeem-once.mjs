// Concurrency-test helper (spawned by security.test.mjs): wait for a shared
// start instant so all processes contend, redeem one lease, print OK / DENY.
// Guarded so the test runner can import it as a no-op when run without a lease.
import { redeem } from '../src/index.mjs';
const id = process.argv[2];
if (id) {
  const at = Number(process.argv[3] || 0);
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = redeem(id);
  process.stdout.write(r.ok ? 'OK' : 'DENY');
}
