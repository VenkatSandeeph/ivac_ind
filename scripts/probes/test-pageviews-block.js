const { chromium } = require('patchright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('ofc-schedule')) || ctx.pages()[0];
  console.log('page:', page.url().slice(0, 80));

  // arm the forged response — same shape as browser.ts change
  let hit = 0;
  await ctx.route('**/api/v1/page-views/**', (route) => {
    hit++;
    route.fulfill({ status: 200, contentType: 'application/json',
      body: '{"showWarning":false,"canViewPage":true}' });
  });
  console.log('route armed — reloading…');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('reload:', e.message));
  await page.waitForTimeout(9000);

  const cdp = await ctx.newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href.slice(0,80),
      form: !!document.getElementById('page_form'),
      postSelect: !!document.getElementById('post_select'),
      datepicker: !!document.getElementById('datepicker'),
      postOptions: document.getElementById('post_select') ? document.getElementById('post_select').options.length : 0,
      errorRow: document.getElementById('error_row') ? document.getElementById('error_row').innerText.trim().slice(0,120) : '(no error_row)',
      jsdataPresent: typeof jsdata !== 'undefined'
    })`, returnByValue: true });
  console.log('route hits:', hit);
  console.log(JSON.parse(r.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
