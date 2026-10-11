// Smoke test for src/static-proxy.ts — drives the compiled dist/ output.
// 1. parses proxies.txt  2. verifies an upstream  3. starts the relay
// 4. CONNECTs through the relay (simulating Chrome) and reads api.ipify.org
const net = require('net');
const tls = require('tls');
const sp = require('./dist/static-proxy');

const PROXY_FILE = './proxies.txt';
const RELAY_PORT = 19999;

async function httpsThroughRelay(relayPort, target, path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(relayPort, '127.0.0.1');
    sock.once('connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.off('data', onData);
      const status = parseInt(head.split(' ')[1], 10);
      if (status !== 200) return reject(new Error('relay CONNECT → ' + status));
      const tlsSock = tls.connect({ socket: sock, servername: target.split(':')[0], rejectUnauthorized: false });
      tlsSock.once('secureConnect', () => {
        tlsSock.write(`GET ${path} HTTP/1.1\r\nHost: ${target.split(':')[0]}\r\nConnection: close\r\n\r\n`);
      });
      let body = '';
      tlsSock.on('data', (c) => (body += c.toString('latin1')));
      tlsSock.once('close', () => resolve(body));
      tlsSock.once('error', reject);
      setTimeout(() => reject(new Error('https-through-relay timeout')), 15000);
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

(async () => {
  console.log('=== parse ===');
  const proxies = sp.loadProxies(PROXY_FILE);
  console.log(`loaded ${proxies.length} proxies:`, proxies.map((p) => p.label).join(', '));
  if (proxies.length === 0) { console.log('NO PROXIES'); process.exit(1); }

  console.log('\n=== verifyUpstream (first proxy) ===');
  const check = await sp.verifyUpstream(proxies[0]);
  console.log('verify result:', check ? `IP ${check.ip} in ${check.ms}ms` : 'FAILED (null)');

  console.log('\n=== relay end-to-end ===');
  const relay = new sp.StaticProxyRelay(proxies, 0, RELAY_PORT);
  await relay.start();
  const body = await httpsThroughRelay(RELAY_PORT, 'api.ipify.org:443', '/');
  const ipMatch = body.match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
  console.log('through-relay api.ipify.org body tail:', body.slice(-60));
  console.log('egress IP via relay:', ipMatch ? ipMatch[0] : 'NOT FOUND');

  console.log('\n=== rotate() ===');
  const ok = await relay.rotate('smoke-test');
  console.log('rotate returned:', ok, '→ now on', relay.currentProxy.label);

  await relay.close();
  process.exit(ipMatch ? 0 : 2);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
