const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('ofc-schedule')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  const html = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  const h = html.result.value;
  fs.writeFileSync('ofc-page-dump.html', h);
  // find ALL script blocks containing page-views / page_form / exceeded
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi; let m, i=0;
  while ((m = re.exec(h))) {
    const t = m[1];
    if (/page-views|page_form|canViewPage|schedulePageViews|exceeded/i.test(t)) {
      console.log(`===== script block ${i} (len ${t.length}) =====`);
      console.log(t.slice(0, 4000));
      i++;
      if (i>4) break;
    }
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
