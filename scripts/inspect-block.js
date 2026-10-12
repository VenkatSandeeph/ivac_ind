// Recon: attach to Chrome on CDP :9333, navigate to usvisascheduling.com,
// log every request/response, then dump page structure + scripts.
// Usage: node scripts/inspect-block.js [--wait]   (--wait = stay attached 5min for manual login)
const { chromium } = require('patchright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9333';
const LOG = 'recon-network.log';
const log = fs.createWriteStream(LOG, { flags: 'a' });
function w(...a) { const s = a.join(' '); console.log(s); log.write(s + '\n'); }

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

  page.on('request', (req) => {
    const rt = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`>> ${req.method()} ${rt.padEnd(10)} ${req.url()}`);
    const pd = req.postData();
    if (pd && pd.length < 2000) w(`   POSTDATA: ${pd.slice(0, 2000)}`);
  });

  page.on('response', async (res) => {
    const rt = res.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(rt)) return;
    w(`<< ${res.status()} ${rt.padEnd(10)} ${res.url()}`);
    if (['xhr', 'fetch'].includes(rt)) {
      try {
        const body = await res.text();
        w(`   BODY: ${body.slice(0, 3000)}`);
      } catch (e) { w(`   BODY: <unreadable: ${e.message}>`); }
    }
  });

  w('=== navigating to https://www.usvisascheduling.com/ ===');
  await page.goto('https://www.usvisascheduling.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => w('NAV ERR', e.message));
  await page.waitForTimeout(6000);

  w('=== PAGE STATE ===');
  w('URL:', page.url());
  w('TITLE:', await page.title().catch(() => '?'));

  const info = await page.evaluate(() => {
    const out = {};
    out.scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    out.inlineScriptLens = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent.length);
    out.forms = Array.from(document.querySelectorAll('form')).map(f => ({ id: f.id, action: f.action, method: f.method }));
    out.links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /signin|login|account/i.test(h)).slice(0, 10);
    out.bodyText = (document.body?.innerText || '').slice(0, 1500);
    return out;
  }).catch(e => ({ err: e.message }));

  w('=== SCRIPTS ==='); (info.scripts || []).forEach(s => w(' ', s));
  w('=== INLINE SCRIPT SIZES ===', JSON.stringify(info.inlineScriptLens));
  w('=== FORMS ===', JSON.stringify(info.forms, null, 1));
  w('=== LOGIN LINKS ===', JSON.stringify(info.links, null, 1));
  w('=== BODY TEXT (first 1500) ===\n', info.bodyText || info.err || '');

  const inlineHits = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent)
      .filter(t => /block|login|api|SelfAsserted|signIn/i.test(t))
      .map(t => t.slice(0, 4000));
  }).catch(() => []);
  w('=== INLINE SCRIPTS MATCHING block/login/api ===');
  inlineHits.forEach((t, i) => w(`--- inline[${i}] ---\n${t}`));

  if (process.argv.includes('--wait')) {
    w('=== WAITING 300s for manual interaction (login attempt). All network logged to', LOG, '===');
    await page.waitForTimeout(300000);
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
