const { chromium } = require('patchright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('ofc-schedule')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);

  // 1) Is page_form in the raw emitted HTML? (server-side vs client-side removal)
  const html = await cdp.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML', returnByValue: true });
  const h = html.result.value;
  console.log('outerHTML has page_form:', h.includes('id="page_form"'), '| has post_select:', h.includes('post_select'), '| has datepicker:', h.includes('datepicker'));
  console.log('has canViewPage str:', h.includes('canViewPage'), '| has schedulePageViews:', h.includes('schedulePageViews'), '| has page-views:', h.includes('page-views'));
  // context around 'exceeded' and view-limit script code
  const ix = h.indexOf('exceeded');
  console.log('...exceeded ctx:', h.slice(Math.max(0,ix-200), ix+120).replace(/\s+/g,' '));
  const jx = h.indexOf('page_form');
  console.log('...page_form ctx:', jx>=0 ? h.slice(Math.max(0,jx-200), jx+100).replace(/\s+/g,' ') : 'NOT IN HTML');

  // 2) inline script snippets mentioning view/limit/form removal
  const scripts = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(Array.from(document.querySelectorAll('script:not([src])')).map(s=>s.textContent||'').filter(t=>/view|page_form|remove\(|exceeded/i.test(t)).map(t=>t.slice(0,2000)))`,
    returnByValue: true });
  const arr = JSON.parse(scripts.result.value || '[]');
  console.log('inline scripts w/ view+form refs:', arr.length);
  arr.forEach((t,i)=>console.log(`--- script ${i}:\n`, t.slice(0,900)));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
