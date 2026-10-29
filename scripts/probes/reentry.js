const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  // list schedule links on home
  const links = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify(
      Array.from(document.querySelectorAll('a')).map(a=>({t:a.innerText.trim().slice(0,50),h:(a.getAttribute('href')||'').slice(0,90)})).filter(l=>/schedul|appoint|reschedul/i.test(l.t+l.h)))`,
    returnByValue: true });
  console.log('links:', r2(JSON.parse(links.result.value)));
  function r2(x){return JSON.stringify(x,null,0)}
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
