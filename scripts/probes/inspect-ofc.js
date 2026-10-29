const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('ofc-schedule')) || ctx.pages()[0];
  console.log('page:', page.url().slice(0, 80));
  const cdp = await ctx.newCDPSession(page);
  const html = await cdp.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML', returnByValue: true });
  const h = html.result.value;
  fs.writeFileSync('ofc-plain-dump.html', h);
  console.log('page-views refs:', (h.match(/page-views/g) || []).length);
  console.log('schedulePageViews refs:', (h.match(/schedulePageViews/g) || []).length);
  console.log('canViewPage refs:', (h.match(/canViewPage/g) || []).length);
  console.log('page_form refs:', (h.match(/page_form/g) || []).length);
  console.log('exceeded refs:', (h.match(/exceeded/g) || []).length);
  // show the function if present
  const ix = h.indexOf('schedulePageViews');
  if (ix >= 0) console.log('---ctx:', h.slice(ix - 100, ix + 400).replace(/\s+/g, ' '));
  // current DOM state
  const st = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      form: !!document.getElementById('page_form'),
      postSelect: !!document.getElementById('post_select'),
      datepicker: !!document.getElementById('datepicker'),
      errorRow: document.getElementById('error_row') ? document.getElementById('error_row').innerText.trim().slice(0,150) : '(none)'
    })`, returnByValue: true });
  console.log(JSON.parse(st.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
