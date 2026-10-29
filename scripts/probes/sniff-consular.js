const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const reqs = [];
  cdp.on('Network.requestWillBeSent', (e) => {
    const u = e.request.url;
    if (u.includes('custom-actions') || u.includes('api/v1')) reqs.push(`REQ ${e.request.method} ${u.slice(60, 180)}`);
  });
  cdp.on('Network.responseReceived', (e) => {
    const u = e.response.url;
    if (u.includes('custom-actions') || u.includes('api/v1') || u.includes('usvisascheduling.com/en-US')) reqs.push(`RES ${e.response.status} ${u.slice(60, 180)}`);
  });
  console.log('listening 25s on', page.url().slice(0, 70));
  await new Promise(r => setTimeout(r, 25000));
  reqs.forEach(r => console.log(' ', r));
  console.log(`total: ${reqs.length}`);
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
