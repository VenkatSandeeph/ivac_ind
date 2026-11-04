// Proxy smoke-test against usvisascheduling.com — headed Patchright Chromium,
// one incognito context per proxy (per-context proxy auth). For each proxy:
//   1) exit IP via api.ipify.org through the tunnel (vs the claimed IP)
//   2) load https://www.usvisascheduling.com/en-US/ and classify:
//      OK(real page) | CF_CHALLENGE | CF_BLOCKED | HTTP_nnn | PROXY_FAIL
// Batched concurrency to keep runtime reasonable.
const { chromium } = require('patchright');
const fs = require('fs');

const PROXY_FILE = 'proxies-oxylabs-test.txt';
const SITE = 'https://www.usvisascheduling.com/en-US/';
const IPCHECK = 'https://api.ipify.org';
const BATCH = 6;
const NAV_TIMEOUT = 30000;
const CHALLENGE_GRACE_MS = 12000; // wait for CF to auto-clear before classifying
const OUT = 'proxy-test-results.json';

function parseProxies() {
  return fs.readFileSync(PROXY_FILE, 'utf8').split(/\r?\n/)
    .map(l => l.trim()).filter(Boolean).map(line => {
      const [conn, expected] = line.split('|');
      const [host, port, user, pass] = conn.split(':');
      return { server: `http://${host}:${port}`, username: user, password: pass, expected, port };
    });
}

async function classify(page) {
  const title = (await page.title().catch(() => '')).trim();
  const body = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 400) : '').catch(() => '');
  const text = `${title}\n${body}`;
  if (/Just a moment|Verify you are human|Checking your browser/i.test(text)) return 'CF_CHALLENGE';
  if (/Sorry, you have been blocked|Attention Required/i.test(text)) return 'CF_BLOCKED';
  if (/access denied|you don't have permission|error 1020/i.test(text)) return 'CF_BLOCKED';
  if (/Visa Application|Schedule|Sign In|Log In|usvisascheduling/i.test(text) || title) return 'OK';
  return 'UNKNOWN';
}

async function testProxy(browser, p) {
  const res = { port: p.port, expected: p.expected, exitIp: null, ipMatch: false, proxyUp: false, siteStatus: null, verdict: '', ms: 0 };
  const t0 = Date.now();
  let ctx = null;
  try {
    ctx = await browser.newContext({ proxy: { server: p.server, username: p.username, password: p.password }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // 1. exit IP through the tunnel
    try {
      const r = await page.goto(IPCHECK, { timeout: 20000, waitUntil: 'domcontentloaded' });
      const txt = r ? await page.evaluate(() => document.body ? document.body.innerText.trim() : '').catch(() => '') : '';
      const m = (txt || '').match(/\d+\.\d+\.\d+\.\d+/);
      res.exitIp = m ? m[0] : null;
      res.ipMatch = res.exitIp === p.expected;
      res.proxyUp = !!res.exitIp;
    } catch (e) {
      res.verdict = 'PROXY_FAIL(' + (e.message.match(/ERR_\w+/)?.[0] || 'timeout') + ')';
      res.ms = Date.now() - t0;
      return res;
    }

    // 2. site load
    try {
      const resp = await page.goto(SITE, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
      res.siteStatus = resp ? resp.status() : null;
      // give CF challenge a chance to auto-clear
      const t1 = Date.now();
      while (Date.now() - t1 < CHALLENGE_GRACE_MS) {
        const c = await classify(page);
        if (c !== 'CF_CHALLENGE') { res.verdict = c; break; }
        await page.waitForTimeout(2000);
      }
      if (!res.verdict) res.verdict = await classify(page);
      if (res.verdict === 'UNKNOWN') res.verdict = `UNKNOWN(http=${res.siteStatus})`;
    } catch (e) {
      res.verdict = 'NAV_FAIL(' + (e.message.match(/ERR_\w+/)?.[0] || 'timeout') + ')';
    }
  } catch (e) {
    res.verdict = 'CTX_FAIL(' + e.message.substring(0, 60) + ')';
  } finally {
    res.ms = Date.now() - t0;
    if (ctx) await ctx.close().catch(() => null);
  }
  return res;
}

(async () => {
  const proxies = parseProxies();
  console.log(`Testing ${proxies.length} proxies × ${BATCH} parallel — headed browser, ~${Math.ceil(proxies.length / BATCH)} batches`);
  const browser = await chromium.launch({ headless: false, args: ['--start-minimized'] });
  const results = [];
  for (let i = 0; i < proxies.length; i += BATCH) {
    const batch = proxies.slice(i, i + BATCH);
    console.log(`\n--- batch ${Math.floor(i / BATCH) + 1} (${batch.map(b => b.port).join(',')}) ---`);
    const rs = await Promise.all(batch.map(p => testProxy(browser, p).then(r => {
      console.log(`  :${p.port} ${r.verdict} | exit=${r.exitIp || '-'}${r.ipMatch ? '(match)' : r.exitIp ? '(MISMATCH exp ' + r.expected + ')' : ''} | http=${r.siteStatus ?? '-'} | ${(r.ms / 1000).toFixed(1)}s`);
      return r;
    })));
    results.push(...rs);
  }
  await browser.close().catch(() => null);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

  const ok = results.filter(r => r.verdict === 'OK');
  const challenge = results.filter(r => r.verdict === 'CF_CHALLENGE');
  const dead = results.filter(r => !r.proxyUp);
  const blocked = results.filter(r => /BLOCK|FAIL|UNKNOWN/.test(r.verdict) && r.proxyUp);
  console.log(`\n===== SUMMARY =====`);
  console.log(`proxy dead (no exit IP): ${dead.length} ${dead.map(r => ':' + r.port).join(' ')}`);
  console.log(`site OK:                 ${ok.length} ${ok.map(r => ':' + r.port).join(' ')}`);
  console.log(`CF challenge (stuck):    ${challenge.length} ${challenge.map(r => ':' + r.port).join(' ')}`);
  console.log(`blocked/nav-fail/other:  ${blocked.length} ${blocked.map(r => ':' + r.port).join(' ')}`);
  console.log(`\nFull results → ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
