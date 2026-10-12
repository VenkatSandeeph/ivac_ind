// Step 2: wait for Turnstile to clear, then navigate to the sign-in page and
// capture the login flow's network calls + page internals.
const { chromium } = require('patchright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9333';
const LOG = 'recon-network.log';
const log = fs.createWriteStream(LOG, { flags: 'a' });
function w(...a) { const s = a.join(' '); console.log(s); log.write(s + '\n'); }

async function dump(page, tag) {
  w(`=== ${tag} ===`);
  w('URL:', page.url());
  w('TITLE:', await page.title().catch(() => '?'));
  const info = await page.evaluate(() => ({
    scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
    forms: Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, name: f.name, action: f.action, method: f.method,
      inputs: Array.from(f.querySelectorAll('input,button')).map(i => `${i.tagName}#${i.id}[name=${i.name}][type=${i.type}]`)
    })),
    errEls: Array.from(document.querySelectorAll('#claimVerificationServerError,.error.pageLevel,.error,.alert,[id*=Error],[id*=error]'))
      .map(e => `${e.tagName}#${e.id}.${e.className} visible=${e.offsetParent !== null} text="${(e.textContent || '').trim().slice(0, 400)}"`),
    bodyText: (document.body?.innerText || '').slice(0, 1200)
  })).catch(e => ({ err: e.message }));
  w('SCRIPTS:', JSON.stringify(info.scripts, null, 1));
  w('FORMS:', JSON.stringify(info.forms, null, 1));
  w('ERROR ELEMENTS:', JSON.stringify(info.errEls, null, 1));
  w('BODY:', info.bodyText || info.err || '');
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

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
      try { w(`   BODY: ${(await res.text()).slice(0, 3000)}`); }
      catch (e) { w(`   BODY: <unreadable: ${e.message}>`); }
    }
  });

  // wait for Turnstile to clear (up to 90s)
  w('--- waiting for challenge to clear ---');
  for (let i = 0; i < 30; i++) {
    const t = await page.title().catch(() => '');
    const url = page.url();
    if (!/just a moment/i.test(t)) { w(`challenge cleared after ${i * 3}s -> ${t} @ ${url}`); break; }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  await dump(page, 'POST-CHALLENGE HOME');

  // find + click the sign-in link/button if we landed on the home page
  const signIn = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a,button'));
    const el = els.find(e => /sign in|log ?in/i.test((e.innerText || '') + ' ' + (e.id || '')));
    return el ? { tag: el.tagName, text: el.innerText, href: el.href || null, id: el.id } : null;
  }).catch(() => null);
  w('SIGN-IN ELEMENT:', JSON.stringify(signIn));

  if (signIn && signIn.href) {
    await page.goto(signIn.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => w('nav err', e.message));
  } else if (signIn) {
    await page.click(`#${signIn.id}`).catch(e => w('click err', e.message));
  }
  await page.waitForTimeout(6000);
  await dump(page, 'SIGN-IN PAGE');

  // dump inline scripts on sign-in page
  const inlines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent).filter(t => t.length > 50)
  ).catch(() => []);
  w('=== INLINE SCRIPTS (sign-in page) ===');
  inlines.forEach((t, i) => w(`--- inline[${i}] (${t.length}b) ---\n${t.slice(0, 5000)}`));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
