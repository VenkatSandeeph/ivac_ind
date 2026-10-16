import fs from 'fs';
import net from 'net';
import tls from 'tls';
import path from 'path';
import { info, warn, client } from './logger';
import type { AutomationConfig } from './config';

/**
 * Static IP mode: a local CONNECT relay bound to 127.0.0.1:<port> that tunnels
 * Chrome's traffic through the currently-selected upstream proxy. Chrome is
 * launched once with --proxy-server=http://127.0.0.1:<port>; rotation swaps the
 * upstream pointer inside the relay — no relaunch, no dropped page.
 *
 * Proxies come from proxies.txt: one per line, `host:port[:user:pass]` with an
 * optional `http://`/`socks5://` prefix (default http). The upstream dial is
 * the single protocol seam (dialUpstream) so SOCKS5 lines just work.
 *
 * Round-robin is shared across profiles via .ivac-proxy-index + a lock file —
 * two static profiles never land on the same upstream.
 */

export type ProxyProtocol = 'http' | 'socks5';

export type ProxyEntry = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  label: string; // "proto://host:port" — safe to log, never contains credentials
};

/** Written by the UI Rotate IP button; each static core advances once per new mtime. */
export const STATIC_ROTATE_FLAG = path.resolve(process.cwd(), '.ivac-rotate-static');
const PROXY_INDEX_FILE = path.resolve(process.cwd(), '.ivac-proxy-index');
const PROXY_LOCK_FILE = path.resolve(process.cwd(), '.ivac-proxy-lock');
const LAST_IP_FILE = path.resolve(process.cwd(), '.ivac-static-last-ip');
const VERIFY_TARGET = 'api.ipify.org:443';

// ---------------------------------------------------------------------------
//  proxies.txt parsing
// ---------------------------------------------------------------------------

export function loadProxies(filePath: string): ProxyEntry[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: ProxyEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let protocol: ProxyProtocol = 'http';
    let rest = line;
    const m = /^([a-zA-Z0-9]+):\/\/(.+)$/.exec(line);
    if (m) {
      protocol = m[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http';
      rest = m[2];
    }
    const parts = rest.split(':');
    const host = (parts[0] || '').trim();
    const port = parseInt(parts[1] || '', 10);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      warn(`[STATIC IP] Skipping malformed proxies.txt line: "${line.substring(0, 60)}"`);
      continue;
    }
    // host:port:user:pass — password may itself contain ':' so join the tail.
    const username = parts.length >= 3 ? parts[2] : null;
    const password = parts.length >= 4 ? parts.slice(3).join(':') : parts.length === 3 ? '' : null;
    out.push({ protocol, host, port, username, password, label: `${protocol}://${host}:${port}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Socket helpers
// ---------------------------------------------------------------------------

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('tcp connect timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Buffered reader that never loses over-read bytes (upstream may coalesce frames). */
class SockReader {
  private buf = Buffer.alloc(0);
  constructor(
    private sock: net.Socket,
    private timeoutMs: number
  ) {}

  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) this.buf = Buffer.concat([this.buf, await this.wait()]);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async untilMarker(marker: string): Promise<Buffer> {
    for (;;) {
      const i = this.buf.indexOf(marker);
      if (i >= 0) {
        const out = this.buf.subarray(0, i + marker.length);
        this.buf = this.buf.subarray(i + marker.length);
        return out;
      }
      this.buf = Buffer.concat([this.buf, await this.wait()]);
    }
  }

  takeLeftover(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }

  private wait(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(t);
        this.sock.off('data', onData);
        this.sock.off('error', onErr);
        this.sock.off('close', onEnd);
        this.sock.off('end', onEnd);
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new Error('proxy read timeout'));
      }, this.timeoutMs);
      const onData = (c: Buffer) => {
        cleanup();
        resolve(c);
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('proxy closed connection'));
      };
      this.sock.once('data', onData);
      this.sock.once('error', onErr);
      this.sock.once('close', onEnd);
      this.sock.once('end', onEnd);
    });
  }
}

function splitHostPort(target: string): [string, number] {
  const i = target.lastIndexOf(':');
  return [target.slice(0, i), parseInt(target.slice(i + 1), 10)];
}

// ---------------------------------------------------------------------------
//  Upstream dialers — the single protocol seam. Returns a socket already
//  tunneled to `target` ("host:port") through the upstream proxy.
// ---------------------------------------------------------------------------

export type UpstreamTunnel = { socket: net.Socket; reader: SockReader };

async function dialHttp(proxy: ProxyEntry, target: string, timeoutMs: number): Promise<UpstreamTunnel> {
  const socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SockReader(socket, timeoutMs);
  const auth =
    proxy.username != null
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
      : '';
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`);
  const head = (await reader.untilMarker('\r\n\r\n')).toString('latin1');
  const statusLine = head.split('\r\n')[0];
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
  const status = m ? parseInt(m[1], 10) : 0;
  if (status !== 200) {
    socket.destroy();
    throw new Error(`upstream CONNECT → HTTP ${status}${status === 407 ? ' (proxy auth rejected)' : ''}`);
  }
  return { socket, reader };
}

async function dialSocks5(proxy: ProxyEntry, target: string, timeoutMs: number): Promise<UpstreamTunnel> {
  const socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SockReader(socket, timeoutMs);
  const authed = proxy.username != null;
  socket.write(authed ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  const greet = await reader.bytes(2);
  if (greet[0] !== 0x05) throw new Error('socks5: bad greeting');
  if (greet[1] === 0x02) {
    if (!authed) throw new Error('socks5: proxy requires auth, none provided');
    const u = Buffer.from(proxy.username!, 'utf8');
    const p = Buffer.from(proxy.password ?? '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await reader.bytes(2);
    if (auth[1] !== 0) throw new Error('socks5: auth rejected');
  } else if (greet[1] !== 0x00) {
    throw new Error(`socks5: no acceptable auth method (0x${greet[1].toString(16)})`);
  }
  const [thost, tport] = splitHostPort(target);
  const hostBuf = Buffer.from(thost, 'utf8');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hostBuf.length]), hostBuf, Buffer.from([tport >> 8, tport & 0xff])]));
  const head = await reader.bytes(5); // VER REP RSV ATYP + first addr byte
  if (head[0] !== 0x05 || head[1] !== 0x00) throw new Error(`socks5: connect failed (rep=0x${head[1].toString(16)})`);
  const atyp = head[3];
  const skip = atyp === 1 ? 3 + 2 : atyp === 3 ? head[4] + 2 : atyp === 4 ? 15 + 2 : 0;
  if (!skip) throw new Error('socks5: unknown ATYP in reply');
  await reader.bytes(skip); // remainder of bound address + port
  return { socket, reader };
}

export function dialUpstream(proxy: ProxyEntry, target: string, timeoutMs: number): Promise<UpstreamTunnel> {
  return proxy.protocol === 'socks5' ? dialSocks5(proxy, target, timeoutMs) : dialHttp(proxy, target, timeoutMs);
}

// ---------------------------------------------------------------------------
//  Egress verification — CONNECT to api.ipify.org through the candidate and
//  read the public IP it sees. Doubles as a liveness + protocol check.
// ---------------------------------------------------------------------------

export async function verifyUpstream(proxy: ProxyEntry, timeoutMs = 9000): Promise<{ ip: string; ms: number } | null> {
  const t0 = Date.now();
  try {
    const { socket } = await dialUpstream(proxy, VERIFY_TARGET, timeoutMs);
    const tlsSock = tls.connect({ socket, servername: 'api.ipify.org' });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        tlsSock.destroy();
        reject(new Error('tls handshake timeout'));
      }, timeoutMs);
      tlsSock.once('secureConnect', () => {
        clearTimeout(t);
        resolve();
      });
      tlsSock.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const body = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        tlsSock.destroy();
        reject(new Error('http read timeout'));
      }, timeoutMs);
      let data = '';
      tlsSock.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: ivac-core\r\nConnection: close\r\n\r\n');
      tlsSock.on('data', (c) => {
        data += c.toString('latin1');
      });
      const done = () => {
        clearTimeout(t);
        resolve(data);
      };
      tlsSock.once('end', done);
      tlsSock.once('close', done);
      tlsSock.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    tlsSock.destroy();
    const m = body.match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
    return m ? { ip: m[0], ms: Date.now() - t0 } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Shared round-robin index — file lock (.ivac-proxy-lock) so concurrent
//  profiles never claim the same upstream. Stale locks (>30s) are stolen.
// ---------------------------------------------------------------------------

async function withIndexLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(PROXY_LOCK_FILE, 'wx');
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(PROXY_LOCK_FILE);
        } catch {
          /* lock already gone */
        }
      }
    } catch (e: any) {
      if (e?.code === 'EEXIST') {
        try {
          const st = fs.statSync(PROXY_LOCK_FILE);
          if (Date.now() - st.mtimeMs > 30000) {
            try {
              fs.unlinkSync(PROXY_LOCK_FILE);
            } catch {
              /* raced */
            }
            continue;
          }
        } catch {
          /* stat failed — retry */
        }
        if (Date.now() > deadline) return fn();
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
        continue;
      }
      return fn(); // fs error — proceed unlocked rather than blocking rotation
    }
  }
}

async function claimNextIndex(count: number): Promise<number> {
  return withIndexLock(() => {
    let cur = -1;
    try {
      cur = parseInt(fs.readFileSync(PROXY_INDEX_FILE, 'utf8').trim(), 10);
    } catch {
      cur = -1;
    }
    const idx = (((Number.isFinite(cur) ? cur : -1) + 1) % count + count) % count;
    try {
      fs.writeFileSync(PROXY_INDEX_FILE, String(idx));
    } catch {
      /* next claim still works */
    }
    return idx;
  });
}

function writeLastIp(ip: string): void {
  try {
    fs.writeFileSync(LAST_IP_FILE, ip);
  } catch {
    /* display-only file */
  }
}

// ---------------------------------------------------------------------------
//  Relay — local CONNECT server on 127.0.0.1:<port>; upstream swappable.
// ---------------------------------------------------------------------------

export class StaticProxyRelay {
  private server: net.Server | null = null;
  private upstream: ProxyEntry;
  private index: number;
  private readonly proxies: readonly ProxyEntry[];
  private rotating = false;
  readonly port: number;

  constructor(proxies: readonly ProxyEntry[], index: number, port: number) {
    this.proxies = proxies;
    this.index = index;
    this.upstream = proxies[index];
    this.port = port;
  }

  get currentProxy(): ProxyEntry {
    return this.upstream;
  }
  get currentIndex(): number {
    return this.index;
  }

  async start(): Promise<void> {
    this.server = net.createServer((c) => this.handleClient(c));
    this.server.on('error', (e) => warn('[STATIC IP] relay socket error:', e.message));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', resolve);
    });
    info(`[STATIC IP] Relay listening on 127.0.0.1:${this.port} → ${this.upstream.label}`);
  }

  private handleClient(client: net.Socket): void {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (buf.length > 65536) client.destroy();
        return;
      }
      client.off('data', onData);
      const head = buf.subarray(0, i).toString('latin1');
      const rest = buf.subarray(i + 4);
      const reqLine = head.split('\r\n')[0];
      const m = /^CONNECT\s+(\S+)\s+HTTP\/\d/i.exec(reqLine);
      if (!m) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.tunnel(client, m[1], rest).catch(() => client.destroy());
    };
    client.on('data', onData);
    client.once('error', () => client.destroy());
  }

  private async tunnel(client: net.Socket, target: string, clientRest: Buffer): Promise<void> {
    try {
      const { socket: upstream, reader } = await dialUpstream(this.upstream, target, 12000);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const leftover = reader.takeLeftover();
      if (clientRest.length) upstream.write(clientRest);
      if (leftover.length) client.write(leftover);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.once('error', () => client.destroy());
      upstream.once('close', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
    } catch {
      try {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      } catch {
        /* client already gone */
      }
    }
  }

  /** Advance the shared round-robin to the next verified-live upstream. */
  async rotate(reason: string): Promise<boolean> {
    if (this.rotating) {
      info('[STATIC IP] rotation already in progress — skipping');
      return false;
    }
    this.rotating = true;
    try {
      const n = this.proxies.length;
      for (let i = 0; i < n; i++) {
        const idx = await claimNextIndex(n);
        const cand = this.proxies[idx];
        info(`[STATIC IP] Rotating to ${cand.label} (${reason}) — verifying…`);
        const check = await verifyUpstream(cand);
        if (check) {
          this.upstream = cand;
          this.index = idx;
          info(`[STATIC IP] Egress now via ${cand.label} — verified IP ${check.ip} (${check.ms}ms)`);
          client('🌐', `Static IP rotated → ${check.ip}`);
          writeLastIp(check.ip);
          return true;
        }
        warn(`[STATIC IP] ${cand.label} unreachable — trying next proxy`);
      }
      warn(`[STATIC IP] All ${n} proxies unreachable — keeping ${this.upstream.label}. Trigger: ${reason}`);
      client('⚠️', 'Static IP: all proxies unreachable — keeping current');
      return false;
    } finally {
      this.rotating = false;
    }
  }

  async close(): Promise<void> {
    try {
      this.server?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
//  Chrome marker — stored inside the profile's user-data-dir so the core can
//  tell "this Chrome was launched through my relay" from a direct instance.
// ---------------------------------------------------------------------------

export type RelayMarker = { relayPort: number; proxyLabel: string; pid: number };

function relayMarkerPath(config: AutomationConfig): string {
  return path.join(config.chromeUserDataDir, '.ivac-relay.json');
}

export function readRelayMarker(config: AutomationConfig): RelayMarker | null {
  try {
    return JSON.parse(fs.readFileSync(relayMarkerPath(config), 'utf8')) as RelayMarker;
  } catch {
    return null;
  }
}

export function writeRelayMarker(config: AutomationConfig, relayPort: number, proxyLabel: string): void {
  try {
    fs.mkdirSync(config.chromeUserDataDir, { recursive: true });
    fs.writeFileSync(
      relayMarkerPath(config),
      JSON.stringify({ relayPort, proxyLabel, pid: process.pid } satisfies RelayMarker)
    );
  } catch {
    /* marker is advisory */
  }
}

export function clearRelayMarker(config: AutomationConfig): void {
  try {
    fs.unlinkSync(relayMarkerPath(config));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
//  Startup — load list, find first live upstream from the shared pointer,
//  bind the relay, hand back the --proxy-server URL for Chrome.
// ---------------------------------------------------------------------------

export type StaticProxyStart = {
  relay: StaticProxyRelay;
  proxyUrl: string; // http://127.0.0.1:<port> — Chrome --proxy-server value
  relayPort: number;
  proxyLabel: string;
  ip: string | null;
};

export async function startStaticProxy(config: AutomationConfig): Promise<StaticProxyStart> {
  const file = config.staticProxy.file;
  const proxies = loadProxies(file);
  if (proxies.length === 0) {
    throw new Error(`STATIC IP mode: no usable proxies in ${file}. Add lines like host:port:user:pass (or switch IP mode).`);
  }
  info(`[STATIC IP] ${proxies.length} proxie(s) loaded from ${file}`);
  const port = config.chromeRemoteDebugPort + config.staticProxy.portOffset;

  let chosen = -1;
  let verified: { ip: string; ms: number } | null = null;
  for (let i = 0; i < proxies.length; i++) {
    const idx = await claimNextIndex(proxies.length);
    const cand = proxies[idx];
    info(`[STATIC IP] Testing ${cand.label}…`);
    const check = await verifyUpstream(cand);
    if (check) {
      chosen = idx;
      verified = check;
      break;
    }
    warn(`[STATIC IP] ${cand.label} unreachable — trying next`);
  }
  if (chosen < 0 || !verified) {
    throw new Error(
      `STATIC IP mode: all ${proxies.length} proxies in ${file} failed verification. Check the file/credentials, or pick AUTO IP / NO IP.`
    );
  }

  const relay = new StaticProxyRelay(proxies, chosen, port);
  await relay.start();
  info(`[STATIC IP] Upstream ${proxies[chosen].label} verified — egress IP ${verified.ip} (${verified.ms}ms)`);
  client('🌐', `Static IP: ${verified.ip}`);
  writeLastIp(verified.ip);
  return {
    relay,
    proxyUrl: `http://127.0.0.1:${port}`,
    relayPort: port,
    proxyLabel: proxies[chosen].label,
    ip: verified.ip
  };
}
