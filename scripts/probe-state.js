const { chromium } = require('patchright');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = b.contexts()[0].pages().find(p => /b2clogin/.test(p.url()));
  const st = await page.evaluate(() => ({
    jquery: typeof window['$'],
    saFields: typeof window['SA_FIELDS'],
    settings: typeof window['SETTINGS'],
    diags: typeof window['$diags'],
    element: typeof window['$element'],
    modalUp: (() => { const w = document.querySelector('#simplemodal-container .simplemodal-wrap'); return !!(w && w.offsetParent !== null); })(),
    modalText: document.querySelector('#simplemodal-data')?.innerText?.slice(0, 120) || null,
    continueDisabled: document.querySelector('#continue')?.disabled,
    continueAria: document.querySelector('#continue')?.getAttribute('aria-disabled'),
    formAction: document.querySelector('#attributeVerification')?.action,
    hasListeners: typeof jQuery !== 'undefined' ? 'jq-present' : 'no-jq',
    userVal: document.querySelector('#signInName')?.value,
    passSet: !!document.querySelector('#password')?.value
  }));
  console.log(JSON.stringify(st, null, 1));
  await b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
