const { chromium } = require('patchright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  console.log('page:', page.url().slice(0, 90));
  const cdp = await ctx.newCDPSession(page);
  const html = await cdp.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML', returnByValue: true });
  const h = html.result.value;
  fs.writeFileSync('consular-dump.html', h);
  console.log('page-views refs:', (h.match(/page-views[^"&' ]*/g) || []).slice(0,5));
  console.log('canViewPage:', (h.match(/canViewPage/g)||[]).length, '| page_form:', (h.match(/page_form/g)||[]).length, '| exceeded:', (h.match(/exceeded/g)||[]).length);
  const st = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      form: !!document.getElementById('page_form'),
      postSelect: !!document.getElementById('post_select'),
      datepicker: !!document.getElementById('datepicker'),
      mainText: (document.getElementById('main_container')||{innerText:'none'}).innerText.trim().slice(0,300),
      errorRow: document.getElementById('error_row') ? document.getElementById('error_row').innerText.trim().slice(0,200) : '(none)'
    })`, returnByValue: true });
  console.log(JSON.parse(st.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
