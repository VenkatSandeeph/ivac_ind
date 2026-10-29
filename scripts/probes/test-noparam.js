const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  await page.goto('https://www.usvisascheduling.com/en-US/schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await page.waitForTimeout(9000);
  const cdp = await ctx.newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(30,90),
      title: document.title.slice(0,60),
      form: !!document.getElementById('page_form'),
      postSelect: !!document.getElementById('post_select'),
      postOptions: document.getElementById('post_select') ? document.getElementById('post_select').options.length : 0,
      datepicker: !!document.getElementById('datepicker'),
      submitbtn: !!document.getElementById('submitbtn'),
      errorRow: document.getElementById('error_row') ? document.getElementById('error_row').innerText.trim().slice(0,200) : '(none)'
    })`, returnByValue: true });
  console.log(JSON.parse(r.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
