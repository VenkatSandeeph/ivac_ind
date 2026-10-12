// Step 3: submit dummy credentials on the B2C sign-in page and capture the
// SelfAsserted XHR request + response — the channel that carries the
// "temporarily blocked" server error.
const { chromium } = require('patchright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9333';
const LOG = 'recon-network.log';
const log = fs.createWriteStream(LOG, { flags: 'a' });
function w(...a) { const s = a.join(' '); console.log(s); log.write(s + '\n'); }

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /b2clogin|usvisascheduling/.test(p.url())) || ctx.pages()[0];
  w('USING PAGE:', page.url());

  page.on('request', (req) => {
    const rt = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`>> ${req.method()} ${rt.padEnd(10)} ${req.url()}`);
    const pd = req.postData();
    if (pd) w(`   POSTDATA: ${pd.slice(0, 1500)}`);
  });
  page.on('response', async (res) => {
    const rt = res.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`<< ${res.status()} ${rt.padEnd(10)} ${res.url()}`);
    if (['xhr', 'fetch'].includes(rt)) {
      try { w(`   BODY: ${(await res.text()).slice(0, 4000)}`); }
      catch (e) { w(`   BODY: <unreadable: ${e.message}>`); }
    }
  });

  await page.fill('#signInName', 'recon_dummy_probe@example.invalid').catch(e => w('fill user err', e.message));
  await page.fill('#password', 'NotARealPassword123!').catch(e => w('fill pass err', e.message));
  w('--- clicking Sign In ---');
  await page.click('#continue').catch(e => w('click err', e.message));
  await page.waitForTimeout(12000);

  w('=== AFTER SUBMIT ===');
  w('URL:', page.url());
  const errs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#claimVerificationServerError,.error.pageLevel,.error.itemLevel,.alert,[id*=Error],[id*=error],[role=alert]'))
      .filter(e => e.offsetParent !== null || (e.textContent || '').trim())
      .map(e => `${e.tagName}#${e.id} visible=${e.offsetParent !== null} text="${(e.textContent || '').trim().slice(0, 500)}"`)
  ).catch(e => [e.message]);
  w('VISIBLE ERRORS:', JSON.stringify(errs, null, 1));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
