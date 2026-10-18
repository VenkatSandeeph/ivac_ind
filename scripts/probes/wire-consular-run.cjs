// Wire-mode consular sweep on the live suppressed page (CDP :9226, balivada).
// Per cycle: query-consular-posts -> get-family-consular-schedule-days per post
// -> earliest day globally -> get-family-consular-schedule-entries -> first
// seat-eligible slot -> schedule-consular-appointments-for-family (ONE submit).
// Loops for 20 min. Read-mostly; submits only when a real date exists.
const { chromium } = require('patchright');
const fs = require('fs');

const PORT = 9226;
const RUN_MS = 20 * 60 * 1000;
const DEADLINE = Date.now() + RUN_MS;
const LOG = 'wire-consular-run.log';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...a) {
  const s = `[${new Date().toLocaleTimeString('en-GB')}] ` + a.join(' ');
  console.log(s);
  try { fs.appendFileSync(LOG, s + '\n'); } catch {}
}

async function evalMain(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 40000 });
  if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}

// Injected once per page load — generic custom-actions poster.
const INSTALL = `
window.__wirePost = function(route, dto, appd) {
  return new Promise(function(res){
    $.ajax({
      url: "/en-US/custom-actions/?route=" + encodeURI(route) + "&appd=" + appd + "&cacheString=" + Date.now(),
      type: "POST",
      data: "parameters=" + JSON.stringify(dto),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      dataType: "json",
      timeout: 30000,
      success: function(d){ res({ok:true, data:d}); },
      error: function(x){ res({ok:false, status:x.status, body:(x.responseText||'').substring(0,200)}); }
    });
  });
};
'installed';
`;

const SCRAPE = `(function(){
  var m = document.documentElement.innerHTML.match(/appd=([0-9a-f-]{36})/);
  var pid = (typeof jsdata !== 'undefined' && jsdata.primaryId) ? jsdata.primaryId
          : (document.documentElement.innerHTML.match(/jsdata\\['primaryId'\\]\\s*=\\s*"([0-9a-f-]{36})"/) || [])[1];
  return { appd: m ? m[1] : null, primaryId: pid || null, url: location.href, ready: document.readyState, hasDollar: typeof $ === 'function' };
})()`;

async function callApi(cdp, route, dto, appd) {
  return evalMain(cdp, `window.__wirePost(${JSON.stringify(route)}, ${JSON.stringify(dto)}, ${JSON.stringify(appd)})`);
}

(async () => {
  fs.writeFileSync(LOG, `=== wire consular run started ${new Date().toISOString()} ===\n`);
  let browser = null;
  for (let i = 0; i < 6 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
    catch (e) { log(`connect attempt ${i + 1} failed: ${e.message.split('\n')[0]} — retrying`); await sleep(5000); }
  }
  if (!browser) throw new Error('could not connect to CDP');
  log('connected to CDP :' + PORT);

  let cycle = 0;
  let submitDone = false;

  while (Date.now() < DEADLINE && !submitDone) {
    cycle++;
    try {
      const page = browser.contexts()[0].pages().find(p => p.url().includes('usvisascheduling.com') && !p.url().includes('devtools'));
      if (!page) { log(`cycle ${cycle}: no usvisa tab — waiting`); await sleep(5000); continue; }
      const cdp = await page.context().newCDPSession(page);

      const env = await evalMain(cdp, SCRAPE).catch(e => null);
      if (!env || !env.appd || !env.primaryId || !env.hasDollar) {
        log(`cycle ${cycle}: page not ready (env=${JSON.stringify(env)}) — waiting`);
        await sleep(5000); continue;
      }
      await evalMain(cdp, INSTALL).catch(() => null);

      // posts
      const postsRes = await callApi(cdp, '/api/v1/schedule-group/query-consular-posts', { applicationId: env.primaryId }, env.appd);
      if (!postsRes.ok) {
        log(`cycle ${cycle}: posts HTTP ${postsRes.status} ${(postsRes.body || '').substring(0, 80)}`);
        // CF challenge/throttle — back off and let the page solver recover the session
        if (postsRes.status === 403 || postsRes.status === 429) await sleep(30000);
        else await sleep(8000);
        continue;
      }
      const posts = postsRes.data.Posts || [];
      if (postsRes.data.HasError) { log(`cycle ${cycle}: posts HasError ${JSON.stringify(postsRes.data.Errors).substring(0,160)}`); await sleep(8000); continue; }

      // days per post
      const found = [];
      for (const p of posts) {
        const dto = { primaryId: env.primaryId, applications: [env.primaryId], postId: p.ID, scheduleDayId: '', scheduleEntryId: '', isReschedule: 'false' };
        const dr = await callApi(cdp, '/api/v1/schedule-group/get-family-consular-schedule-days', dto, env.appd);
        if (dr.ok && !dr.data.HasError && (dr.data.ScheduleDays || []).length > 0) {
          found.push({ post: p, days: dr.data.ScheduleDays });
          log(`cycle ${cycle}: ${p.Name} -> ${dr.data.ScheduleDays.length} day(s)! earliest=${dr.data.ScheduleDays[0].Date}`);
        } else if (dr.ok && dr.data.HasError) {
          log(`cycle ${cycle}: ${p.Name} HasError ${JSON.stringify(dr.data.Errors).substring(0,160)}`);
        } else if (!dr.ok) {
          log(`cycle ${cycle}: ${p.Name} HTTP ${dr.status} ${(dr.body||'').substring(0,80)}`);
          if (dr.status === 429 || dr.status === 403) { log(`cycle ${cycle}: CF throttled — cooling 25s`); await sleep(25000); }
        }
        await sleep(1500);
      }

      if (found.length === 0) { log(`cycle ${cycle}: all ${posts.length} cities 0 days`); await sleep(4000); continue; }

      // global earliest day
      let best = null;
      for (const f of found) for (const d of f.days) {
        if (!best || new Date(d.Date) < new Date(best.day.Date)) best = { post: f.post, day: d };
      }
      log(`cycle ${cycle}: EARLIEST = ${best.post.Name} ${best.day.Date} (dayId=${best.day.ID}) — fetching entries`);

      const edto = { postId: null, primaryId: null, applications: null, scheduleDayId: best.day.ID, scheduleEntryId: '', Date: new Date(best.day.Date).toISOString(), isReschedule: 'false' };
      const er = await callApi(cdp, '/api/v1/schedule-group/get-family-consular-schedule-entries', edto, env.appd);
      if (!er.ok) { log(`cycle ${cycle}: entries HTTP ${er.status} ${(er.body||'').substring(0,120)} — back to sweep`); await sleep(3000); continue; }
      if (er.data.HasError) { log(`cycle ${cycle}: entries HasError ${JSON.stringify(er.data.Errors).substring(0,200)} — back to sweep`); await sleep(3000); continue; }
      const entries = (er.data.ScheduleEntries || []).filter(e => (e.EntriesAvailable || 0) >= 1);
      if (entries.length === 0) { log(`cycle ${cycle}: ${best.post.Name} ${best.day.Date} — no entries with seats — back to sweep`); await sleep(3000); continue; }
      const pick = entries[0];
      log(`cycle ${cycle}: ENTRY pick ${best.post.Name} ${best.day.Date} time=${pick.Time} Num=${pick.Num} seats=${pick.EntriesAvailable} — SUBMITTING`);

      // submit — payload mirrors onClickSubmit jsdata state (post-entries)
      const submitDto = {
        primaryId: null, applications: null, postId: null,
        scheduleDayId: best.day.ID, scheduleEntryId: '',
        Date: new Date(best.day.Date).toISOString(),
        isReschedule: undefined,
        Token: er.data.Token,
        Num: pick.Num
      };
      delete submitDto.isReschedule;
      const sr = await callApi(cdp, '/api/v1/schedule-group/schedule-consular-appointments-for-family', submitDto, env.appd);
      if (!sr.ok) {
        log(`cycle ${cycle}: SUBMIT HTTP ${sr.status} ${(sr.body||'').substring(0,200)}`);
        await sleep(3000); continue;
      }
      log(`cycle ${cycle}: SUBMIT response ${JSON.stringify(sr.data).substring(0,500)}`);
      if (sr.data.AllScheduled) {
        log(`*** BOOKED *** ${best.post.Name} ${best.day.Date} ${pick.Time}`);
        submitDone = true;
      } else if (sr.data.HasError) {
        log(`cycle ${cycle}: submit HasError ${JSON.stringify(sr.data.Errors).substring(0,250)} — continuing sweep`);
        await sleep(2000);
      } else {
        log(`cycle ${cycle}: submit ambiguous response — continuing`);
        await sleep(3000);
      }
    } catch (e) {
      log(`cycle ${cycle}: error ${e.message} — retrying in 5s`);
      await sleep(5000);
    }
  }

  log(submitDone ? '=== BOOKED — run complete ===' : '=== 20min deadline reached — run over, no slot found ===');
  process.exit(0);
})().catch(e => { log('FATAL:', e.message); process.exit(1); });
