// Spot-retest: give 3 proxies a 45s CF grace window — does the challenge self-clear?
const { chromium } = require('patchright');
const fs = require('fs');
const PORTS = [8008, 8014, 8032];
const SITE = 'https://www.usvisascheduling.com/en-US/';
const GRACE = 45000;

function parse() {
  return fs.readFileSync('proxies-oxylabs-test.txt', 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(line => { const [conn, exp] = line.split('|'); const [h, p, u, pw] = conn.split(':'); return { server: `http://${h}:${p}`, username: u, password: pw, expected: exp, port: +p }; })
    .filter(p => PORTS.includes(p.port));
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  for (const p of parse()) {
    const ctx = await browser.newContext({ proxy: { server: p.server, username: p.username, password: p.password }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const t0 = Date.now();
    try {
      const r = await page.goto(SITE, { timeout: 30000, waitUntil: 'domcontentloaded' });
      console.log(`:${p.port} initial http=${r ? r.status() : '-'}`);
      let last = '';
      while (Date.now() - t0 < GRACE) {
        const title = (await page.title().catch(() => '')).trim();
        if (title !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] title="${title}"`); last = title; }
        if (!/Just a moment|moment/i.test(title)) break;
        await page.waitForTimeout(3000);
      }
    } catch (e) { console.log(`:${p.port} nav err ${e.message.substring(0, 80)}`); }
    await ctx.close().catch(() => null);
  }
  await browser.close().catch(() => null);
  process.exit(0);
})();
