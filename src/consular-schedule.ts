import type { Page, Response } from 'patchright';
import { info, warn, client } from './logger';
import type { AutomationConfig } from './config';
import {
  selectCity,
  getAvailableTimeCandidates,
  selectTimeCandidate,
  submitAppointment,
  detectNoSlots
} from './ofc-schedule';
import {
  waitForCalendarReady,
  selectCalendarMonthYear,
  getSortedDatesInRange,
  getDatesWithAllAvailable,
  clickDateCell
} from './calendar';
import { playBeep } from './beep';
import { recordSlotObservation } from './slot-tracker';
import { sendConfirmationPdfToTelegram } from './confirmation';

const CONSULAR_URL_FRAGMENT = '/en-US/schedule/';
const citySelectSelector = '#post_select';

/**
 * Installs a response listener on the consular page to capture and log the
 * page's own API calls (getScheduleDays, getScheduleEntries, submit).
 * This gives us visibility into what the page sends and receives during
 * the consular stage — critical for debugging booking failures.
 *
 * The consular page uses the same jQuery/Power Apps framework as the OFC page,
 * with the same global functions (onClickSubmit, onPostChange, jsdata, token).
 */
let consularApiCallCount = 0;
// Track the last schedule-days count from the API so we can short-circuit
// the DOM flow when the API already returned 0 days (avoids waiting 30s+
// for a calendar that will have no green dates).
let lastConsularScheduleDaysCount = -1;

export function setupConsularResponseCapture(page: Page): void {
  consularApiCallCount = 0;
  lastConsularScheduleDaysCount = -1;

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

      // Log submit response details
      if (route.includes('appointments-for-family') && response.ok()) {
        try {
          const body = await response.text().catch(() => '');
          info(`[CONSULAR] Submit response: bodyLen=${body.length}`);
          // Try to extract JSON
          const jsonStart = body.indexOf('{');
          const jsonEnd = body.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            try {
              const parsed = JSON.parse(body.substring(jsonStart, jsonEnd + 1));
              info(`[CONSULAR] Submit parsed: AllScheduled=${parsed.AllScheduled}, HasError=${parsed.HasError}, RedirectStub=${parsed.RedirectStub || 'none'}, Errors=${JSON.stringify(parsed.Errors || {}).substring(0, 300)}`);
            } catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
      }

      // Log schedule days/entries response counts
      if ((route.includes('schedule-days') || route.includes('schedule-entries')) && response.ok()) {
        try {
          const body = await response.text().catch(() => '');
          const jsonStart = body.indexOf('{');
          const jsonEnd = body.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            try {
              const parsed = JSON.parse(body.substring(jsonStart, jsonEnd + 1));
              if (route.includes('schedule-days')) {
                const count = parsed.ScheduleDays?.length || 0;
                const tokenLen = parsed.Token ? String(parsed.Token).length : 0;
                lastConsularScheduleDaysCount = count;
                info(`[CONSULAR] getScheduleDays: ${count} day(s), token=${tokenLen > 0 ? 'present' : 'null'}, HasError=${parsed.HasError || false}`);
              } else if (route.includes('schedule-entries')) {
                const count = parsed.ScheduleEntries?.length || 0;
                const tokenLen = parsed.Token ? String(parsed.Token).length : 0;
                info(`[CONSULAR] getScheduleEntries: ${count} entry(ies), token=${tokenLen > 0 ? 'present' : 'null'}, HasError=${parsed.HasError || false}`);
              }
            } catch { /* not JSON */ }
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

/**
 * Runs the consular scheduling flow on /en-US/schedule/:
 * city -> calendar green day -> time -> submit. Reuses the OFC helpers since
 * the DOM structure (#post_select, #datepicker, #time_select, #submitbtn) is identical.
 */
export async function runConsularSchedule(page: Page, config: AutomationConfig): Promise<boolean> {
  const consularStart = Date.now();
  info('Consular stage: waiting for /en-US/schedule/ to be ready');

  // Install response capture for consular API calls (diagnostics)
  setupConsularResponseCapture(page);

  const ready = await waitForConsularSchedulePage(page, 45000);
  if (!ready) {
    warn(`Consular stage: page not ready at expected URL. current=${page.url()}`);
    return false;
  }
  info(`Consular stage: page ready at ${page.url()} (${Date.now() - consularStart}ms)`);

  const appointmentCities = Array.isArray(config.appointment.city)
    ? config.appointment.city
    : [config.appointment.city];
  const rawCity = String(appointmentCities[0] ?? '').trim();
  if (!rawCity) {
    warn('Consular stage: no city configured; aborting.');
    return false;
  }
  // OFC city names carry a trailing " VAC" suffix (e.g. "NEW DELHI VAC"),
  // but the consular dropdown lists the same cities without that suffix
  // (e.g. "NEW DELHI"). Strip it for the consular stage.
  const cityToSelect = rawCity.replace(/\s+VAC\s*$/i, '').trim();
  if (cityToSelect !== rawCity) {
    info(`Consular stage: normalized city "${rawCity}" -> "${cityToSelect}" (stripped VAC suffix)`);
  }

  // Consular stage: single attempt per call. The continuous monitoring loop
  // (runConsularStageWithRecovery in index.ts) handles retries with backoff.
  // Multiple attempts here just re-select the same city and get the same result,
  // wasting 30-45s per attempt on calendar waits.
  const maxAttempts = 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    info(`Consular stage: attempt ${attempt}/${maxAttempts} (city=${cityToSelect})`);

    // On the first attempt, wait for the page to fully load before selecting city.
    // The consular page loads asynchronously after OFC success — the <select> appears
    // immediately but options are populated by the Power Apps framework a few seconds later.
    if (attempt === 1) {
      info('Consular stage: waiting for page to fully load before city selection...');
      await page.waitForTimeout(2000);
    }

    try {
      await selectCity(page, cityToSelect, appointmentCities.length > 1, config);
    } catch (err) {
      warn('Consular stage: selectCity failed', err);
      if (attempt < maxAttempts) {
        info('Consular stage: waiting 3s before retry (dropdown may not have loaded)...');
        await page.waitForTimeout(3000);
      }
      continue;
    }

    // Fast path: if the API already returned 0 schedule days, skip the DOM flow
    // (calendar wait, month navigation, green-day scan). This saves 30-45s per
    // check and makes consular monitoring feel continuous.
    if (lastConsularScheduleDaysCount === 0) {
      info('Consular stage: API returned 0 schedule days; skipping DOM calendar check.');
      client('📅', `No consular slots for ${cityToSelect}`);
      return false;
    }

    if (await detectNoSlots(page)) {
      warn('Consular stage: no slots error after city selection');
      client('📅', `No consular slots for ${cityToSelect}`);
      await page.waitForTimeout(2000);
      continue;
    }

    try {
      await waitForCalendarReady(page, 10000);
      // Calendar is visible — beep immediately (fire-and-forget, non-blocking).
      playBeep();
    } catch (err) {
      warn('Consular stage: calendar did not become ready', err);
      client('📅', `No consular slots for ${cityToSelect}`);
      continue;
    }

    try {
      await selectCalendarMonthYear(page, config.appointment.month, config.appointment.year);
    } catch (err) {
      warn('Consular stage: failed to navigate calendar to configured month/year', err);
    }

    const candidateDates: { date: string; locator: any }[] = [];
    {
      // Single DOM evaluation — returns both all visible green dates and the
      // in-range subset with zero extra DOM round-trips.
      const { allAvailable, inRange } = await getDatesWithAllAvailable(
        page,
        config.appointment.startDate,
        config.appointment.endDate,
        []
      );
      candidateDates.push(...inRange);

      // Log all available dates to client (even if not in range)
      const consularAllDates = allAvailable.map(d => d.date);
      const consularInRangeDates = inRange.map(d => d.date);
      if (consularAllDates.length > 0) {
        let msg = `Consular calendar visible for ${cityToSelect} — ${consularAllDates.length} date(s) available: ${consularAllDates.join(', ')}`;
        if (consularInRangeDates.length > 0) {
          msg += ` (${consularInRangeDates.length} in range)`;
        } else {
          msg += ` (0 in range)`;
        }
        client('📅', msg);
      } else {
        client('📅', `Consular calendar visible for ${cityToSelect} — no available dates on this month.`);
      }

      // Record this consular calendar observation to the local JSONL log.
      // Fire-and-forget (non-blocking) — captures ALL visible green dates
      // (availableDates) and the in-range subset (inRangeDates) for pattern analysis.
      recordSlotObservation({
        timestamp: new Date().toISOString(),
        profile: config.username,
        runId: `consular-${Date.now()}`,
        stage: 'consular',
        city: cityToSelect,
        url: page.url(),
        availableDates: allAvailable.map(d => d.date),
        inRangeDates: inRange.map(d => d.date),
        configuredRange: {
          startDate: config.appointment.startDate,
          endDate: config.appointment.endDate,
          month: config.appointment.month,
          year: config.appointment.year,
        },
        apiScheduleDays: lastConsularScheduleDaysCount >= 0 ? lastConsularScheduleDaysCount : 0,
        apiScheduleEntries: 0,
        apiAvailable: lastConsularScheduleDaysCount > 0,
        calendarMonth: null,
      });
    }

    if (candidateDates.length === 0) {
      warn('Consular stage: no available green day within configured range');
      client('📅', `No consular slots for ${cityToSelect}`);
      continue;
    }
    info(`Consular stage: iterating ${candidateDates.length} candidate date(s):`, candidateDates.map(d => d.date).join(', '));

    for (let di = 0; di < candidateDates.length; di += 1) {
      const dateCell = candidateDates[di];
      // Rate-limit avoidance: pause between date attempts (2-4s), skip on first date.
      if (di > 0) {
        const gapMs = 2000 + Math.floor(Math.random() * 2000);
        info(`Consular stage: waiting ${gapMs}ms before trying next date (rate-limit avoidance)`);
        await page.waitForTimeout(gapMs);
      }
      try {
        await clickDateCell(page, dateCell);
      } catch (err) {
        warn(`Consular stage: could not click date ${dateCell.date}, skipping:`, err);
        continue;
      }

      const timeCandidates = await getAvailableTimeCandidates(page, config.appointment.preferredTime ?? null, config.preferLeastSlots);
      if (timeCandidates.length === 0) {
        warn(`Consular stage: no time slots for ${dateCell.date}; moving to next date`);
        continue;
      }

      // Adaptive enable-timeout: 20s only when there is exactly 1 date + 1 time; 5s otherwise.
      const singleOption = candidateDates.length === 1 && timeCandidates.length === 1;
      const enableTimeoutMs = singleOption ? 20000 : 5000;
      info(`Consular stage: submit-enable timeout=${enableTimeoutMs}ms (singleOption=${singleOption})`);

      for (let ti = 0; ti < timeCandidates.length; ti += 1) {
        const cand = timeCandidates[ti];
        const submitStart = Date.now();
        info(`Consular stage: date ${dateCell.date} time ${ti + 1}/${timeCandidates.length} '${cand.time}' avail=${cand.avail}`);
        await selectTimeCandidate(page, cand);
        const submitted = await submitAppointment(page, config, {
          enableTimeoutMs,
          selected: { time: cand.time, availability: cand.avail }
        });
        if (submitted === true) {
          info(`Consular stage: submit succeeded (${Date.now() - submitStart}ms, total ${Date.now() - consularStart}ms)`);
          client('✅', `CONSULAR BOOKED! Date=${dateCell.date} Time=${cand.time}`);
          // The site navigates to /en-US/appointment-confirmation/ after a
          // successful consular submit. Capture that page as a PDF (CDP
          // printToPDF — same output as the page's Print button) and send it
          // to Telegram. Awaited because the process exits after booking; the
          // helper is bounded and never throws.
          await sendConfirmationPdfToTelegram(page, config);
          return true;
        }
        warn(`Consular stage: submit not enabled/clicked for time '${cand.time}' (${Date.now() - submitStart}ms); trying next time`);
      }

      info(`Consular stage: exhausted times on ${dateCell.date}; moving to next date`);
    }

    warn('Consular stage: all candidate dates/times exhausted this attempt');
  }

  warn('Consular stage: exhausted attempts without success');
  return false;
}
