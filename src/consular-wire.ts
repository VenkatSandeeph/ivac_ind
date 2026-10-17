import type { Page } from 'patchright';
import { info, warn, client, uiStatus, backendError, debug } from './logger';
import type { AutomationConfig } from './config';
import { resolveConsularRange, scrapeOfcAppointment, consularStatusLabel } from './consular-schedule';
import { sendConfirmationPdfToTelegram } from './confirmation';
import { sendSupabaseEvent } from './supabase';
import { playBeep } from './beep';
import { recordSlotObservation } from './slot-tracker';
import { parseOfcDateStr } from './utils';

// =============================================================================
// Consular wire mode — direct API sweep for the form-suppressed schedule page
// -----------------------------------------------------------------------------
// When the server renders /en-US/schedule/ as a skeleton (warning banner, no
// #page_form/#post_select), the DOM sweep has nothing to drive — but the
// session's custom-actions API answers normally. This module replicates the
// page's own wire contract exactly:
//
//   query-consular-posts              { applicationId }
//   query-family-members-consular(-reschedule)  { primaryId, visaClass:"all" }
//   get-family-consular-schedule-days { primaryId, applications, postId,
//                                     scheduleDayId:"", scheduleEntryId:"",
//                                     isReschedule }
//   get-family-consular-schedule-entries { postId:null, primaryId:null,
//                                     applications:null, scheduleDayId, Date(UTC
//                                     ISO), scheduleEntryId:"", isReschedule }
//   schedule-consular-appointments-for-family = post-entries jsdata + Num +
//                                     Token (the ENTRIES token — the days token
//                                     is stale by then; same PSE0601 lesson as
//                                     OFC wire replay).
//
// Client-visible logging deliberately mirrors runConsularSchedule line-for-line
// so the UI looks identical to a normal DOM sweep; raw wire detail goes to
// info()/debug()/backendError() only. Runs INSIDE the page's main world via CDP
// Runtime.evaluate (page globals/jsdata/jQuery are invisible to patchright's
// isolated world). Every call is navigation-safe: an eval returning null means
// the execution context died mid-call — the loop just re-scrapes next sweep.
// =============================================================================

export type ConsularWireExit = 'booked' | 'stopped' | 'exit' | 'locked';

type WireEnv = {
  appd: string;
  primaryId: string;
  applications: string[];
  isReschedule: string;
  membersRoute: string;
};

type WireResponse = {
  ok: boolean;
  status?: number;
  body?: string;
  data?: any;
};

/** Evaluate in the page's main world; resolves promises (ajax calls). */
async function evalMainWorld(page: Page, expression: string): Promise<unknown> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      const desc = (r.exceptionDetails.exception as any)?.description || r.exceptionDetails.text;
      debug(`[CONSULAR-WIRE] eval exception: ${String(desc).substring(0, 160)}`);
      return null;
    }
    return r.result?.value ?? null;
  } catch {
    return null; // navigation destroyed the context / page gone
  }
}

/** One custom-actions POST via the page's own jQuery — same shape as the site's scripts. */
async function wirePost(page: Page, route: string, dto: unknown, appd: string): Promise<WireResponse | null> {
  const expr = `new Promise(function(res){
    try {
      $.ajax({
        url: "/en-US/custom-actions/?route=" + encodeURI(${JSON.stringify(route)}) + "&appd=" + ${JSON.stringify(appd)} + "&cacheString=" + Date.now(),
        type: "POST",
        data: "parameters=" + JSON.stringify(${JSON.stringify(dto)}),
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        dataType: "json",
        timeout: 30000,
        success: function(d){ res({ok:true, data:d}); },
        error: function(x){ res({ok:false, status:x.status||0, body:(x.responseText||'').substring(0,300)}); }
      });
    } catch(e) { res({ok:false, status:-1, body:String(e)}); }
  })`;
  return (await evalMainWorld(page, expr)) as WireResponse | null;
}

/**
 * Scrape the live request context from the page — fresh every sweep. The page
 * can navigate at any moment (bot recovery, B2C re-login), so nothing here is
 * cached. Returns null while the page can't serve wire calls (mid-load, CF
 * challenge, logged-out page with no emitted appd).
 */
async function scrapeWireEnv(page: Page): Promise<WireEnv | null> {
  const v = await evalMainWorld(page, `(function(){
    var html = document.documentElement.innerHTML || '';
    var am = html.match(/appd=([0-9a-fA-F-]{36})/);
    if (!am) return null;
    if (typeof $ !== 'function') return null;
    var jd = (typeof jsdata !== 'undefined' && jsdata) ? jsdata : {};
    var pid = jd.primaryId || (html.match(/jsdata\\['primaryId'\\]\\s*=\\s*"([0-9a-fA-F-]{36})"/) || [])[1] || null;
    if (!pid) return null;
    var apps = (typeof applications !== 'undefined' && Array.isArray(applications) && applications.length)
      ? applications.slice()
      : (Array.isArray(jd.applications) && jd.applications.length ? jd.applications.slice() : []);
    var rm = html.match(/jsdata\\['isReschedule'\\]\\s*=\\s*"([^"]+)"/);
    var mr = html.indexOf('query-family-members-consular-reschedule') >= 0
      ? '/api/v1/schedule-group/query-family-members-consular-reschedule'
      : '/api/v1/schedule-group/query-family-members-consular';
    return { appd: am[1], primaryId: pid, applications: apps, isReschedule: rm ? rm[1] : 'false', membersRoute: mr };
  })()`);
  if (!v || typeof v !== 'object') return null;
  return v as WireEnv;
}

/** Chunked sleep honoring the stop callback — mirrors sleepWithStopSignal. */
async function wireSleep(ms: number, shouldStop?: () => boolean): Promise<boolean> {
  let remaining = ms;
  while (remaining > 0) {
    if (shouldStop?.()) return true;
    const wait = Math.min(1000, remaining);
    await new Promise((r) => setTimeout(r, wait));
    remaining -= wait;
  }
  return false;
}

/** Normalize a consular post name: config cities arrive already VAC-stripped. */
function postNameKey(name: unknown): string {
  return String(name ?? '').replace(/\s+VAC$/i, '').trim().toUpperCase();
}

/** ScheduleDays[].Date → "YYYY-MM-DD" for range comparison (format varies). */
function dayIso(raw: unknown): string | null {
  const s = String(raw ?? '');
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = parseOfcDateStr(s);
  if (parsed) return parsed;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

/**
 * The site's own conversion in getScheduleEntries: new Date(raw) parsed in
 * local time → rebuilt as a UTC instant → toISOString.
 */
function utcIsoOfDay(raw: unknown): string {
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds())).toISOString();
}

function errorCode(data: any): string | null {
  const msg = String(data?.Errors?.m_StringValue ?? '');
  const m = msg.match(/PSE\d{4}/);
  return m ? m[0] : null;
}

/**
 * Self-contained consular wire sweep. Runs until one of:
 *   'booked'        — AllScheduled + landed on the confirmation page
 *   'stopped'       — stop signal at an await boundary
 *   'exit'          — form restored, page left the site, or CF streak — the
 *                     caller re-classifies and picks DOM or recovery
 *   'locked'        — PSE0612/PSE0602 on submit (account-level, not retryable)
 *
 * Polling cadence matches the DOM sweep (2-4s inter-city gaps,
 * consular.cityRetrySeconds between sweeps) — the CF budget is shared with
 * every other profile on this machine. The only burst is the reactive
 * days→entries→submit chain, which fires solely when a date exists.
 */
export async function runConsularWireLoop(
  page: Page,
  config: AutomationConfig,
  shouldStop?: () => boolean,
  onSweepBoundary?: () => Promise<void>
): Promise<ConsularWireExit> {
  const cities = config.consular.city || [];
  if (cities.length === 0) {
    warn('[CONSULAR-WIRE] no consular cities configured — cannot sweep.');
    return 'exit';
  }
  const range = resolveConsularRange(config);
  const unbounded = !range.startDate || !range.endDate;
  const retryMs = Math.max(1, config.consular?.cityRetrySeconds ?? 15) * 1000;
  let cfStreak = 0;

  await scrapeOfcAppointment(page); // same cached OFC label the DOM stage shows
  info(`[CONSULAR-WIRE] sweeping ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} [${cities.join(', ')}] — ${unbounded ? 'earliest available' : `range ${range.startDate} → ${range.endDate}`}`);

  for (;;) {
    if (shouldStop?.()) return 'stopped';
    await onSweepBoundary?.(); // UI Rotate-IP flag etc., same as the DOM loop

    // Form restored → hand control back to the DOM sweep.
    const formBack = await page.evaluate(() => !!document.querySelector('#post_select, #page_form')).catch(() => false);
    if (formBack) {
      info('[CONSULAR-WIRE] schedule form restored — returning to DOM flow.');
      return 'exit';
    }
    if (!/usvisascheduling\.com/i.test(page.url())) {
      warn(`[CONSULAR-WIRE] page left the site (${page.url()}) — returning to recovery.`);
      return 'exit';
    }

    const env = await scrapeWireEnv(page);
    if (!env) {
      debug('[CONSULAR-WIRE] env scrape failed (page mid-navigation or logged out) — retrying.');
      if (await wireSleep(5000, shouldStop)) return 'stopped';
      continue;
    }

    // Member list — normally populated by the page's onVisaClassSelectChange;
    // on the skeleton page it can be empty, so wire mode queries it itself.
    if (env.applications.length === 0) {
      const mr = await wirePost(page, env.membersRoute, { primaryId: env.primaryId, visaClass: 'all' }, env.appd);
      if (mr?.ok && !mr.data?.HasError && Array.isArray(mr.data?.Members)) {
        env.applications = mr.data.Members.map((m: any) => m?.ApplicationID).filter(Boolean);
      }
      if (env.applications.length === 0) {
        backendError('consular-wire/members', mr?.ok ? 200 : (mr?.status ?? null), errorCode(mr?.data), 'no members returned');
        if (await wireSleep(8000, shouldStop)) return 'stopped';
        continue;
      }
      info(`[CONSULAR-WIRE] member list populated: ${env.applications.length} application(s).`);
    }

    // Posts — one query per sweep doubles as the session health check.
    const postsRes = await wirePost(page, '/api/v1/schedule-group/query-consular-posts', { applicationId: env.primaryId }, env.appd);
    if (!postsRes) {
      if (await wireSleep(5000, shouldStop)) return 'stopped';
      continue;
    }
    if (!postsRes.ok) {
      backendError('consular-wire/posts', postsRes.status ?? null, null, (postsRes.body || '').substring(0, 160));
      if (postsRes.status === 403 || postsRes.status === 429) {
        if (++cfStreak >= 3) {
          warn('[CONSULAR-WIRE] Cloudflare throttling persists — yielding to normal block recovery.');
          return 'exit';
        }
        if (await wireSleep(30000, shouldStop)) return 'stopped';
      } else if (await wireSleep(8000, shouldStop)) return 'stopped';
      continue;
    }
    if (postsRes.data?.HasError) {
      backendError('consular-wire/posts', 200, errorCode(postsRes.data), String(postsRes.data?.Errors?.m_StringValue ?? '').substring(0, 160));
      if (await wireSleep(8000, shouldStop)) return 'stopped';
      continue;
    }
    cfStreak = 0;

    const posts: Array<{ ID: string; Name: string }> = postsRes.data?.Posts || [];
    const postByName = new Map(posts.map((p) => [postNameKey(p.Name), p]));

    client('🏛️', `Checking consular: ${cities.join(', ')}...`);
    uiStatus(consularStatusLabel());

    // Days per configured city — collect all, then pick the global earliest
    // in-range day (matches "quickest/earliest date" semantics).
    const found: Array<{ postName: string; postId: string; day: any; iso: string }> = [];
    for (let ci = 0; ci < cities.length; ci++) {
      if (shouldStop?.()) return 'stopped';
      const city = cities[ci];
      const post = postByName.get(postNameKey(city));
      if (!post) {
        warn(`[CONSULAR-WIRE] configured city "${city}" not in the posts response — skipping.`);
        continue;
      }
      if (ci > 0) {
        // Same per-city pacing as the DOM sweep — cityRetrySeconds applies
        // between selects, not just between sweeps (see consular-schedule.ts).
        const gapMs = retryMs + Math.floor(Math.random() * 3000);
        client('⏳', `Consular: next city in ${(gapMs / 1000).toFixed(0)}s...`);
        if (await wireSleep(gapMs, shouldStop)) return 'stopped';
      }

      const daysDto = {
        primaryId: env.primaryId,
        applications: env.applications,
        postId: post.ID,
        scheduleDayId: '',
        scheduleEntryId: '',
        isReschedule: env.isReschedule
      };
      const dr = await wirePost(page, '/api/v1/schedule-group/get-family-consular-schedule-days', daysDto, env.appd);
      if (!dr) continue;
      if (!dr.ok) {
        backendError('consular-wire/days', dr.status ?? null, null, `${post.Name} ${(dr.body || '').substring(0, 120)}`);
        if (dr.status === 403 || dr.status === 429) {
          if (++cfStreak >= 3) {
            warn('[CONSULAR-WIRE] Cloudflare throttling persists — yielding to normal block recovery.');
            return 'exit';
          }
          if (await wireSleep(15000, shouldStop)) return 'stopped';
        }
        continue;
      }
      if (dr.data?.HasError) {
        backendError('consular-wire/days', 200, errorCode(dr.data), `${post.Name} ${String(dr.data?.Errors?.m_StringValue ?? '').substring(0, 160)}`);
        continue;
      }
      cfStreak = 0;
      const days: any[] = dr.data?.ScheduleDays || [];
      client('🏙️', `Selected ${city} | Calendar Visible: ${days.length > 0}`);
      info(`[CONSULAR-WIRE] ${post.Name}: ${days.length} day(s).`);

      // Formatted date list — same client line as the DOM sweep/OFC paths.
      if (days.length > 0) {
        const allIsos = days.map((d) => dayIso(d?.Date)).filter(Boolean) as string[];
        const inRangeIsos = allIsos.filter((iso) => unbounded || (iso >= range.startDate && iso <= range.endDate));
        client('📅', `Consular calendar visible for ${city} — ${allIsos.length} date(s): ${allIsos.join(', ')} (${inRangeIsos.length} in range)`);
      }

      for (const d of days) {
        const iso = dayIso(d?.Date);
        if (!iso) continue;
        if (!unbounded && (iso < range.startDate || iso > range.endDate)) continue;
        found.push({ postName: post.Name, postId: post.ID, day: d, iso });
      }
      recordSlotObservation({
        timestamp: new Date().toISOString(),
        profile: config.username,
        runId: `consular-wire-${Date.now()}`,
        stage: 'consular',
        city,
        url: page.url(),
        availableDates: days.map((d) => dayIso(d?.Date)).filter(Boolean) as string[],
        inRangeDates: days.map((d) => dayIso(d?.Date)).filter(Boolean).filter((iso) => unbounded || (iso! >= range.startDate && iso! <= range.endDate)) as string[],
        configuredRange: { startDate: range.startDate || 'any', endDate: range.endDate || 'any', month: 'any', year: 0 },
        apiScheduleDays: days.length,
        apiScheduleEntries: 0,
        apiAvailable: days.length > 0,
        calendarMonth: null,
      });
    }

    if (found.length === 0) {
      const waitMs = retryMs + Math.floor(Math.random() * 3000);
      client('📅', `No consular slots available, retrying in ${(waitMs / 1000).toFixed(0)}s...`);
      if (await wireSleep(waitMs, shouldStop)) return 'stopped';
      continue;
    }

    // Earliest in-range date across all cities → entries → submit, back-to-back.
    found.sort((a, b) => a.iso.localeCompare(b.iso));
    for (const cand of found) {
      if (shouldStop?.()) return 'stopped';
      info(`[CONSULAR-WIRE] date candidate ${cand.postName} ${cand.iso} (dayId=${cand.day?.ID}) — fetching entries.`);
      client('📅', `Consular date found — ${cand.postName} ${cand.iso}. Fetching times…`);
      playBeep();

      const dateUtc = utcIsoOfDay(cand.day?.Date);
      const entriesDto = {
        postId: null,
        primaryId: null,
        applications: null,
        scheduleDayId: cand.day?.ID,
        scheduleEntryId: '',
        Date: dateUtc,
        isReschedule: env.isReschedule
      };
      const er = await wirePost(page, '/api/v1/schedule-group/get-family-consular-schedule-entries', entriesDto, env.appd);
      if (!er) break; // context died mid-call — re-sweep
      if (!er.ok || er.data?.HasError) {
        backendError('consular-wire/entries', er.ok ? 200 : (er.status ?? null), errorCode(er.data),
          `${cand.postName} ${String(er.data?.Errors?.m_StringValue ?? er.body ?? '').substring(0, 160)}`);
        if (!er.ok && (er.status === 403 || er.status === 429) && ++cfStreak >= 3) return 'exit';
        continue; // next date candidate
      }
      cfStreak = 0;
      const need = Math.max(1, env.applications.length);
      const eligible = (er.data?.ScheduleEntries || []).filter((e: any) => (e?.EntriesAvailable || 0) >= need);
      if (eligible.length === 0) {
        info(`[CONSULAR-WIRE] ${cand.postName} ${cand.iso}: no entries with >= ${need} seat(s).`);
        continue;
      }

      for (const entry of eligible) {
        if (shouldStop?.()) return 'stopped';
        info(`[CONSULAR-WIRE] submitting ${cand.postName} ${cand.iso} time=${entry.Time} Num=${entry.Num} avail=${entry.EntriesAvailable}`);
        sendSupabaseEvent('submit_clicked', {
          username: config.username,
          stage: 'consular_wire',
          selected: { time: entry.Time, availability: entry.EntriesAvailable },
          url: page.url(),
          timestamp: new Date().toISOString()
        }).catch(() => null);

        // Post-entries jsdata shape + Num + the entries-level Token.
        const submitDto = {
          primaryId: null,
          applications: null,
          postId: null,
          scheduleDayId: cand.day?.ID,
          scheduleEntryId: '',
          Date: dateUtc,
          Token: er.data?.Token,
          Num: entry.Num
        };
        const sr = await wirePost(page, '/api/v1/schedule-group/schedule-consular-appointments-for-family', submitDto, env.appd);
        if (!sr) return 'exit'; // context died — likely a navigation (maybe the submit's own redirect)
        if (!sr.ok) {
          backendError('consular-wire/submit', sr.status ?? null, null, (sr.body || '').substring(0, 160));
          if (sr.status === 403 || sr.status === 429) {
            if (++cfStreak >= 3) return 'exit';
            if (await wireSleep(15000, shouldStop)) return 'stopped';
          }
          continue;
        }
        const body = sr.data || {};
        const errMsg = String(body?.Errors?.m_StringValue ?? '');
        if (body.AllScheduled) {
          client('✅', `CONSULAR BOOKED! ${cand.postName} — Date=${cand.iso} Time=${entry.Time}`);
          info(`[CONSULAR-WIRE] AllScheduled — redirect stub: ${body.RedirectStub || 'none'}`);
          // The site does window.location = "/en-US/" + RedirectStub — land on
          // the confirmation page so the normal PDF/Telegram capture runs.
          try {
            const base = new URL(page.url()).origin;
            if (body.RedirectStub) {
              await page.goto(`${base}/en-US/${String(body.RedirectStub).replace(/^\/+/, '')}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            }
          } catch { /* navigation is best-effort; the verdict is already AllScheduled */ }
          await sendConfirmationPdfToTelegram(page, config);
          return 'booked';
        }
        backendError('consular-wire/submit', 200, errorCode(body), errMsg.substring(0, 200));
        if (/PSE0612|PSE0602/i.test(errMsg)) {
          warn(`[CONSULAR-WIRE] account-level scheduling lock on submit: ${errMsg.substring(0, 160)}`);
          return 'locked';
        }
        client('❌', 'Submit failed — checking for another slot…');
        // Slot contention → next eligible entry, then next date candidate.
      }
    }

    // Candidates exhausted — brief pause then re-sweep.
    if (await wireSleep(3000, shouldStop)) return 'stopped';
  }
}
