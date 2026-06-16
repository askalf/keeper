// Lightweight client for the keeper redeem-daemon. A doer (or a remote agent)
// holds only a LEASE id + the daemon's capability token — never the master key.
// It asks the daemon to redeem; the daemon (which holds the key) returns the
// secret if the lease is valid. node:net only — no vault, no crypto here.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function keeperSocket() {
  if (process.env.KEEPER_SOCKET) return process.env.KEEPER_SOCKET;
  return process.platform === 'win32' ? '\\\\.\\pipe\\keeper' : path.join(os.tmpdir(), 'keeper.sock');
}

/** The 0600 file the daemon writes with its socket + capability token. */
export function daemonInfoFile() {
  if (process.env.KEEPER_DAEMON_INFO) return process.env.KEEPER_DAEMON_INFO;
  const home = process.env.KEEPER_HOME || path.join(os.homedir(), '.keeper');
  return path.join(home, 'daemon.json');
}

/** Token from $KEEPER_DAEMON_TOKEN, else from the 0600 info file. */
export function daemonToken() {
  if (process.env.KEEPER_DAEMON_TOKEN) return process.env.KEEPER_DAEMON_TOKEN;
  try { return JSON.parse(fs.readFileSync(daemonInfoFile(), 'utf8')).token || undefined; } catch { return undefined; }
}

function request(payload, { socketPath = keeperSocket(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = net.connect(socketPath);
    const to = setTimeout(() => finish({ ok: false, reason: 'daemon-timeout' }), timeoutMs);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify({ ...payload, token: payload.token ?? daemonToken() }) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(to); try { finish(JSON.parse(buf.slice(0, i))); } catch { finish({ ok: false, reason: 'bad-reply' }); } }
    });
    // Fail CLOSED on any transport failure — never silently fall back to a
    // keyless local redeem (which can't decrypt anyway).
    sock.on('error', () => { clearTimeout(to); finish({ ok: false, reason: 'daemon-unreachable' }); });
    sock.on('close', () => { clearTimeout(to); finish({ ok: false, reason: 'daemon-closed' }); });
  });
}

/** Redeem a lease THROUGH the daemon — the caller never needs the master key. */
export function redeemViaDaemon(lease, { host, socketPath, token } = {}) {
  return request({ op: 'redeem', lease, host, token }, { socketPath });
}
/** Non-consuming validity check via the daemon (never returns the secret). */
export function checkViaDaemon(lease, { host, socketPath, token } = {}) {
  return request({ op: 'check', lease, host, token }, { socketPath });
}
