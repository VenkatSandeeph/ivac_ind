const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // warm CF once on the origin so all probes share the cleared session
  await page.goto('https://www.usvisascheduling.com/en-US/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(3000);
    if (!/just a moment|attention required/i.test(await page.title().catch(() => ''))) break;
    for (const f of page.frames()) {
      if (f.url().includes('challenges.cloudflare.com')) {
        const box = await f.$('input[type="checkbox"], .cb-lb, #cf-stage label').catch(() => null);
        if (box) { const b = await box.boundingBox().catch(() => null); if (b) await page.mouse.click(b.x + b.width/2, b.y + b.height/2); }
      }
    }
  }
  console.log('CF cleared:', page.url().slice(0, 80));
  const cdp = await ctx.newCDPSession(page);
  const paths = [
    '/en-US/Account/Login/LocalLogin',
    '/en-US/Account/Login',
    '/en-US/support/create-case/',
    '/en-US/sign-in/?local=true'
  ];
  for (const p of paths) {
    await page.goto('https://www.usvisascheduling.com' + p, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
        url: location.href.slice(0,120), title: document.title.slice(0,60),
        hasLocalForm: !!document.querySelector('input[type=password]'),
        inputs: Array.from(document.querySelectorAll('input')).map(i=>i.id||i.name).filter(Boolean).slice(0,12),
        b2c: /b2clogin/.test(location.href),
        body: document.body.innerText.slice(0,200)
      })`, returnByValue: true });
    console.log('\n==', p, '=>', JSON.stringify(JSON.parse(r.result.value), null, 1).slice(0, 900));
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
