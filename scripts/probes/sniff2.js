const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const reqs = [];
  const tag = (pre, e) => { const u = (e.request||e.response).url;
    if (u.includes('custom-actions')||u.includes('schedule-group')) reqs.push(`${new Date().toISOString().slice(11,19)} ${pre} ${u.slice(60,150)}`); };
  cdp.on('Network.requestWillBeSent', e => tag(`REQ ${e.request.method}`, e));
  cdp.on('Network.responseReceived', e => tag(`RES ${e.response.status}`, e));
  console.log('listening 75s on', page.url().slice(0, 70));
  await new Promise(r => setTimeout(r, 75000));
  reqs.forEach(r => console.log(' ', r));
  console.log(`total: ${reqs.length}`);
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
