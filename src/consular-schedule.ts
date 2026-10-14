import type { Page, Response } from 'patchright';
import { info, warn, client, uiStatus } from './logger';
import type { AutomationConfig } from './config';
import {
  selectCity,
  getAvailableTimeCandidates,
  selectTimeCandidate,
  detectNoSlots,
  waitForSubmitEnabled,
  type TimeCandidate
} from './ofc-schedule';
import {
  waitForCalendarReady,
  selectCalendarMonthYear,
  getDatesWithAllAvailable,
  clickDateCell,
  type DateCell
} from './calendar';
import { playBeep } from './beep';
import { recordSlotObservation } from './slot-tracker';
import { recordDateExperiment } from './date-experiment';
import { sendConfirmationPdfToTelegram, CONFIRMATION_URL_FRAGMENT } from './confirmation';
import { loadCheckpoint } from './checkpoint';
import { sendSupabaseEvent } from './supabase';
import { extractJsonFromHtml, orderDatesForAttempt } from './api-direct';
import { addBusinessDays, parseOfcDateStr } from './utils';

const CONSULAR_URL_FRAGMENT = '/en-US/schedule/';
const citySelectSelector = '#post_select';

// =============================================================================
// Consular response capture
// -----------------------------------------------------------------------------
// Mirrors the OFC capture pattern: a single page.on('response') listener parses
// the page's own consular API calls (consular routes never contain 'ofc').
// Two waiter types let the sweep act on REAL server verdicts instead of fixed
// sleeps:
//   days waiters   — resolve with ScheduleDays.length after a city select
//   submit waiters — resolve with the parsed submit verdict (AllScheduled/
//                    HasError) after onClickSubmit — the fix for the old 60s
//                    navigation-wait stall on failed submits.
// =============================================================================

let consularApiCallCount = 0;
// Last schedule-days count — short-circuits the DOM flow when the API already
// returned 0 days (avoids waiting 10s+ for a calendar with no green dates).
let lastConsularScheduleDaysCount = -1;

type ConsularSubmitVerdict = {
  httpStatus: number;
  allScheduled: boolean;
  hasError: boolean;
  errorMsg: string;
};

const consularDaysWaiters: Array<(count: number) => void> = [];
const consularSubmitWaiters: Array<(v: ConsularSubmitVerdict) => void> = [];

/**
 * Resolves with the ScheduleDays count from the next
 * get-family-consular-schedule-days response. Arm BEFORE selectCity — the
 * request fires inside onPostChange during the select. Null on timeout
 * (response never arrived — treat as "unknown", don't confuse with 0 days).
 */
export function waitForConsularDaysResult(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const waiter = (count: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(count);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = consularDaysWaiters.indexOf(waiter);
      if (i >= 0) consularDaysWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    consularDaysWaiters.push(waiter);
  });
}

/**
 * Resolves with the parsed verdict of the next
 * schedule-consular-appointments-for-family response. Arm BEFORE clicking
 * submit. Null on timeout.
 */
function waitForConsularSubmitResult(timeoutMs: number): Promise<ConsularSubmitVerdict | null> {
  return new Promise((resolve) => {
    let done = false;
    const waiter = (v: ConsularSubmitVerdict) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = consularSubmitWaiters.indexOf(waiter);
      if (i >= 0) consularSubmitWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    consularSubmitWaiters.push(waiter);
  });
}

// Listeners are installed once per Page object — the old code re-registered
// page.on('response') on every sweep call, stacking duplicate handlers.
let consularCapturePage: Page | null = null;

export function setupConsularResponseCapture(page: Page): void {
  consularApiCallCount = 0;
  lastConsularScheduleDaysCount = -1;
  if (consularCapturePage === page) return;
  consularCapturePage = page;

  // Log the page's own request post data for consular API calls
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!url.includes('/custom-actions/')) return;
      // Only log consular routes (not OFC routes which include 'ofc' in the path)
      const routeMatch = url.match(/route=([^&]+)/);
      if (!routeMatch) return;
      const route = decodeURIComponent(routeMatch[1]);
      if (route.includes('ofc')) return; // skip OFC routes

      if (route.includes('schedule-days') || route.includes('schedule-entries') || route.includes('appointments-for-family')) {
        const postData = (request.postData() || '').substring(0, 500);
        const shortRoute = route.replace('/api/v1/schedule-group/', '');
        info(`[CONSULAR] Page request: ${shortRoute}, method=${request.method()}, postData=${postData}`);
      }
    } catch { /* ignore */ }
  });

  page.on('response', async (response: Response) => {
    try {
      const url = response.url();
      if (!url.includes('/custom-actions/')) return;
      const routeMatch = url.match(/route=([^&]+)/);
      if (!routeMatch) return;
      const route = decodeURIComponent(routeMatch[1]);
      if (route.includes('ofc')) return; // skip OFC routes

      consularApiCallCount++;
      const shortRoute = route.replace('/api/v1/schedule-group/', '');
      info(`[CONSULAR] API call #${consularApiCallCount}: ${shortRoute} → HTTP ${response.status()}`);

      // Submit response → resolve armed waiters with the verdict
      if (route.includes('appointments-for-family')) {
        try {
          const body = await response.text().catch(() => '');
          info(`[CONSULAR] Submit response: HTTP ${response.status()}, bodyLen=${body.length}`);
          const parsed = extractJsonFromHtml(body);
          const verdict: ConsularSubmitVerdict = {
            httpStatus: response.status(),
            allScheduled: !!parsed?.AllScheduled,
            hasError: !!parsed?.HasError,
            errorMsg: parsed?.Errors?.m_StringValue || ''
          };
          info(`[CONSULAR] Submit parsed: AllScheduled=${verdict.allScheduled}, HasError=${verdict.hasError}, Errors=${verdict.errorMsg.substring(0, 300)}`);
          while (consularSubmitWaiters.length) consularSubmitWaiters.shift()!(verdict);
        } catch { /* ignore */ }
      }

      // Log schedule days/entries response counts
      if ((route.includes('schedule-days') || route.includes('schedule-entries')) && response.ok()) {
        try {
          const body = await response.text().catch(() => '');
          const parsed = extractJsonFromHtml(body);
          if (parsed) {
            if (route.includes('schedule-days')) {
              const count = parsed.ScheduleDays?.length || 0;
              const tokenLen = parsed.Token ? String(parsed.Token).length : 0;
              lastConsularScheduleDaysCount = count;
              info(`[CONSULAR] getScheduleDays: ${count} day(s), token=${tokenLen > 0 ? 'present' : 'null'}, HasError=${parsed.HasError || false}`);
              while (consularDaysWaiters.length) consularDaysWaiters.shift()!(count);
            } else if (route.includes('schedule-entries')) {
              const count = parsed.ScheduleEntries?.length || 0;
              const tokenLen = parsed.Token ? String(parsed.Token).length : 0;
              info(`[CONSULAR] getScheduleEntries: ${count} entry(ies), token=${tokenLen > 0 ? 'present' : 'null'}, HasError=${parsed.HasError || false}`);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });
}

/**
 * Verifies the page has navigated to the consular schedule page
 * (https://www.usvisascheduling.com/en-US/schedule/) and the city dropdown is present.
 */
export async function isOnConsularSchedulePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes(CONSULAR_URL_FRAGMENT)) return false;
  const hasSelect = await page.locator(citySelectSelector).count().then((c) => c > 0).catch(() => false);
  return hasSelect;
}

/**
 * Wait until the consular schedule page is ready (URL + #post_select visible).
 */
export async function waitForConsularSchedulePage(page: Page, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOnConsularSchedulePage(page)) {
      try {
        await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 5000 });
        return true;
      } catch {
        // fall through to retry
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// =============================================================================
// Consular date range resolution
// =============================================================================

/**
 * Resolve the consular date range. Priority:
 *   1. Explicit consular.startDate/endDate from config
 *   2. Auto range from the booked OFC date: +2 business days → +30 working days
 *      (India posts enforce consular ≥2 business days after OFC for document
 *      forwarding; +30wd keeps the window inside the ~6-week booking horizon).
 *      OFC date sources: caller hint → runtime checkpoint → the page's own
 *      ofcAppointments[] global (works on resume-after-restart).
 *   3. Fallback: the OFC configured range (today's behavior — never a crash).
 */
export async function resolveConsularRange(
  page: Page,
  config: AutomationConfig,
  ofcDateHint?: string
): Promise<{ startDate: string; endDate: string; source: string }> {
  if (config.consular.startDate && config.consular.endDate) {
    return { startDate: config.consular.startDate, endDate: config.consular.endDate, source: 'configured' };
  }

  let ofcDate = ofcDateHint?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;

  if (!ofcDate) {
    const cp = loadCheckpoint();
    if (cp?.date && /^\d{4}-\d{2}-\d{2}/.test(cp.date)) ofcDate = cp.date.substring(0, 10);
  }

  if (!ofcDate) {
    const scraped = await page.evaluate(() => {
      const arr = (window as any).ofcAppointments;
      return Array.isArray(arr) && arr.length > 0 ? String(arr[0].appointmentDateStr || '') : '';
    }).catch(() => '');
    ofcDate = parseOfcDateStr(scraped);
    if (ofcDate) info(`Consular range: scraped booked OFC date from page global: ${ofcDate}`);
  }

  if (ofcDate) {
    return {
      startDate: addBusinessDays(ofcDate, 2),
      endDate: addBusinessDays(ofcDate, 30),
      source: `auto from OFC ${ofcDate}`
    };
  }

  warn('Consular range: booked OFC date unavailable — falling back to the OFC configured range.');
  return {
    startDate: config.appointment.startDate,
    endDate: config.appointment.endDate,
    source: 'ofc-range-fallback'
  };
}

// =============================================================================
// Consular submit — response-aware (no 60s navigation stall on failure)
// =============================================================================

/**
 * Consular-only submit. The shared submitAppointment waits on a 60s navigation
 * promise that only resolves at timeout when the server answers HasError (the
 * page shows the error inline — no navigation happens). Here the verdict comes
 * from the schedule-consular-appointments-for-family RESPONSE captured by
 * setupConsularResponseCapture: HasError → return false in ~1-3s;
 * AllScheduled → the page redirects to /en-US/appointment-confirmation/.
 */
async function submitConsular(
  page: Page,
  config: AutomationConfig,
  opts?: { selected?: { time?: string; availability?: string | number } }
): Promise<boolean> {
  const btn = page.locator('#submitbtn');
  try {
    await btn.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    warn('Consular submit: #submitbtn not visible — skipping this slot');
    return false;
  }

  // Arm the response listener BEFORE clicking — the submit POST can complete
  // faster than we can subscribe after the click.
  const verdictPromise = waitForConsularSubmitResult(45000);

  // The radio click already set jsdata.Num via onSelectScheduleEntry; the
  // framework's toggleSubmit may lag. Quick-check, then force-enable.
  if (!(await waitForSubmitEnabled(page, 500))) {
    info('Consular submit: button not enabled after 500ms — force-enabling');
    await page.evaluate(() => {
      const b = document.querySelector('#submitbtn') as HTMLInputElement | null;
      if (b) { b.disabled = false; b.removeAttribute('disabled'); }
    }).catch(() => null);
  }

  // Prefer the page's own onClickSubmit() — same-origin jQuery POST with all
  // framework state. Fall back to a real button click if unavailable.
  const usedPageFn = await page.evaluate(() => {
    try {
      if (typeof (window as any).onClickSubmit === 'function') {
        (window as any).onClickSubmit();
        return true;
      }
    } catch { /* fall through */ }
    return false;
  });
  if (!usedPageFn) {
    await btn.click().catch((e) => warn('Consular submit: button click failed:', e));
  }

  // Fire-and-forget telemetry — same 'submit_clicked' event the OFC
  // submitAppointment emits, tagged with the consular stage.
  sendSupabaseEvent('submit_clicked', {
    username: config.username,
    stage: 'consular',
    selected: opts?.selected ?? null,
    url: page.url(),
    timestamp: new Date().toISOString()
  }).catch(() => null);

  info(`Consular submit fired (via ${usedPageFn ? 'onClickSubmit()' : 'button click'}); selected=${JSON.stringify(opts?.selected ?? null)}`);

  const verdict = await verdictPromise;
  if (verdict) {
    if (verdict.allScheduled) {
      info('Consular submit: AllScheduled=true — booking confirmed');
      return true;
    }
    if (verdict.httpStatus === 524 || verdict.httpStatus === 429) {
      warn(`Consular submit: HTTP ${verdict.httpStatus} — server overloaded`);
    } else {
      warn(`Consular submit failed: ${verdict.errorMsg || `HTTP ${verdict.httpStatus}`}`);
    }
    // Verdict only in the client log — raw server text stays in warn().
    client('❌', 'Submit failed — checking for another slot…');
    return false;
  }

  // No response within 45s — the page may still have navigated (e.g. the
  // response raced past the listener); check the URL as the final verdict.
  if (page.url().includes(CONFIRMATION_URL_FRAGMENT)) {
    info('Consular submit: no response captured but landed on confirmation page');
    return true;
  }
  warn('Consular submit: no response within 45s — treating as failed');
  client('❌', 'Submit timed out — checking for another slot…');
  return false;
}

// =============================================================================
// Consular sweep — all configured cities, one pass per call
// =============================================================================

/**
 * One consular sweep: for every configured consular city, select it, read the
 * days verdict, and — when the calendar shows in-range dates — click date →
 * time → submit immediately. Returns true only when a booking was submitted;
 * false after a full empty sweep (the outer loop waits consularCityRetrySeconds
 * and calls again).
 *
 * Reuses the OFC DOM helpers — the consular page shares the same element ids
 * (#post_select, #datepicker, #time_select, #submitbtn) and page globals
 * (jsdata, onPostChange, onClickSubmit). Only the API routes differ, and the
 * consular city names carry no " VAC" suffix (already stripped at config merge).
 */
export async function runConsularSchedule(
  page: Page,
  config: AutomationConfig,
  ofcDate?: string,
  shouldStop?: () => boolean
): Promise<boolean> {
  const consularStart = Date.now();
  info('Consular stage: waiting for /en-US/schedule/ to be ready');
  setupConsularResponseCapture(page);

  const ready = await waitForConsularSchedulePage(page, 45000);
  if (!ready) {
    warn(`Consular stage: page not ready at expected URL. current=${page.url()}`);
    return false;
  }
  info(`Consular stage: page ready at ${page.url()} (${Date.now() - consularStart}ms)`);

  const consularCities = config.consular.city;
  if (consularCities.length === 0) {
    warn('Consular stage: no consular cities configured (and OFC fallback produced none); aborting.');
    return false;
  }

  const range = await resolveConsularRange(page, config, ofcDate);
  info(`Consular stage: date range ${range.startDate} → ${range.endDate} (${range.source}); cities=[${consularCities.join(', ')}]`);
  uiStatus(`Consular — sweeping ${consularCities.length} cit${consularCities.length === 1 ? 'y' : 'ies'}`);

  // Month/year jump target derived from the resolved range start (same trick
  // mergeWithDefaults uses for OFC — the removed UI fields still drive the
  // calendar-jump fallback).
  const startParts = /^(\d{4})-(\d{2})-\d{2}/.exec(range.startDate);
  const targetMonth = startParts ? Number(startParts[2]) : config.appointment.month;
  const targetYear = startParts ? Number(startParts[1]) : config.appointment.year;

  for (let ci = 0; ci < consularCities.length; ci++) {
    if (shouldStop?.()) return false;
    const city = consularCities[ci];

    // Small gap between city selects inside a sweep — each fires a
    // getScheduleDays call; back-to-back selects look like a burst.
    if (ci > 0) {
      const gapMs = 2000 + Math.floor(Math.random() * 2000);
      await page.waitForTimeout(gapMs);
    }

    // Arm the days waiter BEFORE the select — onPostChange fires the request
    // synchronously inside the change dispatch.
    const daysPromise = waitForConsularDaysResult(15000);
    try {
      await selectCity(page, city, consularCities.length > 1, config);
    } catch (err) {
      warn(`Consular stage: selectCity failed for ${city}:`, err);
      continue;
    }
    const daysCount = await daysPromise;
    const effectiveDays = daysCount ?? (lastConsularScheduleDaysCount >= 0 ? lastConsularScheduleDaysCount : null);
    client('🏙️', `Selected ${city} | Calendar Visible: ${effectiveDays !== null ? effectiveDays > 0 : 'unknown'}`);

    // Fast path: API returned 0 days → no green dates possible → next city.
    if (effectiveDays === 0) {
      info(`Consular stage: ${city} returned 0 schedule days; next city.`);
      continue;
    }

    if (await detectNoSlots(page)) {
      warn(`Consular stage: no-slots banner after selecting ${city}; next city.`);
      continue;
    }

    try {
      await waitForCalendarReady(page, 10000);
      playBeep(); // calendar visible — fire-and-forget alert
    } catch (err) {
      warn(`Consular stage: calendar did not become ready for ${city}:`, err);
      continue;
    }

    try {
      await selectCalendarMonthYear(page, targetMonth, targetYear);
    } catch (err) {
      warn('Consular stage: failed to navigate calendar month/year:', err);
    }

    const { allAvailable, inRange } = await getDatesWithAllAvailable(page, range.startDate, range.endDate, []);

    // Client verdict + slot-tracker observation (fire-and-forget).
    if (allAvailable.length > 0) {
      client('📅', `Consular calendar visible for ${city} — ${allAvailable.length} date(s): ${allAvailable.map(d => d.date).join(', ')} (${inRange.length} in range)`);
    } else {
      client('📅', `Consular calendar visible for ${city} — no available dates this month.`);
    }
    recordSlotObservation({
      timestamp: new Date().toISOString(),
      profile: config.username,
      runId: `consular-${Date.now()}`,
      stage: 'consular',
      city,
      url: page.url(),
      availableDates: allAvailable.map(d => d.date),
      inRangeDates: inRange.map(d => d.date),
      configuredRange: {
        startDate: range.startDate,
        endDate: range.endDate,
        month: targetMonth,
        year: targetYear,
      },
      apiScheduleDays: effectiveDays ?? 0,
      apiScheduleEntries: 0,
      apiAvailable: (effectiveDays ?? 0) > 0,
      calendarMonth: null,
    });

    if (inRange.length === 0) {
      info(`Consular stage: ${city} has no dates in range; next city.`);
      continue;
    }

    // EXPERIMENTAL: avoidEarliestDate ordering applies to consular too —
    // decision + outcomes land in date-experiment.jsonl with path:'consular'.
    const candidateDates: DateCell[] = orderDatesForAttempt(inRange, (d) => d.date, config.avoidEarliestDate, {
      path: 'consular',
      profile: config.username,
      city
    });

    // Seat-eligibility floor: consular validateData() only checks jsdata.Num,
    // so the server can reject picks with fewer slots than family members.
    // Filter to avail >= applications.length (read from the page global the
    // members query populated; fallback 1).
    const memberCount = await page.evaluate(() => {
      const a = (window as any).applications;
      return Array.isArray(a) && a.length > 0 ? a.length : 1;
    }).catch(() => 1);

    for (let di = 0; di < candidateDates.length; di++) {
      if (shouldStop?.()) return false;
      const dateCell = candidateDates[di];
      // Rate-limit hygiene between date clicks (each fires getScheduleEntries).
      if (di > 0) {
        await page.waitForTimeout(2000 + Math.floor(Math.random() * 2000));
      }
      try {
        await clickDateCell(page, dateCell);
      } catch (err) {
        warn(`Consular stage: could not click date ${dateCell.date}:`, err);
        recordDateExperiment({ type: 'outcome', path: 'consular', profile: config.username, city, date: dateCell.date, pos: di, result: 'error' });
        continue;
      }

      const timeCandidates: TimeCandidate[] = await getAvailableTimeCandidates(
        page,
        config.appointment.preferredTime ?? null,
        config.preferLeastSlots
      );
      const eligible = timeCandidates.filter((c) => c.avail >= memberCount);
      if (eligible.length === 0) {
        warn(`Consular stage: no seat-eligible time slots for ${dateCell.date} (need ${memberCount}); next date.`);
        recordDateExperiment({ type: 'outcome', path: 'consular', profile: config.username, city, date: dateCell.date, pos: di, result: 'no_eligible' });
        continue;
      }

      for (const cand of eligible) {
        if (shouldStop?.()) return false;
        info(`Consular stage: ${city} ${dateCell.date} '${cand.time}' avail=${cand.avail} — submitting`);
        try {
          await selectTimeCandidate(page, cand);
        } catch (err) {
          warn(`Consular stage: time select failed for '${cand.time}':`, err);
          continue;
        }
        const submitted = await submitConsular(page, config, {
          selected: { time: cand.time, availability: cand.avail }
        });
        if (submitted) {
          info(`Consular stage: submit succeeded (${Date.now() - consularStart}ms total)`);
          client('✅', `CONSULAR BOOKED! ${city} — Date=${dateCell.date} Time=${cand.time}`);
          recordDateExperiment({ type: 'outcome', path: 'consular', profile: config.username, city, date: dateCell.date, pos: di, result: 'booked' });
          // Site lands on /en-US/appointment-confirmation/ — capture that page
          // as a PDF (CDP printToPDF, same output as the Print button), save a
          // local copy and send it to Telegram. Awaited because the process
          // exits after booking; the helper is bounded and never throws.
          await sendConfirmationPdfToTelegram(page, config);
          return true;
        }
        recordDateExperiment({ type: 'outcome', path: 'consular', profile: config.username, city, date: dateCell.date, pos: di, result: 'submit_error' });
        // Failed submit → try the next eligible time on the same date.
      }

      info(`Consular stage: exhausted times on ${dateCell.date}; next date.`);
    }
  }

  info(`Consular stage: sweep of ${consularCities.length} cit${consularCities.length === 1 ? 'y' : 'ies'} complete — nothing bookable (${Date.now() - consularStart}ms)`);
  return false;
}
