const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('devtools'));
  if (!page) { console.log('no page'); return; }
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({url:location.href,title:document.title,ready:document.readyState,body:document.body?document.body.innerText.substring(0,300):''})`, returnByValue: true });
  console.log(r.result.value);
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
