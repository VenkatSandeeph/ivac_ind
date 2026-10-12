// One-shot: real login on the good account with route-level interception of
// the SelfAsserted XHR so the actual success body is captured before the page
// navigates. Stops after the confirmed step — no KBA answers submitted.
const { chromium } = require('patchright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9333';
const log = fs.createWriteStream('recon-network.log', { flags: 'a' });
function w(...a) { const s = a.join(' '); console.log(s); log.write(s + '\n'); }

(async () => {
  const { IVAC_USER_OK, IVAC_PASS_OK } = process.env;
  if (!IVAC_USER_OK || !IVAC_PASS_OK) { console.error('missing env creds'); process.exit(1); }

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /b2clogin|usvisascheduling/.test(p.url())) || ctx.pages()[0];

  // intercept the SelfAsserted POST, log the REAL body, pass through unmodified
  await page.route('**/SelfAsserted?**', async (route) => {
    const req = route.request();
    w(`[ROUTE] ${req.method()} ${req.url().slice(0, 160)}`);
    const resp = await route.fetch();
    const body = await resp.text();
    w(`[ROUTE] status=${resp.status()} BODY: ${body.slice(0, 1000)}`);
    w(`[ROUTE] set-cookie: ${(resp.headers()['set-cookie'] || '').slice(0, 400)}`);
    await route.fulfill({ response: resp, body });
  });

  page.on('framenavigated', f => { if (f === page.mainFrame()) w(`>> NAV -> ${f.url().slice(0, 160)}`); });
  page.on('response', r => {
    const u = r.url();
    if (/\.(png|css|woff|jpg|svg|js)/.test(u)) return;
    if (!/b2clogin|usvisascheduling/.test(u)) return;
    w(`<< ${r.status()} ${r.request().resourceType().padEnd(9)} ${u.slice(0, 160)}`);
  });

  // ensure we're on the B2C signin form
  if (!/b2clogin.*authorize/.test(page.url()) || !(await page.locator('#signInName').count())) {
    w('navigating to site to reach signin...');
    await page.goto('https://www.usvisascheduling.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => w('nav', e.message));
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('#signInName').count()) > 0) break;
      await page.waitForTimeout(3000);
    }
  }
  await page.waitForTimeout(4000);
  w('on signin:', page.url().slice(0, 120));

  w('### SUBMIT GOOD ACCOUNT ###');
  await page.fill('#signInName', IVAC_USER_OK);
  await page.fill('#password', IVAC_PASS_OK);
  await page.click('#continue');

  // let the flow run — capture everything for 45s
  await page.waitForTimeout(45000);

  const st = await page.evaluate(() => ({
    url: location.href.slice(0, 160), title: document.title,
    inputs: Array.from(document.querySelectorAll('input,button')).map(i => `${i.id}[${i.type}]`),
    labels: Array.from(document.querySelectorAll('label')).map(l => l.innerText.trim()).filter(Boolean),
    errs: Array.from(document.querySelectorAll('.error.pageLevel,#claimVerificationServerError'))
      .filter(e => e.offsetParent !== null && (e.textContent || '').trim()).map(e => e.textContent.trim().slice(0, 300)),
    body: (document.body?.innerText || '').slice(0, 600)
  }));
  w('=== FINAL STATE ===');
  w(JSON.stringify(st, null, 1));

  await page.unrouteAll();
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
