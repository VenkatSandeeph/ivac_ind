const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('request', r => { const u = r.url(); if (u.includes('b2clogin') || u.includes('SelfAsserted')) console.log('REQ', u.slice(0, 140)); });
  console.log('navigating…');
  await page.goto('https://www.usvisascheduling.com/en-US/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await page.waitForTimeout(8000);
  console.log('landed:', page.url().slice(0, 110));
  const cdp = await ctx.newCDPSession(page);
  const st = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0, 120), title: document.title.slice(0, 80),
      signInName: !!document.getElementById('signInName'),
      bodySnippet: (document.body ? document.body.innerText : '').slice(0, 300) })`, returnByValue: true });
  console.log(JSON.parse(st.result.value));
  const html = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('loginpage-dump.html', html.result.value);
  const scripts = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify(Array.from(document.querySelectorAll('script[src]')).map(s=>s.src))`, returnByValue: true });
  console.log('scripts:', JSON.parse(scripts.result.value));
  // retry-related globals B2C pages embed
  const g = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      SA: typeof SA!=='undefined' ? SA : null,
      SETTINGS: typeof SETTINGS!=='undefined' ? SETTINGS : null,
      retryKeys: Object.keys(window).filter(k=>/retry|attempt|limit|block|selfassert/i.test(k)).slice(0,30) })`, returnByValue: true });
  console.log('globals:', JSON.stringify(JSON.parse(g.result.value || '{}'), null, 1).slice(0, 2000));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
