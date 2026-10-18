// Drive the consular API flow via the page's own jQuery in the MAIN world —
// posts -> days per city -> entries for first available day. READ-ONLY: no submit.
const { chromium } = require('patchright');

const APPD = '021f5a9b-8d54-ee11-be6e-001dd80aed1a';
const PRIMARY = 'e43becc6-b1a0-f111-a3d0-001dd801ec9f';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling.com'));
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  console.log('URL:', page.url());

  const cdp = await ctx.newCDPSession(page);
  const evalMain = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 45000 });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const post = (route, dto) => `(function(){return new Promise(function(res){
    $.ajax({
      url: "/en-US/custom-actions/?route=" + encodeURI("${route}") + "&appd=${APPD}&cacheString=" + Date.now(),
      type: "POST",
      data: "parameters=" + JSON.stringify(${JSON.stringify(dto)}),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      dataType: "json",
      timeout: 30000,
      success: function(d){ res({ok:true, data:d}); },
      error: function(x){ res({ok:false, status:x.status, body:(x.responseText||'').substring(0,160)}); }
    });
  })})()`;

  // 1. Consular posts
  console.log('--- query-consular-posts ---');
  const postsRes = await evalMain(post('/api/v1/schedule-group/query-consular-posts', { applicationId: PRIMARY }));
  if (!postsRes || postsRes === 'EXC' || typeof postsRes === 'string') { console.log('posts fail:', postsRes); process.exit(1); }
  if (!postsRes.ok) { console.log('posts HTTP fail:', postsRes.status, postsRes.body); process.exit(1); }
  const posts = postsRes.data.Posts || [];
  console.log('HasError:', postsRes.data.HasError, '| Posts:', posts.map(p => `${p.Name}=${p.ID}`).join(', '));
  if (postsRes.data.HasError) { console.log('Errors:', JSON.stringify(postsRes.data.Errors).substring(0,300)); }

  // 2. Days per post
  const dayResults = [];
  for (const p of posts) {
    const dto = {
      primaryId: PRIMARY,
      applications: [PRIMARY],
      postId: p.ID,
      scheduleDayId: '',
      scheduleEntryId: '',
      isReschedule: 'false'
    };
    const dr = await evalMain(post('/api/v1/schedule-group/get-family-consular-schedule-days', dto));
    const n = dr && dr.ok ? (dr.data.ScheduleDays || []).length : -1;
    const err = dr && dr.ok && dr.data.HasError ? JSON.stringify(dr.data.Errors).substring(0,200) : (dr && !dr.ok ? `HTTP ${dr.status} ${dr.body}` : '');
    console.log(`days ${p.Name}: ${n} day(s) ${err ? '| ' + err : ''}`);
    dayResults.push({ name: p.Name, id: p.ID, days: dr && dr.ok ? (dr.data.ScheduleDays || []) : [], raw: dr });
    await new Promise(r => setTimeout(r, 1500)); // gap between cities like the sweep
  }

  // 3. Entries for the first post that has days
  const withDays = dayResults.find(r => r.days.length > 0);
  if (withDays) {
    const day = withDays.days[0];
    console.log(`--- entries ${withDays.name} ${day.Date} (dayId=${day.ID}) ---`);
    const dto = {
      postId: null, primaryId: null, applications: null,
      scheduleDayId: day.ID,
      scheduleEntryId: '',
      Date: new Date(day.Date).toISOString(),
      isReschedule: 'false'
    };
    const er = await evalMain(post('/api/v1/schedule-group/get-family-consular-schedule-entries', dto));
    if (er && er.ok) {
      const entries = er.data.ScheduleEntries || [];
      console.log(`entries: ${entries.length}`, JSON.stringify(entries).substring(0, 800));
      console.log('HasError:', er.data.HasError, '| Token present:', !!er.data.Token);
    } else {
      console.log('entries fail:', JSON.stringify(er).substring(0, 300));
    }
  } else {
    console.log('No post returned any days — nothing to fetch entries for.');
  }

  process.exit(0);
})().catch(e => { console.error('PROBE FAIL:', e); process.exit(1); });
