// Capture the full login flow for two accounts on the SAME B2C transaction:
//   1) banned account -> SelfAsserted error response
//   2) good account   -> SelfAsserted success + full post-login redirect chain
// Creds come from env vars — never written to the log (password masked).
//   IVAC_USER_BAD / IVAC_PASS_BAD / IVAC_USER_OK / IVAC_PASS_OK
const { chromium } = require('patchright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9333';
const LOG = 'recon-network.log';
const log = fs.createWriteStream(LOG, { flags: 'a' });
function w(...a) { const s = a.join(' '); console.log(s); log.write(s + '\n'); }
const mask = (s) => s ? s.replace(/(password=)[^&]*/i, '$1***') : s;

(async () => {
  const { IVAC_USER_BAD, IVAC_PASS_BAD, IVAC_USER_OK, IVAC_PASS_OK } = process.env;
  if (!IVAC_USER_BAD || !IVAC_PASS_BAD || !IVAC_USER_OK || !IVAC_PASS_OK) {
    console.error('missing env creds'); process.exit(1);
  }

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /b2clogin|usvisascheduling/.test(p.url())) || ctx.pages()[0];

  page.on('request', (req) => {
    const rt = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`>> ${req.method()} ${rt.padEnd(10)} ${req.url()}`);
    const pd = req.postData();
    if (pd) w(`   POSTDATA: ${mask(pd.slice(0, 1200))}`);
  });
  page.on('response', async (res) => {
    const rt = res.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`<< ${res.status()} ${rt.padEnd(10)} ${res.url()}`);
    const sc = res.headers()['set-cookie'];
    if (sc) w(`   SET-COOKIE: ${sc.slice(0, 300)}`);
    if (['xhr', 'fetch'].includes(rt)) {
      try { w(`   BODY: ${(await res.text()).slice(0, 3000)}`); }
      catch (e) { w(`   BODY: <unreadable: ${e.message}>`); }
    }
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) w(`>> NAVIGATED -> ${f.url()}`);
  });

  async function submit(u, p, label) {
    w(`\n########## SUBMIT: ${label} ##########`);
    await page.fill('#signInName', u);
    await page.fill('#password', p);
    await page.click('#continue');
    await page.waitForTimeout(8000);
    const errs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#claimVerificationServerError,.error.pageLevel'))
        .filter(e => e.offsetParent !== null && (e.textContent || '').trim())
        .map(e => `#${e.id}: "${(e.textContent || '').trim().slice(0, 500)}"`)
    ).catch(() => []);
    w(`ERR DIVS: ${JSON.stringify(errs)}`);
    w(`URL NOW: ${page.url()}`);
  }

  await submit(IVAC_USER_BAD, IVAC_PASS_BAD, 'BANNED ACCOUNT');
  await submit(IVAC_USER_OK, IVAC_PASS_OK, 'GOOD ACCOUNT');

  // success path navigates through multiple pages — keep capturing
  w('\n--- observing post-login flow for 60s ---');
  await page.waitForTimeout(60000);
  w('FINAL URL:', page.url());
  w('FINAL TITLE:', await page.title().catch(() => '?'));
  w('BODY:', (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 800));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
