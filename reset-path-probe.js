const { chromium } = require('patchright');
const fs = require('fs');
const RESET_URL = 'https://atlasauth.b2clogin.com/atlasauth.onmicrosoft.com/oauth2/v2.0/authorize?p=B2C_1A_ATLAS_PASSWORDRESET&client_id=607d08d6-b63b-4735-ad82-05dfcff7efa4&nonce=defaultNonce&redirect_uri=https%3A%2F%2Fwww.usvisascheduling.com%2Fen-US%2FSignIn&scope=openid&response_type=id_token&prompt=login&ui_locales=en-US';
const cap = {};
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', e => {
    if (e.response.url.includes('b2clogin.com')) console.log('  <', e.response.status, e.response.url.slice(40,120));
  });
  console.log('navigating to reset policy…');
  await page.goto(RESET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await page.waitForTimeout(6000);
  const s1 = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0,140), title: document.title,
      fields: Array.from(document.querySelectorAll('input')).map(i=>({id:i.id,type:i.type,name:i.name})).filter(f=>f.id||f.name),
      buttons: Array.from(document.querySelectorAll('button,input[type=submit],a')).map(b=>(b.innerText||b.value||'').trim()).filter(Boolean).slice(0,10),
      serverErr: document.getElementById('claimVerificationServerError')?.innerText?.slice(0,300)||null,
      pageErr: document.querySelector('.error.pageLevel')?.innerText?.slice(0,300)||null,
      bodyText: document.body.innerText.slice(0,400)
    })`, returnByValue: true });
  cap.stage1 = JSON.parse(s1.result.value);
  console.log('STAGE1:', JSON.stringify(cap.stage1, null, 1));
  const h1 = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('reset-stage1.html', h1.result.value);
  // Fill username only if there's a username/email field — then ONE continue click
  const fill = cap.stage1.fields.find(f => /signInName|email|user/i.test(f.id + f.name));
  if (fill) {
    await page.fill('#' + fill.id, 'anusree12').catch(() => page.fill(`input[name="${fill.name}"]`, 'anusree12').catch(() => {}));
    cap.filledField = fill;
    const btn = await page.$('#continue, button[type=submit], button.continue') || await page.$('button');
    if (btn) {
      console.log('single continue click…');
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null), btn.click().catch(() => null)]);
      await page.waitForTimeout(5000);
      const s2 = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
          url: location.href.slice(0,140), title: document.title,
          fields: Array.from(document.querySelectorAll('input')).map(i=>({id:i.id,type:i.type,name:i.name})).filter(f=>f.id||f.name),
          buttons: Array.from(document.querySelectorAll('button,input[type=submit],a')).map(b=>(b.innerText||b.value||'').trim()).filter(Boolean).slice(0,10),
          serverErr: document.getElementById('claimVerificationServerError')?.innerText?.slice(0,300)||null,
          pageErr: document.querySelector('.error.pageLevel')?.innerText?.slice(0,300)||null,
          blockMsg: /not allowed|temporarily blocked|prohibited/i.test(document.body.innerText),
          bodyText: document.body.innerText.slice(0,500)
        })`, returnByValue: true });
      cap.stage2 = JSON.parse(s2.result.value);
      console.log('STAGE2:', JSON.stringify(cap.stage2, null, 1));
      const h2 = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      fs.writeFileSync('reset-stage2.html', h2.result.value);
    }
  }
  fs.writeFileSync('reset-probe-capture.json', JSON.stringify(cap, null, 1));
  console.log('DONE — browser left state captured; NO code sent, NO password touched.');
  await browser.close();
})().catch(e => { fs.writeFileSync('reset-probe-capture.json', JSON.stringify({...cap, err: e.message}, null, 1)); console.log('ERR', e.message); process.exit(1); });
