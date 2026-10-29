const { chromium } = require('patchright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('ofc-schedule')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);

  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.getElementById('main_container')||document.body||{innerText:'none'}).innerText.slice(0,400),
      schedulePageViews: typeof schedulePageViews!=='undefined'?schedulePageViews:null,
      canViewPage: typeof canViewPage!=='undefined'?canViewPage:null,
      jsdataKeys: typeof jsdata!=='undefined'?Object.keys(jsdata):null,
      apps: typeof applications!=='undefined'?applications.length:null,
      form: !!document.getElementById('page_form'),
      postSelect: !!document.getElementById('post_select'),
      datepicker: !!document.getElementById('datepicker'),
      errorRow: document.getElementById('error_row')?document.getElementById('error_row').innerText.slice(0,300):null,
      viewGlobals: Object.getOwnPropertyNames(window).filter(k=>/view|limit|page/i.test(k)&&!/visual|viewport|open|inner|outer|pageX|pageY|screen/.test(k))
    })`,
    returnByValue: true
  });
  console.log(JSON.parse(r.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
