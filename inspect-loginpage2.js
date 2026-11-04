const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  console.log('navigating…');
  await page.goto('https://www.usvisascheduling.com/en-US/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));

  // wait out the CF challenge (up to 45s), clicking the Turnstile box if it appears
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(3000);
    const title = await page.title().catch(() => '');
    const url = page.url();
    if (!/just a moment|attention required/i.test(title)) { console.log(`challenge cleared at ~${(i+1)*3}s ->`, url.slice(0, 90)); break; }
    // try clicking the turnstile checkbox inside its iframe
    try {
      const frames = page.frames();
      for (const f of frames) {
        if (f.url().includes('challenges.cloudflare.com')) {
          const box = await f.$('input[type="checkbox"], .cb-lb, #cf-stage label');
          if (box) { const b = await box.boundingBox(); if (b) { await page.mouse.click(b.x + b.width/2, b.y + b.height/2); console.log('clicked turnstile'); } }
        }
      }
    } catch {}
    if (i === 14) console.log('challenge did not clear in 45s — title:', title);
  }
  await page.waitForTimeout(4000);
  const cdp = await ctx.newCDPSession(page);
  const st = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0, 130), title: document.title.slice(0, 80),
      signInName: !!document.getElementById('signInName'),
      bodySnippet: (document.body ? document.body.innerText : '').slice(0, 400) })`, returnByValue: true });
  const s = JSON.parse(st.result.value);
  console.log(s);
  if (!s.signInName) {
    // try clicking Sign In link if on home
    await page.evaluate(() => { const a = Array.from(document.querySelectorAll('a,button')).find(e => /sign ?in|log ?in/i.test(e.innerText||'')); if (a) a.click(); }).catch(() => {});
    await page.waitForTimeout(8000);
  }
  const html = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('loginpage-dump.html', html.result.value);
  const final = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0, 130), signInName: !!document.getElementById('signInName'),
      retryKeys: Object.keys(window).filter(k=>/retry|attempt|limit|block|selfassert|SA_|sa_/i.test(k)).slice(0,30) })`, returnByValue: true });
  console.log('final:', JSON.parse(final.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
