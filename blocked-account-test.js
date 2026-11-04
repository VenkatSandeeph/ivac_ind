const { chromium } = require('patchright');
const fs = require('fs');
const OUT = 'blocked-test-capture.json';
const cap = { requests: [], responses: [] };

(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', e => {
    const u = e.request.url;
    if (u.includes('b2clogin.com') && e.request.method === 'POST')
      cap.requests.push({ url: u.slice(0,200), postData: (e.request.postData||'').slice(0,600) });
  });
  cdp.on('Network.responseReceived', e => {
    const u = e.response.url;
    if (u.includes('b2clogin.com') || u.includes('usvisascheduling'))
      cap.responses.push({ status: e.response.status, url: u.slice(0,180), headers: e.response.headers });
  });

  await page.goto('https://www.usvisascheduling.com/en-US/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(3000);
    const t = await page.title().catch(() => '');
    if (!/just a moment|attention required/i.test(t)) break;
    for (const f of page.frames()) {
      if (f.url().includes('challenges.cloudflare.com')) {
        const box = await f.$('input[type="checkbox"], .cb-lb, #cf-stage label').catch(() => null);
        if (box) { const b = await box.boundingBox().catch(() => null); if (b) await page.mouse.click(b.x + b.width/2, b.y + b.height/2); }
      }
    }
  }
  await page.waitForTimeout(4000);
  // reach sign-in
  if (!page.url().includes('b2clogin')) {
    await page.evaluate(() => { const a = Array.from(document.querySelectorAll('a,button')).find(e => /sign ?in/i.test(e.innerText||'')); if (a) a.click(); }).catch(() => {});
    await page.waitForTimeout(9000);
  }
  if (!page.url().includes('b2clogin')) {
    await page.goto('https://www.usvisascheduling.com/en-US/sign-in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(8000);
  }

  // PRE-SUBMIT state — does the block show on page load?
  const pre = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0,150), title: document.title,
      signInName: !!document.getElementById('signInName'),
      password: !!document.getElementById('password'),
      continueBtn: !!document.getElementById('continue'),
      SETTINGS: typeof SETTINGS!=='undefined' ? {retryLimit:SETTINGS.retryLimit, cfgRetryLimit:SETTINGS.config&&SETTINGS.config.retryLimit, pageViewId:SETTINGS.pageViewId} : null,
      serverError: document.getElementById('claimVerificationServerError') ? document.getElementById('claimVerificationServerError').innerText.slice(0,300) : null,
      pageLevelErr: (document.querySelector('.error.pageLevel')||{innerText:''}).innerText.slice(0,300),
      bodyHasBlockMsg: /not allowed for your account|temporarily blocked|prohibited use of automation/i.test(document.body.innerText),
      bodyBlockText: (document.body.innerText.match(/.{0,80}(not allowed|temporarily blocked|prohibited).{0,120}/i)||[''])[0]
    })`, returnByValue: true });
  cap.preSubmit = JSON.parse(pre.result.value);
  const preHtml = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('blocked-presubmit.html', preHtml.result.value);

  // === THE SINGLE ATTEMPT — fill + one click ===
  cap.attemptMade = false;
  const hasForm = cap.preSubmit.signInName;
  if (hasForm) {
    await page.fill('#signInName', 'anusree12');
    await page.fill('#password', 'Anusree135!!');
    await page.waitForTimeout(800);
    cap.attemptMade = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null),
      page.click('#continue')
    ]);
    await page.waitForTimeout(5000);
  }

  // POST-SUBMIT state
  const post = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      url: location.href.slice(0,150), title: document.title,
      signInName: !!document.getElementById('signInName'),
      serverError: document.getElementById('claimVerificationServerError') ? document.getElementById('claimVerificationServerError').innerText.slice(0,400) : null,
      pageLevelErr: (document.querySelector('.error.pageLevel')||{innerText:''}).innerText.slice(0,400),
      bodyBlockText: (document.body.innerText.match(/.{0,80}(not allowed|temporarily blocked|prohibited).{0,150}/i)||[''])[0],
      kbqPresent: document.querySelectorAll('p.textInParagraph[id^="kbq"]').length
    })`, returnByValue: true });
  cap.postSubmit = JSON.parse(post.result.value);
  const postHtml = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync('blocked-postsubmit.html', postHtml.result.value);
  fs.writeFileSync(OUT, JSON.stringify(cap, null, 1));
  console.log('CAPTURE SAVED');
  console.log(JSON.stringify({ pre: cap.preSubmit, post: cap.postSubmit, reqCount: cap.requests.length, resCount: cap.responses.length }, null, 1));
  await browser.close();
})().catch(e => { fs.writeFileSync(OUT, JSON.stringify({...cap, err: e.message}, null, 1)); console.log('ERR', e.message); process.exit(1); });
