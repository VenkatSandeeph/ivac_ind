const { chromium } = require('patchright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find(p => p.url().includes('ofc-schedule')) || pages[0];
  console.log('URL:', page.url());

  const g = await page.evaluate(() => {
    const out = {};
    for (const k of ['schedulePageViews','canViewPage','jsdata','ofcAppointments','applications','maxSchedulePageViews','pageViews','viewLimit']) {
      try { out[k] = (window[k] !== undefined) ? window[k] : '(undef)'; } catch(e){ out[k]='err'; }
    }
    // all window keys containing view/pageView
    out._viewKeys = Object.keys(window).filter(k => /view|limit/i.test(k)).slice(0,40);
    out._formPresent = !!document.getElementById('page_form');
    out._postSelect = !!document.getElementById('post_select');
    out._datepicker = !!document.getElementById('datepicker');
    return out;
  });
  console.log(JSON.stringify(g, null, 1).slice(0, 3000));

  // list script srcs
  const srcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('usvisascheduling')));
  console.log('SCRIPTS:', JSON.stringify(srcs, null, 1));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
