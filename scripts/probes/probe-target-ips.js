const sp = require('./dist/static-proxy');
const tls = require('tls');

const USER = 'disp_728c4059';
const PASS = '+b56lpmZWvdO379G';
const TARGET = 'usvisascheduling.com';

async function testPort(port) {
  const entry = { protocol: 'http', host: 'disp.oxylabs.io', port, username: USER, password: PASS };
  const r = { port, egress: null, connect: null, http: null };
  try {
    // egress IP via api.ipify.org through the same proxy
    const v = await sp.verifyUpstream(entry, 10000).catch(() => null);
    r.egress = v ? v.ip : 'verify-fail';
    // CONNECT to target
    const { socket } = await sp.dialUpstream(entry, TARGET + ':443', 12000);
    // TLS handshake + GET / to see the actual response code
    const tlsSock = tls.connect({ socket, servername: TARGET });
    r.http = await new Promise((resolve) => {
      const to = setTimeout(() => resolve('TLS-timeout'), 10000);
      tlsSock.once('secureConnect', () => {
        tlsSock.write(`GET /en-US/sign-in/ HTTP/1.1\r\nHost: ${TARGET}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      tlsSock.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/^HTTP\/\d\.\d (\d{3})/);
        if (m) { clearTimeout(to); tlsSock.destroy(); resolve('HTTP ' + m[1]); }
      });
      tlsSock.once('error', (e) => { clearTimeout(to); resolve('TLS-err ' + (e.code || e.message)); });
      tlsSock.once('end', () => { clearTimeout(to); resolve(buf ? 'closed-no-status' : 'TLS-closed'); });
    });
  } catch (e) {
    r.connect = String(e.message || e).slice(0, 70);
  }
  return r;
}

(async () => {
  const ports = Array.from({ length: 35 }, (_, i) => 8001 + i);
  const queue = ports.slice();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const r = await testPort(p);
      console.log(`:${p}  egress=${(r.egress || '-').padEnd(16)} ${r.connect ? 'CONNECT-FAIL ' + r.connect : 'conn-ok ' + r.http}`);
    }
  }));
})();
