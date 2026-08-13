import { launchBrowser, connectToBrowser, BrowserConnection } from './browser';
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

  const browserLaunch = await connectToBrowser(config);
  const isExistingBrowser = browserLaunch?.existing === true;
  const { browser, context, page } =
    browserLaunch ?? await launchBrowser(config);

  monitorNetwork(page, config.debugNetwork);

  try {
    const checkpointCanResumeInPlace = !!previousCheckpoint && resumableCheckpointStates.has(previousCheckpoint.state);
    const currentPageIsInternal = await isInternalPage(page);
    const resumeWithoutNavigation = isExistingBrowser && checkpointCanResumeInPlace && !currentPageIsInternal;
    await resumeFromCurrentPage(page, config, { allowNavigation: !resumeWithoutNavigation });

    const appointmentCities = Array.isArray(config.appointment.city)
      ? config.appointment.city
      : [config.appointment.city];
    let cityIndex = 0;
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

      const currentCity = appointmentCities[cityIndex];
      let scheduleResult: Awaited<ReturnType<typeof waitForScheduleResponse>> | null = null;
      let noSlots = false;
      let skippedCitySelectionFromCheckpoint = false;

      if (
        checkpointFastResumePending &&
        previousCheckpoint &&
        (previousCheckpoint.state === 'city_selection' || previousCheckpoint.state === 'date_selected' || previousCheckpoint.state === 'time_selected') &&
        (await isSchedulePage(page))
      ) {
        skippedCitySelectionFromCheckpoint = true;
        checkpointFastResumePending = false;
        info('Checkpoint fast-resume active: schedule page already open, skipping city re-selection and continuing from current UI state.');
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
        await selectCity(page, currentCity);
        scheduleResult = await scheduleResponsePromise;
        noSlots = await detectNoSlots(page);
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

        if (appointmentCities.length > 1) {
          cityIndex = (cityIndex + 1) % appointmentCities.length;
          const delayMs = 10000 + Math.floor(Math.random() * 10000);
          info(`Switching to next configured city: ${appointmentCities[cityIndex]}. Waiting ${delayMs}ms before retry.`);
          await page.waitForTimeout(delayMs);
          continue;
        }

        const delayMs = getCityRefreshDelayMs();
        info(`Waiting ${delayMs}ms before retry`);
        await page.waitForTimeout(delayMs);
        continue;
      }

      if (scheduleResult?.timeout) {
        warn('Schedule API response timed out; falling back to UI state.');
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

        await waitForCalendarReady(page, 30000);
        await selectCalendarMonthYear(page, config.appointment.month, config.appointment.year);

        const chosenDate = await chooseDateInRange(
          page,
          config.appointment.startDate,
          config.appointment.endDate,
          []
        );
        if (!chosenDate) {
          warn('No available date found within configured range');
          dateLoopContinue = true;
          break; // break date loop and retry outer city selection
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
  } catch (err) {
    error('Unhandled error during automation:', err);
    saveCheckpoint({
      runId,
      state: 'unhandled_error',
      attempt: 0,
      url: page.url(),
      lastError: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString()
    });
    await sendMajorEventAlert(config, 'unhandled_error', {
      runId,
      url: page.url(),
      error: err instanceof Error ? err.message : String(err)
    });
    await saveScreenshot(page, 'error');
    await savePageState(page, 'error-state');
    process.exit(1);
  } finally {
    if (!isExistingBrowser) {
      await context.close().catch(() => null);
    }
    if (!isExistingBrowser) {
      await browser.close().catch(() => null);
    }
  }
}

main();
