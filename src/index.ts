import { launchBrowser, connectToBrowser, ensureChromeRunning, BrowserConnection } from './browser';
import { loadConfig } from './config';
import { monitorNetwork } from './network-monitor';
import { saveScreenshot, savePageState } from './diagnostics';
import { login } from './auth';
import { answerSecurityQuestions } from './security-questions';
import {
  waitForHumanVerificationIfNeeded,
  isHumanVerificationPresent,
  isLoginFailedPage
} from './cloudflare';
import {
  navigateToOfcSchedule,
  selectCity,
  detectNoSlots,
  selectFirstAvailableTime,
  submitAppointment
  , getHomePageUrl
} from './ofc-schedule';
import { getCityRefreshDelayMs } from './ofc-schedule';
import {
  waitForCalendarReady,
  selectCalendarMonthYear,
  chooseDateInRange,
  clickCalendarDate,
  getAvailableDates
} from './calendar';
import { waitForScheduleResponse } from './schedule-api';
import { sendSupabaseEvent } from './supabase';
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from './checkpoint';
import { info, warn, error } from './logger';

declare const process: {
  exit: (code?: number) => never;
};

function buildRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getBackoffDelayMs(kind: '403' | '429', consecutiveCount: number): number {
  const jitter = Math.floor(Math.random() * 5000);
  if (kind === '403') {
    if (consecutiveCount <= 2) return 10000 + jitter;
    if (consecutiveCount <= 5) return 90000 + jitter;
    return 15 * 60 * 1000 + jitter;
  }

  const exponential = Math.min(10 * 60 * 1000, 30000 * Math.max(1, consecutiveCount));
  return exponential + jitter;
}

async function sendMajorEventAlert(config: any, eventType: string, payload: Record<string, unknown>) {
  if (!config.alertOnMajorEvents) return;
  // Only send login and appointment submission events to Supabase
  const allowed = new Set(['login', 'appointment_submitted']);
  if (!allowed.has(eventType)) return;
  await sendSupabaseEvent(eventType, {
    ...payload,
    timestamp: new Date().toISOString()
  }).catch(() => null);
}

async function pageHasSelector(page: any, selector: string) {
  return (await page.locator(selector).count()) > 0;
}

async function isLoginPage(page: any) {
  return (
    (await pageHasSelector(page, '#signInName')) ||
    (await pageHasSelector(page, 'input[title*="username" i]')) ||
    (await pageHasSelector(page, 'input[placeholder*="username" i]')) ||
    (await pageHasSelector(page, 'input[id*="user" i]'))
  );
}

async function isSecurityQuestionPage(page: any) {
  return (
    (await pageHasSelector(page, 'p.textInParagraph[id^="kbq"]')) &&
    (await pageHasSelector(page, 'input[type="password"]'))
  );
}

async function isHomePage(page: any) {
  return (
    page.url().includes('/en-US/') &&
    !page.url().includes('/en-US/ofc-schedule') &&
    (await pageHasSelector(page, '#continue_application'))
  );
}

async function isSchedulePage(page: any) {
  return (
    page.url().includes('/en-US/ofc-schedule') &&
    (await pageHasSelector(page, '#post_select'))
  );
}

async function isInternalPage(page: any) {
  const url = page.url();
  return (
    !url ||
    url === 'about:blank' ||
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('about:blank?')
  );
}

async function isRelevantSite(page: any) {
  const url = page.url();
  return /https?:\/\/(.*\.)?(usvisascheduling\.com|b2clogin\.com)/i.test(url);
}

async function isVerificationPage(page: any) {
  return await isHumanVerificationPresent(page);
}

async function resumeFromCurrentPage(page: any, config: any, options?: { allowNavigation?: boolean }) {
  const allowNavigation = options?.allowNavigation !== false;
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');
    const state = {
      internal: await isInternalPage(page),
      schedule: await isSchedulePage(page),
      login: await isLoginPage(page),
      security: await isSecurityQuestionPage(page),
      home: await isHomePage(page),
      verification: await isVerificationPage(page),
      relevant: await isRelevantSite(page)
    };

    info(`Resume check [${attempt}/${maxAttempts}]: URL =`, currentUrl, 'title =', currentTitle, 'state =', state);

    if (state.internal) {
      if (!allowNavigation) {
        info('Internal browser page detected; navigation disabled for checkpoint resume. Waiting for page change.');
        await page.waitForTimeout(1500);
        continue;
      }
      info('Internal browser page detected. Navigating to authUrl.');
      await page.goto(config.authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      continue;
    }

    if (state.schedule) {
      info('Resuming from existing schedule page.');
      return;
    }

    if (state.verification) {
      info('Cloudflare or bot verification page detected. Waiting for completion.');
      await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare);
      continue;
    }

    if (await isLoginFailedPage(page)) {
      if (!allowNavigation) {
        warn('Login failed page detected; navigation disabled for checkpoint resume. Waiting for manual/page recovery.');
        await page.waitForTimeout(1500);
        continue;
      }
      warn('Detected login failure page. Restarting from authUrl.');
      await page.goto(config.authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      continue;
    }

    if (state.login) {
      info('Resuming from login page.');
      await login(page, config);
      continue;
    }

    if (state.security) {
      info('Resuming from security questions page.');
      await answerSecurityQuestions(page, config.securityQuestions);
      continue;
    }

    if (state.home) {
      info('Resuming from home page. Clicking Schedule Appointment.');
      await navigateToOfcSchedule(page, config.scheduleUrl);
      continue;
    }

    if (!state.relevant) {
      if (!allowNavigation) {
        info('Current page is not relevant site and navigation is disabled. Waiting for page changes.');
        await page.waitForTimeout(1500);
        continue;
      }
      info('Current page is not relevant site. Navigating to authUrl.');
      await page.goto(config.authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      continue;
    }

    info('Current page is relevant but not recognized. Waiting for state changes.');
    await page.waitForTimeout(2000);
  }

  throw new Error('Unable to resume automation from current browser state after multiple attempts.');
}

async function main() {
  const config = loadConfig();
  const runId = buildRunId();
  const previousCheckpoint = loadCheckpoint();
  const resumableCheckpointStates = new Set(['city_selection', 'date_selected', 'time_selected', 'checkpoint_resume']);
  if (previousCheckpoint) {
    info('Loaded previous checkpoint', previousCheckpoint);
  }

  // Ensure Chrome is running and exposing the CDP port; attempt to start it if not.
  await ensureChromeRunning(config).catch(() => null);
  const browserLaunch = await connectToBrowser(config);
  const isExistingBrowser = browserLaunch?.existing === true;
  const { browser, context, page } =
    browserLaunch ?? await launchBrowser(config);

  monitorNetwork(page, config.debugNetwork);

  const checkpointCanResumeInPlace = !!previousCheckpoint && resumableCheckpointStates.has(previousCheckpoint.state);
  const currentPageIsInternal = await isInternalPage(page);
  const resumeWithoutNavigation = isExistingBrowser && checkpointCanResumeInPlace && !currentPageIsInternal;
  await resumeFromCurrentPage(page, config, { allowNavigation: !resumeWithoutNavigation });

  const appointmentCities = Array.isArray(config.appointment.city)
    ? config.appointment.city
    : [config.appointment.city];
  let cityIndex = 0;
  // startingCityIndex is used to rotate through configured cities deterministically
  let startingCityIndex = 0;
  let consecutive403 = 0;
  let consecutive429 = 0;

  let attempt = previousCheckpoint?.attempt ?? 0;
  let booked = false;
  let checkpointFastResumePending = checkpointCanResumeInPlace;

  if (previousCheckpoint?.city) {
    const cpCity = previousCheckpoint.city.trim().toLowerCase();
    const index = appointmentCities.findIndex((city) => city.trim().toLowerCase() === cpCity);
    if (index >= 0) {
      cityIndex = index;
      startingCityIndex = index;
    }
  }

  if (previousCheckpoint) {
    await sendMajorEventAlert(config, 'checkpoint_loaded', {
      runId,
      state: previousCheckpoint.state,
      attempt: previousCheckpoint.attempt,
      city: previousCheckpoint.city || null,
      date: previousCheckpoint.date || null,
      time: previousCheckpoint.time || null,
      url: page.url()
    });
  }

  // Run continuously until booked
  while (!booked) {
    attempt += 1;
    info(`Appointment attempt ${attempt}`);

    // determine current city index for this attempt (rotate when multiple cities configured)
    let currentIndex = cityIndex;
    if (appointmentCities.length > 1) {
      currentIndex = (startingCityIndex + (attempt - 1)) % appointmentCities.length;
    }

    // Hard retry at special moments: mm:26, 56, 57, 58 at ss:00
    try {
      const now = new Date();
      const m = now.getMinutes();
      const s = now.getSeconds();
      const specialMinutes = [26, 56, 57, 58];
      if (specialMinutes.includes(m) && s === 0) {
        info(`Exact special moment detected (mm:${m}:00). Performing rapid city reselection window.`);
        const windowEnd = Date.now() + 5000; // 5s window
        const startIndex = currentIndex;
        let tried = 0;
        // attempt cities in round-robin order while inside the 5s window
        while (Date.now() < windowEnd && tried < appointmentCities.length) {
          const tryIndex = (startIndex + tried) % appointmentCities.length;
          const tryCity = appointmentCities[tryIndex];
          info(`Special-moment try (${tried + 1}/${appointmentCities.length}): ${tryCity}`);
          saveCheckpoint({
            runId,
            state: 'city_selection',
            attempt,
            city: tryCity,
            url: page.url(),
            timestamp: new Date().toISOString()
          });

          // launch schedule request and select city
          const scheduleResponsePromise = waitForScheduleResponse(page, 20000);
          await selectCity(page, tryCity, appointmentCities.length > 1);
          const sr = await scheduleResponsePromise;
          const ns = await detectNoSlots(page);

          if (sr && sr.available) {
            // move cityIndex to this city and continue into date/time flow
            cityIndex = tryIndex;
            startingCityIndex = tryIndex;
            info('Availability detected during special-moment city try:', tryCity);
            break;
          }

          // advance to next city for next attempt
          tried += 1;

          // wait a small randomized interval but ensure we stay within the 5s window
          const remaining = Math.max(0, windowEnd - Date.now());
          if (remaining <= 0) break;
          const delay = Math.min(remaining, Math.floor(Math.random() * 5000));
          await page.waitForTimeout(delay);
        }
      }
    } catch (e) {
      warn('Special-moment reselection logic failed:', e);
    }

    const currentCity = appointmentCities[currentIndex];
    let scheduleResult: Awaited<ReturnType<typeof waitForScheduleResponse>> | null = null;
    let noSlots = false;
    let skippedCitySelectionFromCheckpoint = false;
    let manualCitySelectionDetected = false;

    if (
      checkpointFastResumePending &&
      previousCheckpoint &&
      (previousCheckpoint.state === 'city_selection' || previousCheckpoint.state === 'date_selected' || previousCheckpoint.state === 'time_selected') &&
      (await isSchedulePage(page))
    ) {
      // Verify the currently selected city in the schedule page matches the expected city
      let selectedCityText: string | null = null;
      try {
        selectedCityText = await page.evaluate(() => {
          const sel = document.querySelector('#post_select') as HTMLSelectElement | null;
          if (!sel) return null;
          const opt = sel.selectedOptions && sel.selectedOptions.length ? sel.selectedOptions[0] : null;
          return opt ? (opt.textContent || '').trim() : null;
        });
      } catch (e) {
        selectedCityText = null;
      }

      const normalizedSelected = selectedCityText ? String(selectedCityText).trim().toLowerCase() : null;
      const normalizedCurrentCity = String(currentCity).trim().toLowerCase();

      // If the checkpoint state was specifically 'city_selection', always reselect
      const forceReselectFromCheckpoint = previousCheckpoint.state === 'city_selection';
      if (!forceReselectFromCheckpoint && normalizedSelected && normalizedSelected === normalizedCurrentCity) {
        // Fast-resume: selected city matches checkpoint, skip reselect and continue
        skippedCitySelectionFromCheckpoint = true;
        checkpointFastResumePending = false;
        info('Checkpoint fast-resume active: schedule page already open and selected city matches checkpoint, skipping city re-selection and continuing from current UI state.');
        saveCheckpoint({
          runId,
          state: 'checkpoint_resume',
          attempt,
          city: currentCity,
          date: previousCheckpoint.date,
          time: previousCheckpoint.time,
          url: page.url(),
          timestamp: new Date().toISOString()
        });
      } else {
        // Either the selected city doesn't match, or we were asked to force reselection from checkpoint
        info(forceReselectFromCheckpoint
          ? 'Checkpoint indicates city_selection; forcing city reselection to refresh schedule.'
          : 'Schedule page open but selected city does not match checkpoint; reselecting city.');
        checkpointFastResumePending = false;
        saveCheckpoint({
          runId,
          state: 'city_selection',
          attempt,
          city: currentCity,
          url: page.url(),
          timestamp: new Date().toISOString()
        });
        const scheduleResponsePromise = waitForScheduleResponse(page, 20000);
        await selectCity(page, currentCity, appointmentCities.length > 1);
        scheduleResult = await scheduleResponsePromise;
        noSlots = await detectNoSlots(page);
      }
    } else {
      checkpointFastResumePending = false;
      saveCheckpoint({
        runId,
        state: 'city_selection',
        attempt,
        city: currentCity,
        url: page.url(),
        timestamp: new Date().toISOString()
      });
      const scheduleResponsePromise = waitForScheduleResponse(page, 20000);
      // Start listening for any schedule responses (manual user selection)
      const manualResponsePromise = page.waitForResponse(
        (res) => {
          try {
            return (
              res.request().method() === 'POST' &&
              res.url().includes('/custom-actions/') &&
              res.url().includes('/api/v1/schedule-group/get-family-ofc-schedule-days')
            );
          } catch {
            return false;
          }
        },
        { timeout: 25000 }
      ).catch(() => null);
      
      await selectCity(page, currentCity, appointmentCities.length > 1);
      scheduleResult = await scheduleResponsePromise;
      noSlots = await detectNoSlots(page);
      
      // Check if a manual city selection happened (response came before our intentional select)
      const manualResponse = await manualResponsePromise;
      if (manualResponse) {
        try {
          // If the manual-detection response is the same network response we already
          // received via our scheduled `waitForScheduleResponse`, treat it as NOT manual
          // to avoid false positives when our own select triggers the same API call.
          if (scheduleResult && scheduleResult.response) {
            try {
              const sameUrl = String(scheduleResult.response.url() || '').toLowerCase() === String(manualResponse.url() || '').toLowerCase();
              const sameStatus = Number(scheduleResult.status) === Number(manualResponse.status());
              if (sameUrl && sameStatus) {
                info('Detected schedule response but it matches our own request; ignoring as manual selection.');
                // skip treating this as a manual selection
                // fall through without setting `manualCitySelectionDetected`
                // (keep existing scheduleResult/noSlots values)
              } else {
                const status = manualResponse.status();
                const text = await manualResponse.text();
                const payload = (() => {
                  try {
                    return JSON.parse(text);
                  } catch {
                    const firstBrace = text.indexOf('{');
                    const lastBrace = text.lastIndexOf('}');
                    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
                    try {
                      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
                    } catch {
                      return null;
                    }
                  }
                })();
                const scheduleDays = Array.isArray(payload?.ScheduleDays) ? payload.ScheduleDays : [];
                const scheduleEntries = Array.isArray(payload?.ScheduleEntries) ? payload.ScheduleEntries : [];
                const available = status >= 200 && status < 300 && !payload?.HasError && (scheduleDays.length > 0 || scheduleEntries.length > 0);

                info('[MANUAL SELECTION] Schedule API response received', {
                  status,
                  available,
                  scheduleDays: scheduleDays.length,
                  scheduleEntries: scheduleEntries.length,
                  scheduleDaySamples: scheduleDays.slice(0, 50),
                  scheduleEntrySamples: scheduleEntries.slice(0, 50)
                });

                const calendarVisible = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
                if (calendarVisible) {
                  info('Calendar became visible; manual city selection detected. Skipping retry logic.');
                  manualCitySelectionDetected = true;
                }
              }
            } catch (e) {
              // If detection comparison fails, fall back to conservative manual-detection
              const status = manualResponse.status();
              const text = await manualResponse.text();
              const payload = (() => {
                try {
                  return JSON.parse(text);
                } catch {
                  const firstBrace = text.indexOf('{');
                  const lastBrace = text.lastIndexOf('}');
                  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
                  try {
                    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
                  } catch {
                    return null;
                  }
                }
              })();
              const scheduleDays = Array.isArray(payload?.ScheduleDays) ? payload.ScheduleDays : [];
              const scheduleEntries = Array.isArray(payload?.ScheduleEntries) ? payload.ScheduleEntries : [];
              const available = status >= 200 && status < 300 && !payload?.HasError && (scheduleDays.length > 0 || scheduleEntries.length > 0);

              info('[MANUAL SELECTION] Schedule API response received', {
                status,
                available,
                scheduleDays: scheduleDays.length,
                scheduleEntries: scheduleEntries.length,
                scheduleDaySamples: scheduleDays.slice(0, 50),
                scheduleEntrySamples: scheduleEntries.slice(0, 50)
              });

              const calendarVisible = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
              if (calendarVisible) {
                info('Calendar became visible; manual city selection detected. Skipping retry logic.');
                manualCitySelectionDetected = true;
              }
            }
          } else {
            const status = manualResponse.status();
            const text = await manualResponse.text();
            const payload = (() => {
              try {
                return JSON.parse(text);
              } catch {
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
                try {
                  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
                } catch {
                  return null;
                }
              }
            })();
            const scheduleDays = Array.isArray(payload?.ScheduleDays) ? payload.ScheduleDays : [];
            const scheduleEntries = Array.isArray(payload?.ScheduleEntries) ? payload.ScheduleEntries : [];
            const available = status >= 200 && status < 300 && !payload?.HasError && (scheduleDays.length > 0 || scheduleEntries.length > 0);

            info('[MANUAL SELECTION] Schedule API response received', {
              status,
              available,
              scheduleDays: scheduleDays.length,
              scheduleEntries: scheduleEntries.length,
              scheduleDaySamples: scheduleDays.slice(0, 50),
              scheduleEntrySamples: scheduleEntries.slice(0, 50)
            });

            const calendarVisible = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
            if (calendarVisible) {
              info('Calendar became visible; manual city selection detected. Skipping retry logic.');
              manualCitySelectionDetected = true;
            }
          }
        } catch (e) {
          warn('Error while processing manual city selection response:', e);
        }
      }
    }

    if (scheduleResult && scheduleResult.status === 403) {
      consecutive403 += 1;
      consecutive429 = 0;
      warn('Received HTTP 403 from schedule API. Attempting recovery via Visa Application Home link.');
      const delayMs = getBackoffDelayMs('403', consecutive403);
      await sendMajorEventAlert(config, 'schedule_403', {
        runId,
        attempt,
        consecutive403,
        city: currentCity,
        backoffMs: delayMs,
        url: page.url()
      });
      try {
        const homeLink = page.locator('a[title="Visa Application Home"]');
        if ((await homeLink.count()) > 0) {
          info('Found Visa Application Home link; clicking to return to home page');
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
            homeLink.first().click()
          ]);
        } else {
          info('Visa Application Home link not found; navigating to home URL');
          await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        }

        // After returning to home (or landing on login), resumeFromCurrentPage will detect the correct state
        // (login, verification, home, schedule) and continue the normal resume flow.
        try {
          await resumeFromCurrentPage(page, config);
          await page.waitForTimeout(delayMs);
          // resumeFromCurrentPage will navigate to OFC schedule when ready; continue main loop
          continue;
        } catch (e) {
          warn('resumeFromCurrentPage failed during 403 recovery; will break and surface error', e);
          break;
        }
      } catch (e) {
        error('Error during 403 recovery flow:', e);
        break;
      }
    }

    if (scheduleResult && scheduleResult.status === 429) {
      consecutive429 += 1;
      consecutive403 = 0;
      warn('Received HTTP 429 from schedule API. Rate limiting detected.');
      const delayMs = getBackoffDelayMs('429', consecutive429);
      await sendMajorEventAlert(config, 'schedule_429', {
        runId,
        attempt,
        consecutive429,
        city: currentCity,
        backoffMs: delayMs,
        url: page.url()
      });
      await page.waitForTimeout(delayMs);
      continue;
    }

    consecutive403 = 0;
    consecutive429 = 0;

    if (scheduleResult && !scheduleResult.available && !scheduleResult.timeout) {
      warn('Schedule API indicates no availability for this city.');
      if (noSlots) {
        warn('No slots message also visible in the UI.');
      }

      let calendarHasDates = false;
      // If manual city selection was detected and calendar is visible, skip retry and proceed
      if (manualCitySelectionDetected) {
        try {
          const calendarVisible = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
          if (calendarVisible) {
            info('Manual city selection detected with calendar visible; proceeding to date/time flow.');
            // Skip to date/time selection
            calendarHasDates = true;
          }
        } catch (e) {
          // ignore and proceed with normal flow
        }
      }
      try {
        const dates = await getAvailableDates(page).catch(() => []);
        if (Array.isArray(dates) && dates.length > 0) {
          calendarHasDates = true;
          info('Calendar UI reports available dates despite API saying no availability.');
        }
      } catch (e) {
        // ignore UI detection errors and fall back to API-driven behavior
      }

      if (calendarHasDates) {
        info('Proceeding to date/time flow because calendar shows dates.');
      } else {
        // Retry reselection a few times when API reports no availability and UI shows none.
        // When multiple target cities are configured, prefer rotating to the next city
        // instead of repeatedly reselecting the same city to improve coverage.
        let uiApiMismatchRetries = (config as any).uiApiMismatchRetries ?? 2;
        const uiApiMismatchRetryDelayMs = (config as any).uiApiMismatchRetryDelayMs ?? 1000;
        if (appointmentCities.length > 1) uiApiMismatchRetries = 0;
        let mismatchResolved = false;
        for (let r = 0; r < uiApiMismatchRetries; r += 1) {
          info(`API reports no availability; retrying reselection (${r + 1}/${uiApiMismatchRetries}) for city: ${currentCity}`);
          saveCheckpoint({
            runId,
            state: 'city_selection',
            attempt,
            city: currentCity,
            url: page.url(),
            timestamp: new Date().toISOString()
          });

          const scheduleResponsePromise = waitForScheduleResponse(page, 20000);
          await selectCity(page, currentCity, appointmentCities.length > 1);
          scheduleResult = await scheduleResponsePromise;
          noSlots = await detectNoSlots(page);

          try {
            const dates = await getAvailableDates(page).catch(() => []);
            if (Array.isArray(dates) && dates.length > 0) {
              calendarHasDates = true;
              info('Calendar UI reports available dates after retry.');
            }
          } catch (e) {
            // ignore
          }

          if ((scheduleResult && scheduleResult.available) || calendarHasDates) {
            mismatchResolved = true;
            info('Availability detected on retry or calendar shows dates; proceeding to date/time flow.');
            break;
          }

          // small delay before next retry
          await page.waitForTimeout(uiApiMismatchRetryDelayMs);
        }

        if (!mismatchResolved) {
          if (appointmentCities.length > 1) {
            // advance to the next city to try (rotate starting index)
            startingCityIndex = (startingCityIndex + 1) % appointmentCities.length;
            cityIndex = startingCityIndex;

            // compute base retry (20s) plus random up to 2s
            const baseSeconds = 20;
            const baseMs = baseSeconds * 1000;
            const randomMs = Math.floor(Math.random() * 2000);

            // compute ms until next special windows (24:58 and 55:58)
            const msUntilNextSpecial = (() => {
              try {
                const now = new Date();
                const candidates = [] as number[];
                for (const m of [24, 55]) {
                  const special = new Date(now);
                  special.setMinutes(m, 58, 0);
                  if (special.getTime() <= now.getTime()) {
                    special.setHours(special.getHours() + 1);
                  }
                  candidates.push(special.getTime() - now.getTime());
                }
                return Math.min(...candidates);
              } catch {
                return Infinity;
              }
            })();

            // If a special window occurs sooner than our normal wait, perform an in-place reselection
            if (msUntilNextSpecial < baseMs + randomMs) {
              const nextCity = appointmentCities[cityIndex];
              info(`Special window imminent; performing immediate in-place reselection for city: ${nextCity}`);
              saveCheckpoint({
                runId,
                state: 'city_selection',
                attempt,
                city: nextCity,
                url: page.url(),
                timestamp: new Date().toISOString()
              });

              try {
                const scheduleResponsePromise2 = waitForScheduleResponse(page, 20000);
                await selectCity(page, nextCity, appointmentCities.length > 1);
                scheduleResult = await scheduleResponsePromise2;
                noSlots = await detectNoSlots(page);
              } catch (e) {
                warn('Special-window in-place reselection failed:', e);
              }

              // If still no availability, advance to the following city and wait the normal interval
              if (scheduleResult && !scheduleResult.available && !scheduleResult.timeout) {
                startingCityIndex = (startingCityIndex + 1) % appointmentCities.length;
                cityIndex = startingCityIndex;
                const delayMs = baseMs + randomMs;
                info(`No availability after special reselection; advancing to next city and waiting ${delayMs}ms before retry.`);
                await page.waitForTimeout(delayMs);
                continue;
              }

              // Otherwise, proceed into the normal date/time flow for the selected city
              info('Continuing flow after special-window reselection.');
            } else {
              let delayMs = baseMs + randomMs;
              // add a tiny buffer so we hit after the special moment when applicable
              if (msUntilNextSpecial < delayMs) delayMs = msUntilNextSpecial + 1000;
              info(`Switching to next configured city: ${appointmentCities[cityIndex]}. Waiting ${delayMs}ms before retry (base ${baseMs}ms + rand ${randomMs}ms).`);
              await page.waitForTimeout(delayMs);
              continue;
            }
          }

          const delayMs = getCityRefreshDelayMs();
          info(`Waiting ${delayMs}ms before retry`);
          await page.waitForTimeout(delayMs);
          continue;
        }
      }

    }

    if (scheduleResult?.timeout) {
      warn('Schedule API response timed out; falling back to UI state.');
      // Try to detect whether the calendar UI became available despite the timeout.
      // If the calendar is not visible within a short grace period, treat this as
      // a transient failure and retry next city / wait instead of proceeding
      // into the date/time flow (which will otherwise time out waiting for the calendar).
      try {
        const cal = await page.waitForSelector('#datepicker, .ui-datepicker', { timeout: 5000 }).catch(() => null);
        if (!cal) {
          warn('Calendar not visible after schedule timeout; will retry outer loop instead of date/time flow.');
          const delayMs = getCityRefreshDelayMs();
          info(`Waiting ${delayMs}ms before retry due to schedule timeout`);
          await page.waitForTimeout(delayMs);
          continue;
        }
        info('Calendar became visible despite schedule API timeout; proceeding to date/time flow.');
      } catch (e) {
        warn('Error while checking calendar visibility after schedule timeout:', e);
        const delayMs = getCityRefreshDelayMs();
        await page.waitForTimeout(delayMs);
        continue;
      }
    }

    if (skippedCitySelectionFromCheckpoint) {
      info('Proceeding directly to date/time flow from checkpoint state.');
    }

    // After city selection, retry date+time selection a few times before falling back to reselecting city
    const maxDateAttempts = (config as any).maxDateAttempts ?? 3;
    let dateAttempt = 0;
    let dateLoopContinue = false;

    while (dateAttempt < maxDateAttempts && !booked) {
      dateAttempt += 1;
      info(`Date/time attempt ${dateAttempt}/${maxDateAttempts} for appointment try ${attempt}`);

      // Wait for calendar, but recover gracefully if it doesn't appear.
      try {
        await waitForCalendarReady(page, 30000);
      } catch (e) {
        warn('Calendar did not become ready within timeout; attempting recovery steps.', e);
        let recovered = false;

        // Try a few recovery attempts: reselect city, short waits, or navigate back to schedule
        for (let rec = 0; rec < 3 && !recovered; rec += 1) {
          try {
            info(`Recovery attempt ${rec + 1}/3: reselecting city and checking calendar`);
            // reselect current city to trigger schedule refresh
            try {
                await selectCity(page, currentCity, appointmentCities.length > 1);
            } catch {
              // ignore errors from selectCity
            }
            // brief wait then check for calendar
            await page.waitForTimeout(2000);
            const cal = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
            if (cal) {
              info('Recovery: calendar is visible after reselection');
              recovered = true;
              break;
            }

            // If still not visible, try navigating to schedule URL and resume
            try {
              info('Recovery: navigating to schedule URL to force page state');
              await page.goto(config.scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
              await resumeFromCurrentPage(page, config).catch(() => null);
            } catch {
              // ignore
            }

            await page.waitForTimeout(3000);
            const cal2 = await page.locator('#datepicker, .ui-datepicker').count().then(c => c > 0).catch(() => false);
            if (cal2) {
              info('Recovery: calendar visible after navigation');
              recovered = true;
              break;
            }
          } catch (err) {
            warn('Recovery attempt failed', err);
          }
        }

        if (!recovered) {
          warn('Unable to recover calendar visibility; aborting date/time attempts for this city and retrying outer loop');
          dateLoopContinue = true;
          break; // break date loop and retry outer city selection
        }
      }

      await selectCalendarMonthYear(page, config.appointment.month, config.appointment.year);

      // Try to select a date in the configured month first.
      let chosenDate = await chooseDateInRange(
        page,
        config.appointment.startDate,
        config.appointment.endDate,
        []
      );

      // If no date found in the configured month, look across the visible calendar
      // for the earliest available date within the configured range and select it
      // by switching the calendar to that month/year and clicking the exact date.
      if (!chosenDate) {
        try {
          const allAvailable = await getAvailableDates(page).catch(() => []);
          const candidate = allAvailable
            .filter((d) => d.date >= config.appointment.startDate && d.date <= config.appointment.endDate)
            .sort((a, b) => a.date.localeCompare(b.date))[0];

          if (candidate) {
            info(`No dates in configured month; selecting alternative date ${candidate.date}`);
            const yearNum = Number(candidate.date.slice(0, 4));
            const monthNum = Number(candidate.date.slice(5, 7));
            // Switch calendar to the candidate's month/year then click the date
            await selectCalendarMonthYear(page, monthNum, yearNum);
            await page.waitForTimeout(300).catch(() => null);
            await clickCalendarDate(page, candidate.date);
            chosenDate = candidate.date;
          } else {
            warn('No available date found within configured range');
            dateLoopContinue = true;
            break; // break date loop and retry outer city selection
          }
        } catch (e) {
          warn('Error while attempting cross-month date selection:', e);
          dateLoopContinue = true;
          break;
        }
      }

      saveCheckpoint({
        runId,
        state: 'date_selected',
        attempt,
        city: currentCity,
        date: chosenDate,
        url: page.url(),
        timestamp: new Date().toISOString()
      });
      if (config.screenshotAfterSelection) {
        await saveScreenshot(page, `date-selected-${chosenDate}`);
      }

      const chosenTime = await selectFirstAvailableTime(page, config.appointment.preferredTime ?? null);
      if (!chosenTime) {
        warn('No available appointment time found after selecting date');
        // try another date/time within this calendar without changing city
        if (dateAttempt >= maxDateAttempts) {
          dateLoopContinue = true;
          break;
        }
        await page.waitForTimeout(getCityRefreshDelayMs());
        continue;
      }

      saveCheckpoint({
        runId,
        state: 'time_selected',
        attempt,
        city: currentCity,
        date: chosenDate,
        time: chosenTime,
        url: page.url(),
        timestamp: new Date().toISOString()
      });
      if (config.screenshotAfterSelection) {
        await saveScreenshot(page, `time-selected-${String(chosenTime).replace(/\s+/g, '-')}`);
      }

      // Attempt submission. submitAppointment currently is non-destructive in testing mode.
      const submitResult = await submitAppointment(page);
      if (submitResult === true) {
        booked = true;
        saveCheckpoint({
          runId,
          state: 'booked',
          attempt,
          city: currentCity,
          date: chosenDate,
          time: chosenTime,
          url: page.url(),
          timestamp: new Date().toISOString()
        });
        await sendMajorEventAlert(config, 'appointment_submitted', {
          runId,
          attempt,
          city: currentCity,
          date: chosenDate,
          time: chosenTime,
          url: page.url()
        });
        break;
      }

      // If submission failed, retry date/time selection without reselecting city
      warn('Appointment submission did not complete successfully; retrying date/time selection');
      if (dateAttempt >= maxDateAttempts) {
        dateLoopContinue = true;
        break;
      }
      await page.waitForTimeout(getCityRefreshDelayMs());
    }

    if (dateLoopContinue) {
      // proceed to next outer attempt which will reselect city
      continue;
    }
  }

  if (!booked) {
    error('Failed to book appointment after all attempts');
    saveCheckpoint({
      runId,
      state: 'not_booked',
      attempt,
      url: page.url(),
      timestamp: new Date().toISOString()
    });
    await sendMajorEventAlert(config, 'run_stopped_without_booking', {
      runId,
      attempt,
      url: page.url()
    });
    await saveScreenshot(page, 'failure');
    await savePageState(page, 'failure-state');
    process.exit(1);
  }

  clearCheckpoint();
  info('Appointment booking completed successfully');
}

main();
