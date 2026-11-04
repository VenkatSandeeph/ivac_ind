const { chromium } = require('patchright');
const fs = require('fs');
const SU_URL = 'https://atlasauth.b2clogin.com/atlasauth.onmicrosoft.com/oauth2/v2.0/authorize?p=B2C_1A_atoproduction_Atlas_SU&client_id=607d08d6-b63b-4735-ad82-05dfcff7efa4&nonce=probe&redirect_uri=https%3A%2F%2Fwww.usvisascheduling.com%2Fen-US%2FSignIn&scope=openid&response_type=id_token&prompt=login&ui_locales=en-US';
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  const cdp = await (await page.context()).newCDPSession(page);
  await page.goto(SU_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      title: document.title,
      fields: Array.from(document.querySelectorAll('input,select')).map(i=>({id:i.id||i.name,type:i.type,label:(i.labels&&i.labels[0]?i.labels[0].innerText.trim().slice(0,40):'')}) ),
      buttons: Array.from(document.querySelectorAll('button,a')).map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,15),
      links: Array.from(document.querySelectorAll('a[href]')).map(a=>a.href.slice(0,120)).filter(h=>/b2clogin|support|claim/i.test(h)).slice(0,10),
      bodyText: document.body.innerText.slice(0,1200)
    })`, returnByValue: true });
  console.log(JSON.stringify(JSON.parse(r.result.value), null, 1));
  const h = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('signup-dump.html', h.result.value);
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
