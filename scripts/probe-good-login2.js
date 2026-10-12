const { chromium } = require('patchright');
const fs = require('fs');
const log = fs.createWriteStream('recon-network.log', { flags: 'a' });
const w = (...a) => { const s = a.join(' '); console.log(s); log.write(s + '\n'); };

(async () => {
  const { IVAC_USER_OK, IVAC_PASS_OK } = process.env;
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => /b2clogin|usvisascheduling/.test(p.url())) || ctx.pages()[0];

  // hard reload for a fresh B2C engine
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => w('reload', e.message));
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(() => typeof window['$'] !== 'undefined' && !!document.querySelector('#signInName')).catch(() => false);
    if (ok) { w(`engine ready after ~${i * 3}s`); break; }
    await page.waitForTimeout(3000);
  }
  const health = await page.evaluate(() => ({
    jq: typeof window['$'], sa: typeof window['SA_FIELDS'], form: !!document.querySelector('#attributeVerification')
  }));
  w('ENGINE:', JSON.stringify(health));
  if (health.jq === 'undefined') { w('engine still dead — aborting'); process.exit(1); }

  await page.route('**/SelfAsserted?**', async (route) => {
    const resp = await route.fetch();
    const body = await resp.text();
    w('[ROUTE]', route.request().method(), 'status=' + resp.status(), 'BODY:', body.slice(0, 800));
    const sc = resp.headers()['set-cookie']; if (sc) w('[ROUTE] set-cookie:', sc.slice(0, 400));
    await route.fulfill({ response: resp, body });
  });
  page.on('framenavigated', f => { if (f === page.mainFrame()) w('>> NAV ->', f.url().slice(0, 150)); });
  page.on('response', r => { if (/b2clogin|usvisascheduling/.test(r.url()) && !/\.(png|css|woff|js|svg|jpg)/.test(r.url())) w('<<', r.status(), r.url().slice(0, 150)); });

  w('### SUBMIT GOOD ACCOUNT ###');
  await page.fill('#signInName', IVAC_USER_OK);
  await page.fill('#password', IVAC_PASS_OK);
  await page.click('#continue');
  await page.waitForTimeout(40000);

  const st = await page.evaluate(() => ({
    url: location.href.slice(0, 150), title: document.title,
    inputs: Array.from(document.querySelectorAll('input,button')).map(i => i.id + '[' + i.type + ']'),
    labels: Array.from(document.querySelectorAll('label')).map(l => l.innerText.trim()).filter(Boolean),
    errs: Array.from(document.querySelectorAll('.error,#claimVerificationServerError')).filter(e => e.offsetParent !== null && (e.textContent || '').trim()).map(e => e.id + ':' + e.textContent.trim().slice(0, 200))
  }));
  w('FINAL:', JSON.stringify(st, null, 1));
  await page.unrouteAll(); await b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
