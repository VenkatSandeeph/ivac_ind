import fs from 'fs';
import path from 'path';
import { exec as execCmd, spawn as spawnCmd } from 'child_process';
import type { Page } from 'patchright';
import { launchBrowser, connectToBrowser, ensureChromeRunning } from './browser';
import { loadConfig } from './config';
import type { AutomationConfig } from './config';
import { rotateNordVpn, ipRotatedSince } from './nordvpn';
import { monitorNetwork } from './network-monitor';
import { saveScreenshot, savePageState } from './diagnostics';
import { login, handlePrivacyActStatement } from './auth';
import { answerSecurityQuestions } from './security-questions';
import {
  waitForHumanVerificationIfNeeded,
  isHumanVerificationPresent,
  isLoginFailedPage,
  isHardBlocked
} from './cloudflare';
import {
  navigateToOfcSchedule,
  selectCity,
  detectNoSlots,
  selectFirstAvailableTime,
  submitAppointment,
  getHomePageUrl,
  getAvailableTimeCandidates,
  selectTimeCandidate,
  findCityPostId
} from './ofc-schedule';
import {
  waitForCalendarReady,
  selectCalendarMonthYear,
  getAvailableDates,
  getSortedDatesInRange,
  getDatesWithAllAvailable,
  clickDateCell
} from './calendar';
import { waitForScheduleResponse } from './schedule-api';
import { runConsularSchedule } from './consular-schedule';
import { sendSupabaseEvent } from './supabase';
import { sendOfcBookedNotification } from './telegram';
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from './checkpoint';
import { info, warn, error, client, backendError, uiStatus } from './logger';
import { pageHasSelector, isLoginPage, waitForPortOpen, waitForPortClosed } from './utils';
import { readStoredLicenseKey, validateLicense } from './license';
import {
  startStaticProxy,
  readRelayMarker,
  writeRelayMarker,
  clearRelayMarker,
  STATIC_ROTATE_FLAG,
  type StaticProxyRelay
} from './static-proxy';
import { setupApiResponseCapture, runDirectOfcFlow, resetCapturedScheduleData, getMemberQueryResult, resetMemberQueryResult, consumeLateEntriesRescue, orderDatesForAttempt, type DirectApiResult } from './api-direct';
import { recordDateExperiment } from './date-experiment'; // EXPERIMENTAL: avoidEarliestDate
import { playBeep } from './beep';
import { recordSlotObservation } from './slot-tracker';

function buildRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function openNotificationVideo(page?: Page) {
  const url = 'https://www.youtube.com/watch?v=GNzOildQsNM';
  info(`Opening notification video: ${url}`);

  // Method 1: Open in the connected Chrome browser (same browser as the automation)
  // This is preferred because it opens in the same browser the user is already watching.
  if (page) {
    try {
      // Open YouTube in a new tab in the same browser context
      page.context().newPage().then(newTab => {
        info('Notification video opened in new tab in connected Chrome');
        newTab.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
      }).catch((err) => {
        warn('Could not open video in connected Chrome, falling back to default browser:', err instanceof Error ? err.message : String(err));
        openNotificationVideoFallback(url);
      });
      return;
    } catch {
      // Fall through to fallback
    }
  }

  openNotificationVideoFallback(url);
}

function openNotificationVideoFallback(url: string) {
  try {
    if (process.platform === 'win32') {
      // Use spawn with detached + shell so the browser opens even in pkg environment
      const child = spawnCmd('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false
      });
      child.unref();
    } else {
      execCmd(`open "${url}" || xdg-open "${url}"`).unref?.();
    }
  } catch {
    // non-fatal
  }
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

/**
 * True while inside a slot-drop window (20s before → 2.5min after a
 * system-clock trigger). The server is swamped with everyone's requests in
 * these windows — a slow response there is load, not a dead request, and
 * must be waited out. Wrapped mod 3600 so the :59:58 window tail extends
 * into the next hour.
 */
function inSpecialWindow(): boolean {
  const d = new Date();
  const sec = d.getMinutes() * 60 + d.getSeconds();
  return SPECIAL_WINDOW_TRIGGERS_SEC.some(
    (t) => ((sec - (t - 20)) % 3600 + 3600) % 3600 <= 170
  );
}

/**
 * City-selection (schedule-days) response wait. Busy-window responses can take
 * ~60s+; cutting at the normal 20s abandons a valid in-flight response (and its
 * slot). 75s inside windows, 20s otherwise.
 */
function scheduleWaitMs(): number {
  const base = inSpecialWindow() ? 75000 : 20000;
  // During a multi-city sweep each city gets at most 60s — a response slower
  // than that means the server is wedged and the sweep aborts rather than
  // burning the whole drop window on one city.
  return specialSweepQueue.length ? Math.min(base, 60000) : base;
}

// ---------------------------------------------------------------------------
//  Special-window multi-city sweep
//  When a :MM:58 trigger fires an aligned selection AND multiple cities are
//  configured, all desired cities are tried once each (rotation order, wrapped),
//  with a rapid 2-4s gap instead of the normal retry delay. A >60s schedule
//  response aborts the whole sweep. Booking flow itself is untouched — a city
//  that shows availability runs the normal date/time/submit path, and if every
//  fallback fails the sweep simply continues with the next city.
// ---------------------------------------------------------------------------

const specialSweepQueue: string[] = [];
let specialSweepRunning = false;
let specialSweepTotal = 0;
let specialSweepSingleCity = false;

/** Arm the sweep: every desired city once, starting at rotation's next city.
 *  Single city: queue the same city 3x at ~7s gaps — the loop is serialized so
 *  each attempt only fires after the previous response resolved/timed out. */
function beginSpecialSweep(cities: readonly string[], nextIndex: number): void {
  specialSweepQueue.length = 0;
  if (cities.length === 1) {
    for (let i = 0; i < 3; i++) specialSweepQueue.push(cities[0]);
    specialSweepTotal = specialSweepQueue.length;
    specialSweepRunning = true;
    specialSweepSingleCity = true;
    info(`SPECIAL WINDOW: Single-city sweep armed — ${cities[0]} x3 (~7s gap, 60s response cap per attempt)`);
    client('🎯', `SPECIAL WINDOW: sweeping ${cities[0]} — 3 attempts`);
    return;
  }
  specialSweepSingleCity = false;
  for (let i = 0; i < cities.length; i++) {
    specialSweepQueue.push(cities[(nextIndex + i) % cities.length]);
  }
  specialSweepTotal = specialSweepQueue.length;
  specialSweepRunning = true;
  info(`SPECIAL WINDOW: Multi-city sweep armed — trying ${specialSweepQueue.length} cities in order: ${specialSweepQueue.join(' → ')} (2-4s gap, 60s response cap per city)`);
  client('🎯', `SPECIAL WINDOW: sweeping all ${specialSweepQueue.length} cities`);
}

/** Abort the sweep early (e.g. >60s response) and resume normal cadence. */
function abortSpecialSweep(reason: string): void {
  if (!specialSweepQueue.length) return; // nothing left to abort — last city already in-flight
  specialSweepQueue.length = 0;
  specialSweepRunning = false;
  specialSweepSingleCity = false;
  warn(`SPECIAL WINDOW: Sweep aborted — ${reason}. Resuming normal city retry.`);
  client('⚠️', `SPECIAL WINDOW: sweep stopped (${reason})`);
}

/**
 * Block-page recovery:
 * - rate_limited (CF 1015 / "rate limited"): transient edge throttle — back off
 *   and reload; NO rotation (the IP isn't banned, just warm).
 * - access_limitation: clear browser cache (a poisoned CF cache can pin the
 *   block across IPs — cookies stay so the session survives), rotate NordVPN,
 *   reload, re-solve any Turnstile challenge.
 * - cloudflare_blocked ("You are blocked" / CF 1020): two-stage recovery —
 *   1) wait 30s and navigate to the home page (no rotation — the block often
 *      clears on re-navigation, and a free retry is cheaper than burning an IP).
 *   2) if the home page is still blocked: clear cache, rotate NordVPN once,
 *      navigate to the home page again.
 */
async function recoverFromBlockPage(page: Page, config: any, reason: string | null, where: string) {
  const enteredAt = Date.now();  // another profile may rotate the shared IP mid-recovery — checked before our own rotate
  if (reason === 'rate_limited') {
    warn(`[RATE LIMIT] Transient rate-limit page ${where} — backing off 60s on the same IP (no rotation).`);
    client('⏳', 'Rate-limited — cooling down 60s (keeping IP)...');
    await sleepWithStopSignal(60000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
    await page.waitForTimeout(3000);
    return;
  }

  if (reason === 'cloudflare_blocked') {
    // Stage 1: wait 30s and retry via home page — no cache clear, no rotation.
    info(`[HARD BLOCK] Cloudflare IP block detected ${where} (attempt 1). Waiting 30s, then navigating to home page — no IP rotation yet.`);
    client('🚫', 'IP blocked — waiting 30s, retrying via home page...');
    if (await sleepWithStopSignal(30000)) {
      info('Stop signal detected during block wait; aborting recovery.');
      return;
    }
    await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
    await page.waitForTimeout(3000);

    const stillBlocked = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
    if (!stillBlocked.blocked) {
      info('[HARD BLOCK] Block cleared after home retry — continuing without IP rotation.');
      return;
    }

    // Stage 2: still blocked after home retry — clear cache, rotate once, go home.
    if (!config.autoRotateIp) {
      hardBlockWithoutAutoIp('Cloudflare IP block', `${where} (persisted after home retry)`);
    }
    warn(`[HARD BLOCK] Cloudflare IP block persisted after home retry (${stillBlocked.reason}). Clearing cache and rotating IP once.`);
    client('🔄', 'Still blocked — clearing cache and rotating IP...');
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.clearBrowserCache');
      info('[HARD BLOCK] Browser cache cleared (cookies preserved — session intact).');
    } catch (e) {
      warn('[HARD BLOCK] Cache clear failed (continuing):', e instanceof Error ? e.message : String(e));
    }
    if (ipRotatedSince(enteredAt)) {
      info('[HARD BLOCK] Shared IP already rotated by another process during recovery — reusing it (no rotation).');
    } else {
      await rotateEgress(config, isAborted, false, `Hard block ${where}: Cloudflare IP block (persisted after home retry)`).catch(() => null);
    }
    await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
    await page.waitForTimeout(3000);
    return;
  }

  const reasonLabel = reason === 'access_limitation' ? 'Access limitation' : 'Cloudflare IP block';
  if (!config.autoRotateIp) {
    hardBlockWithoutAutoIp(reasonLabel, where);
  }
  info(`[HARD BLOCK] ${reasonLabel} detected ${where}. Clearing browser cache, rotating NordVPN IP, refreshing page.`);
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    info('[HARD BLOCK] Browser cache cleared (cookies preserved — session intact).');
  } catch (e) {
    warn('[HARD BLOCK] Cache clear failed (continuing):', e instanceof Error ? e.message : String(e));
  }
  if (ipRotatedSince(enteredAt)) {
    info('[HARD BLOCK] Shared IP already rotated by another process during recovery — reusing it (no rotation).');
  } else {
    await rotateEgress(config, isAborted, false, `Hard block ${where}: ${reasonLabel}`).catch(() => null);
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
    info('[HARD BLOCK] Reload failed, navigating to schedule URL directly.');
    await page.goto(config.scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  });
  await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
  await page.waitForTimeout(3000);
}

// Track whether the notification video has been opened for this run.
// The video should open exactly once: when OFC is booked and the script
// transitions to the consular stage.
let notificationVideoOpened = false;

/**
 * Runs the consular stage with continuous monitoring and 403 recovery.
 *
 * After OFC is booked, the script is on /en-US/schedule/ (consular page).
 * This function continuously monitors for consular slot availability:
 *
 * - If consular slots are found → book them → return true
 * - If no slots → wait 10-15s → retry
 * - If HTTP 403 (Cloudflare block) → navigate to home page → clear Cloudflare
 *   → click "Schedule Appointment" → returns to /en-US/schedule/ → retry
 * - Checks for stop signal between attempts
 *
 * This function does NOT return false — it keeps trying until either:
 *   1. Consular is booked (returns true)
 *   2. The stop signal is detected (returns false)
 *   3. A browser-closed error occurs (throws)
 */
// Auto IP off + hard block: these pages never clear on the same IP, so there
// is no automatic recovery path. Stop the profile cleanly — the user can hit
// Rotate IP manually (still allowed) and restart the profile.
function hardBlockWithoutAutoIp(reasonLabel: string, where: string): never {
  warn(`[HARD BLOCK] ${reasonLabel} ${where} — Auto IP is off; not rotating IP.`);
  client('🛑', `IP blocked (${reasonLabel}) — Auto IP off. Stopping profile; rotate IP manually and restart.`);
  process.exit(0);
}

async function runConsularStageWithRecovery(
  page: Page,
  config: any,
  runId: string,
  attempt: number,
  ofcDate?: string
): Promise<boolean> {
  const consularRetryMs = 12000; // 12s base delay between consular monitoring attempts
  const max403Retries = 3;       // max 403 recovery cycles before waiting longer
  let consecutive403 = 0;
  let consular403StartTs = 0;

  for (;;) {
    if (checkStopSignal()) {
      info('Stop signal detected during consular monitoring; exiting consular stage.');
      return false;
    }

    // Static IP: honor the UI Rotate IP flag during consular monitoring too —
    // the consular stage has its own loop that never returns to the OFC loop.
    await consumeStaticRotateFlag(config);

    // Ensure we're on the consular schedule page
    const onConsular = await isConsularSchedulePage(page).catch(() => false);
    if (!onConsular) {
      info('Consular monitoring: not on consular page; running resumeFromCurrentPage...');
      try {
        await resumeFromCurrentPage(page, config);
      } catch (e) {
        warn('Consular monitoring: resumeFromCurrentPage failed:', e);
        await page.waitForTimeout(5000);
        continue;
      }
      const nowConsular = await isConsularSchedulePage(page).catch(() => false);
      if (!nowConsular) {
        info('Consular monitoring: still not on consular page after recovery; waiting 10s...');
        await page.waitForTimeout(10000);
        continue;
      }
    }

    // Try to book consular
    info('Consular monitoring: running runConsularSchedule...');
    client('🏛️', `Checking consular slots for ${config.appointment?.city || 'configured city'}...`);
    let consularOk = false;
    try {
      consularOk = await runConsularSchedule(page, config);
    } catch (e) {
      if (isBrowserClosedError(e)) throw e;
      warn('Consular monitoring: runConsularSchedule threw error:', e);
    }

    if (consularOk) {
      return true;
    }

    // Check if we're getting 403 errors by looking at the page state.
    // After runConsularSchedule fails with 403s, the page may still be on
    // /en-US/schedule/ but the API is blocked. We detect this by checking
    // if the page has a PSE0501 dialog or if the calendar never loaded.
    // The simplest signal: if runConsularSchedule failed and we're still
    // on the consular page with no calendar, it's likely a 403 block.
    const stillOnConsular = await isConsularSchedulePage(page).catch(() => false);
    if (stillOnConsular) {
      // Check for hard block pages (Access limitation / Cloudflare IP block).
      // These require IP rotation + page refresh — they cannot be auto-solved.
      const hardBlock = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
      if (hardBlock.blocked) {
        await recoverFromBlockPage(page, config, hardBlock.reason, 'during consular monitoring');
        continue;
      }

      // Check for Cloudflare verification page (403 redirects to verification)
      const isVerification = await isHumanVerificationPresent(page).catch(() => false);
      if (isVerification) {
        if (consecutive403 === 0) consular403StartTs = Date.now();
        consecutive403++;
        info(`Consular monitoring: Cloudflare verification detected (403 recovery #${consecutive403}).`);
        warn('Consular stage: HTTP 403 block detected. Navigating to home page for recovery.');
        client('🚫', 'HTTP 403 blocked — navigating to home for recovery...');
        // Three-strike: rotate NordVPN IP on 3rd consecutive 403
        if (consecutive403 >= 3) {
          if (config.autoRotateIp) {
            if (ipRotatedSince(consular403StartTs)) {
              // Another profile already rotated the shared IP during this
              // ladder — reuse it instead of rotating again.
              info('[NORDVPN] Consular 403 ×3 — shared IP already rotated by another process; reusing it (no rotation).');
            } else {
              info('[NORDVPN] Consular 403 ×3 — rotating NordVPN IP.');
              await rotateEgress(config, isAborted, false, 'Consular stage: 3 consecutive 403 blocks').catch(() => null);
            }
            // Reload the page to clear stale Cloudflare session after IP rotation.
            client('🔄', 'Refreshing page after IP rotation...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
          } else {
            // Auto IP off — never rotate. Cool down on the same IP; the soft
            // 403 decays on its own while the run stays alive.
            warn('Consular stage: 403 ×3 — Auto IP is off; cooling down 60s on the same IP instead of rotating.');
            client('⏳', '403 ×3 — Auto IP off; cooling down 60s (no rotation)...');
            if (await sleepWithStopSignal(60000)) {
              info('Stop signal detected during consular 403 cooldown; exiting.');
              return false;
            }
          }
          consecutive403 = 0;
        }

        if (consecutive403 > max403Retries) {
          warn(`Consular monitoring: ${consecutive403} consecutive 403 blocks; waiting 60s before retry.`);
          if (await sleepWithStopSignal(60000)) {
            info('Stop signal detected during consular 403 wait; exiting.');
            return false;
          }
          consecutive403 = 0;
          continue;
        }

        // If the post-rotation reload already landed us back on the consular
        // page, skip the home detour — navigating home just to come back is a
        // visible home -> consular ping-pong on every recovery cycle.
        const alreadyOnConsular = await isConsularSchedulePage(page).catch(() => false);
        if (!alreadyOnConsular) {
        try {
          // Navigate to home page via "Visa Application Home" link or direct URL
          const homeLink = page.locator('a[title="Visa Application Home"]');
          if ((await homeLink.count()) > 0) {
            info('Consular 403 recovery: clicking "Visa Application Home" link');
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
              homeLink.first().click()
            ]);
          } else {
            info('Consular 403 recovery: navigating to home URL directly');
            await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          }

          // Wait for Cloudflare to clear (resumeFromCurrentPage handles verification pages)
          await resumeFromCurrentPage(page, config);

          // Now on home page — click "Schedule Appointment"
          // Since OFC is already booked, this navigates to /en-US/schedule/ (consular)
          info('Consular 403 recovery: on home page, clicking Schedule Appointment...');
          await navigateToOfcSchedule(page, config.scheduleUrl).catch(async (e) => {
            // navigateToOfcSchedule throws if URL doesn't include /ofc-schedule/,
            // but after OFC is booked, clicking Schedule Appointment goes to /schedule/
            const currentUrl = page.url();
            const errMsg = e instanceof Error ? e.message : String(e);
            if (currentUrl.includes('/en-US/schedule/')) {
              info(`Consular 403 recovery: navigated to consular page (expected after OFC booked): ${currentUrl}`);
            } else {
              warn('Consular 403 recovery: navigateToOfcSchedule failed:', errMsg);
              // Check if the error was caused by a hard block page
              const hardBlockOnNav = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
              if (hardBlockOnNav.blocked) {
                warn(`Hard block detected during consular 403 recovery: ${hardBlockOnNav.reason}. Clearing cache and rotating IP.`);
                await recoverFromBlockPage(page, config, hardBlockOnNav.reason, 'consular 403 recovery');
              } else if (/timeout|timed out/i.test(errMsg)) {
                // If it's a timeout, wait 2-3 minutes and retry
                warn('Timeout during consular 403 recovery navigation. Waiting 2-3 minutes before retry...');
                const timeoutWaitMs = 120000 + Math.floor(Math.random() * 60000); // 2-3 minutes
                await page.waitForTimeout(timeoutWaitMs);
                // Retry the navigation
                try {
                  await navigateToOfcSchedule(page, config.scheduleUrl);
                } catch (retryErr) {
                  warn('Retry after timeout also failed:', retryErr instanceof Error ? retryErr.message : String(retryErr));
                  const hardBlockOnRetry = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
                  if (hardBlockOnRetry.blocked) {
                    await recoverFromBlockPage(page, config, hardBlockOnRetry.reason, 'consular 403 recovery retry');
                  }
                }
              }
            }
          });

          // Verify we're back on the consular page
          const backOnConsular = await isConsularSchedulePage(page).catch(() => false);
          if (backOnConsular) {
            info('Consular 403 recovery: successfully returned to consular page; retrying...');
            client('✅', 'Recovered — back on consular page');
          } else {
            warn('Consular 403 recovery: not on consular page after recovery; will retry...');
          }
        } catch (e) {
          if (isBrowserClosedError(e)) throw e;
          warn('Consular 403 recovery: error during recovery flow:', e);
        }
        }

        const backoffMs = getBackoffDelayMs('403', consecutive403);
        info(`Consular 403 recovery: waiting ${backoffMs}ms before retry...`);
        await page.waitForTimeout(backoffMs);
        continue;
      }

      // Not a verification page — just no slots available
      consecutive403 = 0;
      const retryMs = consularRetryMs + Math.floor(Math.random() * 3000);
      info(`Consular monitoring: no slots available; waiting ${retryMs}ms before retry...`);
      client('📅', `No consular slots available, retrying in ${(retryMs / 1000).toFixed(0)}s...`);
      await page.waitForTimeout(retryMs);
      continue;
    }

    // Not on consular page — run recovery
    consecutive403 = 0;
    info('Consular monitoring: left consular page; running resumeFromCurrentPage...');
    try {
      await resumeFromCurrentPage(page, config);
    } catch (e) {
      if (isBrowserClosedError(e)) throw e;
      warn('Consular monitoring: resumeFromCurrentPage failed:', e);
      await page.waitForTimeout(10000);
    }
  }
}

async function sendMajorEventAlert(config: any, eventType: string, payload: Record<string, unknown>) {
  if (!config.alertOnMajorEvents) return;
  // Only send login and appointment submission events to Supabase
  const allowed = new Set(['login', 'appointment_submitted', 'consular_submitted']);
  if (!allowed.has(eventType)) return;
  await sendSupabaseEvent(eventType, {
    ...payload,
    timestamp: new Date().toISOString()
  }).catch(() => null);
}

async function parseManualResponse(response: any) {
  const status = response.status();
  const text = await response.text();
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
  return { status, available, scheduleDays, scheduleEntries };
}

// ---------------------------------------------------------------------------
//  Smart month jump: extract earliest date from schedule API response
// ---------------------------------------------------------------------------

function extractEarliestApiDate(
  scheduleResult: { scheduleDays: readonly unknown[]; scheduleEntries: readonly unknown[] } | null | undefined,
  startDate: string,
  endDate: string
): string | null {
  if (!scheduleResult) return null;
  const { scheduleDays, scheduleEntries } = scheduleResult;
  if ((!scheduleDays || scheduleDays.length === 0) && (!scheduleEntries || scheduleEntries.length === 0)) return null;

  const extractDate = (item: unknown): string => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const obj = item as Record<string, unknown>;
    for (const key of ['ScheduleDate', 'Date', 'CalendarDate', 'Day', 'SlotDate']) {
      if (obj[key]) return String(obj[key]);
    }
    return '';
  };

  const normalizeToYMD = (raw: string): string | null => {
    const isoMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return isoMatch[0];
    const usMatch = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      return `${usMatch[3]}-${usMatch[1].padStart(2, '0')}-${usMatch[2].padStart(2, '0')}`;
    }
    return null;
  };

  const allRaw = [
    ...(scheduleDays || []).map(extractDate),
    ...(scheduleEntries || []).map(extractDate)
  ];

  const validDates = allRaw
    .map(normalizeToYMD)
    .filter((d): d is string => d !== null && d >= startDate && d <= endDate)
    .sort();

  return validDates.length > 0 ? validDates[0] : null;
}

// ---------------------------------------------------------------------------
//  Special window helpers
// ---------------------------------------------------------------------------

// Minutes when new slots typically open on usvisascheduling.com.
// Slot-drop trigger times — second :58 of each listed minute, every hour.
// NOTE: these are LOCAL SYSTEM-CLOCK times — the city selection fires when
// the machine's clock hits HH:MM:58, regardless of timezone or server time.
// Stored as seconds-of-hour: 12:58 → 778, 25:58 → 1558, 29:58 → 1798,
// 36:58 → 2218, 49:58 → 2998, 55:58 → 3358, 59:58 → 3598.
const SPECIAL_WINDOW_TRIGGERS_SEC = [12, 25, 29, 36, 49, 55, 59].map((m) => m * 60 + 58);

/** Format a seconds-of-hour trigger as "MM:SS" for logs. */
function formatTriggerMMSS(sec: number): string {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function msUntilNextSpecialWindow(): { delayMs: number; triggerSec: number } {
  const nowMs = Date.now();
  let minMs = Infinity;
  let nearestTrigger = -1;
  for (const t of SPECIAL_WINDOW_TRIGGERS_SEC) {
    const target = new Date(nowMs);
    target.setMinutes(0, 0, 0);         // top of the hour (system clock)
    target.setMilliseconds(t * 1000);   // + trigger offset → :MM:58
    if (target.getTime() <= nowMs) {
      target.setHours(target.getHours() + 1);
    }
    const diff = target.getTime() - nowMs;
    if (diff < minMs) {
      minMs = diff;
      nearestTrigger = t;
    }
  }
  return { delayMs: minMs, triggerSec: nearestTrigger };
}

/**
 * Compute the retry delay before the next city selection.
 *
 * Special window behavior:
 * - While a multi-city sweep is running, retries use a rapid 2-4s gap —
 *   the trigger already fired, so alignment is meaningless mid-sweep.
 * - If the next special-window trigger lands inside the normal delay,
 *   shorten the delay so the selection fires exactly at :MM:58 (the
 *   trigger is an early extra selection, not a pause in the cadence —
 *   triggers that expire mid-work are simply missed).
 * - Otherwise use the normal baseSeconds + jitter delay — including inside
 *   special windows. (The old in-window 2s fast refresh was removed: it
 *   hammered the API at ~0.5 req/s and triggered 403 rate limits.)
 */
function computeRetryDelay(
  baseSeconds: number,
  alignToTrigger = true
): { delayMs: number; specialTrigger: number; awaitingWindow: boolean } {
  const baseMs = Math.max(1, baseSeconds) * 1000;
  const jitterMs = Math.floor(Math.random() * 2000);
  const normalDelay = baseMs + jitterMs;

  if (specialSweepQueue.length) {
    const sweepGap = specialSweepSingleCity
      ? 7000 + Math.floor(Math.random() * 2000)
      : 2000 + Math.floor(Math.random() * 2000);
    return { delayMs: sweepGap, specialTrigger: -1, awaitingWindow: false };
  }

  const { delayMs: msUntilSpecial, triggerSec } = msUntilNextSpecialWindow();

  // If the next trigger lands inside this delay, wake exactly at :MM:58 and
  // fire the selection there instead of letting it drift past the drop.
  if (alignToTrigger && msUntilSpecial <= normalDelay) {
    return { delayMs: msUntilSpecial, specialTrigger: triggerSec, awaitingWindow: true };
  }

  return { delayMs: normalDelay, specialTrigger: -1, awaitingWindow: false };
}

/**
 * Precisely sleep until the given special-window trigger (:MM:58) on the
 * LOCAL SYSTEM clock — the city selection fires when the machine's clock
 * hits HH:MM:58.
 *
 * We compute the next system-clock trigger instant (top of hour + trigger
 * offset), then sleep with coarse 500ms chunks followed by 1ms ticks so
 * wake-up lands on :MM:58 within a few ms.
 */
async function preciseSleepUntilSpecialWindow(triggerSec: number): Promise<void> {
  const target = new Date();
  target.setMinutes(0, 0, 0);               // top of the hour (system clock)
  target.setMilliseconds(triggerSec * 1000); // + trigger offset → :MM:58
  if (target.getTime() <= Date.now()) {
    target.setHours(target.getHours() + 1);
  }
  const targetMs = target.getTime();
  // Coarse sleep in <=500ms chunks until ~1s before the target
  const coarseUntil = targetMs - 1000;
  let nowMs = Date.now();
  while (nowMs < coarseUntil) {
    // Check stop signal during long waits (e.g. waiting for special window)
    try {
      if (fs.existsSync(STOP_SIGNAL_FILE)) {
        fs.unlinkSync(STOP_SIGNAL_FILE);
        info('Stop signal detected during special-window wait; aborting.');
        return;
      }
    } catch { /* ignore */ }
    const chunk = Math.min(500, coarseUntil - nowMs);
    await new Promise(r => setTimeout(r, chunk));
    nowMs = Date.now();
  }
  // Fine-grained wait for the final second: 1ms ticks for ~1-4ms precision
  while (Date.now() < targetMs) {
    await new Promise(r => setTimeout(r, 1));
  }
}

function isBrowserClosedError(err: unknown): boolean {
  const msg = String(err);
  return /target.*(closed|crashed)|browser has been closed|context has been closed|session closed|connection refused/i.test(msg);
}

async function reconnectBrowser(_config: any): Promise<never> {
  warn('[BROWSER_CLOSED] Browser was closed or crashed.');
  info('[BROWSER_CLOSED] Script stopped. Relaunch Chrome and click "Start" to resume.');
  process.exit(0);
}

const STOP_SIGNAL_FILE = path.resolve(process.cwd(), '.ivac-stop-' + (process.env.IVAC_PROFILE_ID || 'default'));

function checkStopSignal(): boolean {
  try {
    if (fs.existsSync(STOP_SIGNAL_FILE)) {
      fs.unlinkSync(STOP_SIGNAL_FILE);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

function clearStopSignal(): void {
  try { fs.unlinkSync(STOP_SIGNAL_FILE); } catch { /* ignore */ }
}

/**
 * Sleep for `ms` milliseconds, checking the stop signal every 1s.
 * Returns true if stop signal was detected (aborted), false if completed normally.
 * Uses setTimeout (not page.waitForTimeout) so it works even if the browser is closed.
 * Does NOT slow down the booking loop — only used in error recovery / block handling paths.
 */
async function sleepWithStopSignal(ms: number): Promise<boolean> {
  const chunkMs = 1000;
  let remaining = ms;
  while (remaining > 0) {
    if (checkStopSignal()) return true;
    const wait = Math.min(chunkMs, remaining);
    await new Promise((r) => setTimeout(r, wait));
    remaining -= wait;
  }
  return false;
}

/** Abort callback for passing to NordVPN / Cloudflare functions. */
const isAborted = (): boolean => checkStopSignal();

/**
 * Jittered 5-10s pause before a home→schedule recovery navigation. Rapid
 * home↔schedule ping-pong is itself a Cloudflare attention trigger — the
 * pause keeps the refresh cadence slow while errors persist.
 * Returns true when the stop signal fired during the pause.
 */
async function pauseBeforeHomeRecovery(tag: string): Promise<boolean> {
  const ms = 5000 + Math.floor(Math.random() * 5000);
  info(`${tag}: waiting ${(ms / 1000).toFixed(1)}s before home recovery (rate-limit avoidance).`);
  return sleepWithStopSignal(ms);
}

/**
 * Pre-flight check for the OFC schedule page's group-member context.
 *
 * The page fires query-family-members-ofc on load; when that call fails
 * (Cloudflare 403) or returns no members, the "Group Members" region shows
 * "No Class Selected" and every downstream get-family-ofc-schedule-days
 * request goes out with applications:[] and fails with SGA14. Detecting the
 * missing members up front lets us skip the guaranteed-doomed request.
 *
 * Returns true ONLY for the confirmed broken signature (region rendered +
 * "No Class Selected" text + zero member checkboxes after a short grace
 * wait). Any inconclusive state returns false and the normal flow decides.
 */
async function probeGroupMembersMissing(page: Page): Promise<boolean> {
  try {
    // Member list renders async after page load — give it a short window.
    await page.waitForSelector('#gm_select li input[type="checkbox"]', { state: 'attached', timeout: 4000 }).catch(() => null);
    return await page.evaluate(() => {
      const boxes = document.querySelectorAll('#gm_select li input[type="checkbox"]');
      if (boxes.length > 0) return false;
      const text = document.body ? document.body.innerText : '';
      return /No Class Selected/i.test(text);
    });
  } catch {
    return false; // inconclusive — let the normal flow decide
  }
}

// ---------------------------------------------------------------------------
//  Special Window run gate
// ---------------------------------------------------------------------------
// When enabled, the main loop runs ONLY inside fixed system-clock windows
// (:20–:30 and :50–:00 each hour) and freezes — zero page/API activity —
// between them. Live state comes from a flag file written by the UI
// (.ivac-special-window, "on"/"off"); when the file is absent the saved
// config value (settings.specialWindowOnly) decides.
const SPECIAL_WINDOW_FLAG_FILE = path.resolve(process.cwd(), '.ivac-special-window');
const RUN_WINDOW_STARTS_MIN = [20, 50];
const RUN_WINDOW_LEN_MIN = 10;

function specialWindowEnabled(config: AutomationConfig): boolean {
  try {
    if (fs.existsSync(SPECIAL_WINDOW_FLAG_FILE)) {
      const v = fs.readFileSync(SPECIAL_WINDOW_FLAG_FILE, 'utf8').trim().toLowerCase();
      return v !== 'off';
    }
  } catch { /* fall through to config default */ }
  return !!config.specialWindowOnly;
}

function inRunWindow(nowMs: number): boolean {
  const m = new Date(nowMs).getMinutes();
  return RUN_WINDOW_STARTS_MIN.some((s) => m >= s && m < s + RUN_WINDOW_LEN_MIN);
}

function nextRunWindowStartMs(nowMs: number): number {
  let best = Infinity;
  for (const s of RUN_WINDOW_STARTS_MIN) {
    const t = new Date(nowMs);
    t.setMinutes(s, 0, 0);
    if (t.getTime() <= nowMs) t.setHours(t.getHours() + 1);
    best = Math.min(best, t.getTime());
  }
  return best;
}

/**
 * Freeze the loop while outside a run window. Sleeps in 1s ticks so the stop
 * signal and a live flag-off both take effect promptly. Returns true when
 * the stop signal fired (caller exits the loop).
 */
async function waitForRunWindowIfNeeded(config: AutomationConfig): Promise<boolean> {
  if (inRunWindow(Date.now())) return false;
  const nextStart = new Date(nextRunWindowStartMs(Date.now()));
  const label = `:${String(nextStart.getMinutes()).padStart(2, '0')} system`;
  client('⏸️', `Special Window: pausing until ${label}`);
  uiStatus(`Paused — waiting for ${label} window`);
  warn(`[SPECIAL WINDOW] Outside run window — freezing loop until ${label}.`);
  while (!inRunWindow(Date.now())) {
    if (checkStopSignal()) return true;
    if (!specialWindowEnabled(config)) {
      info('[SPECIAL WINDOW] Flag turned off mid-pause — resuming normal cycle.');
      client('▶️', 'Special Window off — resuming');
      return false;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  info('[SPECIAL WINDOW] Run window opened — resuming loop.');
  client('▶️', 'Special Window: resuming');
  uiStatus('Running — special window');
  return false;
}

// ---------------------------------------------------------------------------
//  Static IP mode — per-profile proxy relay (see src/static-proxy.ts)
// ---------------------------------------------------------------------------
// Chrome launches once with --proxy-server=http://127.0.0.1:<relayPort>; the
// relay tunnels to the current upstream. Rotation swaps the upstream pointer —
// no Chrome restart. Trigger sites call rotateEgress(), which dispatches to
// the relay in 'static' mode and NordVPN in 'auto' mode.
let staticRelay: StaticProxyRelay | null = null;
let lastRotateFlagMs = 0;

function rotateFlagMtime(): number {
  try {
    return fs.statSync(STATIC_ROTATE_FLAG).mtimeMs;
  } catch {
    return 0;
  }
}

/** Consume the UI's Rotate IP request flag — each static core advances once per new mtime. */
async function consumeStaticRotateFlag(config: AutomationConfig): Promise<void> {
  if (config.ipMode !== 'static' || !staticRelay) return;
  const m = rotateFlagMtime();
  if (m > lastRotateFlagMs) {
    lastRotateFlagMs = m;
    info('[STATIC IP] Manual Rotate IP — advancing proxy round-robin');
    await staticRelay.rotate('manual Rotate IP button');
  }
}

/** Unified rotation entry — 'static' swaps the relay upstream; 'auto' runs NordVPN. */
async function rotateEgress(
  config: AutomationConfig,
  aborted: () => boolean,
  force: boolean,
  reason?: string
): Promise<unknown> {
  if (config.ipMode === 'static') {
    if (!staticRelay) {
      warn('[STATIC IP] rotation requested but relay is not running');
      return null;
    }
    return staticRelay.rotate(reason || 'rotation trigger');
  }
  return rotateNordVpn(config.nordvpn, aborted, force, reason).catch(() => null);
}

/** Last-resort Chrome kill: find the PID listening on the debug port via netstat. */
async function killProcessOnPort(port: number): Promise<boolean> {
  try {
    const out = await new Promise<string>((resolve) => {
      execCmd('netstat -ano -p tcp', { windowsHide: true, timeout: 15000 }, (_e, stdout) => resolve(stdout || ''));
    });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && parseInt(m[1], 10) === port) {
        info(`[STATIC IP] Force-killing PID ${m[2]} listening on debug port ${port}`);
        await new Promise((r) => execCmd(`taskkill /pid ${m[2]} /F`, { windowsHide: true }, () => r(null)));
        return true;
      }
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/**
 * Static-mode Chrome bring-up. If a Chrome is already on the debug port but was
 * NOT launched through this relay (no marker / different port), close it and
 * respawn with --proxy-server. A matching marker means the existing Chrome
 * already tunnels through our just-bound relay — safe to reuse.
 */
async function ensureStaticModeChrome(
  config: AutomationConfig,
  proxyUrl: string,
  relayPort: number,
  proxyLabel: string
): Promise<void> {
  const port = config.chromeRemoteDebugPort;
  if (await waitForPortOpen(port, 1500)) {
    const marker = readRelayMarker(config);
    if (marker && marker.relayPort === relayPort) {
      info(`[STATIC IP] Reusing existing Chrome — already bound to relay 127.0.0.1:${relayPort}`);
      return;
    }
    warn('[STATIC IP] Chrome running without the proxy relay — relaunching through the proxy...');
    const conn = await connectToBrowser(config).catch(() => null);
    let closed = false;
    if (conn) {
      try {
        await conn.browser.close();
        closed = true;
      } catch {
        closed = false;
      }
    }
    if (!closed) {
      warn('[STATIC IP] CDP close failed — force-killing Chrome via debug port');
      await killProcessOnPort(port);
    }
    await waitForPortClosed(port, 15000);
  }
  const spawned = await ensureChromeRunning(config, proxyUrl);
  if (spawned) writeRelayMarker(config, relayPort, proxyLabel);
}

/**
 * On graceful stop, respawn the profile's Chrome WITHOUT the proxy — the relay
 * dies with this process, and a Chrome left pointing at it goes offline.
 * (taskkill /F path can't be intercepted; this covers the flag-file stop.)
 */
async function relaunchChromeDirect(config: AutomationConfig): Promise<void> {
  info('[STATIC IP] Stop: relaunching Chrome direct (no proxy) so the tab stays usable...');
  const port = config.chromeRemoteDebugPort;
  const conn = await connectToBrowser(config).catch(() => null);
  let closed = false;
  if (conn) {
    try {
      await conn.browser.close();
      closed = true;
    } catch {
      closed = false;
    }
  }
  if (!closed) await killProcessOnPort(port);
  await waitForPortClosed(port, 15000);
  await ensureChromeRunning(config);
  clearRelayMarker(config);
}

/** Graceful stop entry point — static mode re-launches Chrome direct first. */
async function gracefulExit(config: AutomationConfig): Promise<never> {
  if (config.ipMode === 'static') {
    await relaunchChromeDirect(config).catch((e) =>
      warn('[STATIC IP] direct relaunch on stop failed:', e instanceof Error ? e.message : String(e))
    );
  }
  client('🛑', 'Script stopped');
  process.exit(0);
}

async function isSecurityQuestionPage(page: any) {
  return (
    (await pageHasSelector(page, 'p.textInParagraph[id^="kbq"]')) &&
    (await pageHasSelector(page, 'input[type="password"]'))
  );
}

function urlIsOfcSchedule(url: string): boolean {
  return /\/en-US\/ofc-schedule(\/|$|\?)/i.test(url);
}

function urlIsConsularSchedule(url: string): boolean {
  // Consular is /en-US/schedule but NOT /en-US/ofc-schedule
  return /\/en-US\/schedule(\/|$|\?)/i.test(url) && !urlIsOfcSchedule(url);
}

async function isHomePage(page: any) {
  const url = page.url();
  return (
    url.includes('/en-US/') &&
    !urlIsOfcSchedule(url) &&
    !urlIsConsularSchedule(url) &&
    !url.includes('/Account/Login/TermsAndConditions') &&
    (await pageHasSelector(page, '#continue_application, #reschedule_appointment'))
  );
}

// "Privacy Act Statement" — intermediate post-login consent page at
// /en-US/Account/Login/TermsAndConditions with two checkboxes and a
// disabled-until-checked Continue submit (#submit-agreement).
async function isPrivacyActPage(page: any) {
  const url = page.url();
  if (/\/Account\/Login\/TermsAndConditions/i.test(url)) return true;
  return pageHasSelector(page, '#privacy-act-visual');
}

async function isOfcSchedulePage(page: any) {
  return (
    urlIsOfcSchedule(page.url()) &&
    (await pageHasSelector(page, '#post_select'))
  );
}

async function isConsularSchedulePage(page: any) {
  return (
    urlIsConsularSchedule(page.url()) &&
    (await pageHasSelector(page, '#post_select'))
  );
}

// Back-compat: existing callers of isSchedulePage mean "on the OFC scheduling page".
// Keep the alias so we don't have to touch every call site.
async function isSchedulePage(page: any) {
  return isOfcSchedulePage(page);
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
    // Run all state checks in parallel — each is an independent read-only DOM
    // query; sequential awaits cost ~150-300ms per loop iteration.
    const [internal, schedule, consular, onLoginPage, privacyAct, security, home, verification, relevant] =
      await Promise.all([
        isInternalPage(page),
        isOfcSchedulePage(page),
        isConsularSchedulePage(page),
        isLoginPage(page),
        isPrivacyActPage(page),
        isSecurityQuestionPage(page),
        isHomePage(page),
        isVerificationPage(page),
        isRelevantSite(page)
      ]);
    const state = { internal, schedule, consular, login: onLoginPage, privacyAct, security, home, verification, relevant };

    info(`Resume check [${attempt}/${maxAttempts}]: URL =`, currentUrl, 'title =', currentTitle, 'state =', state);

    // Check for hard block pages (Cloudflare IP block / Access limitation).
    // These can appear after an API call gets blocked and the page redirects.
    // Rotate IP and refresh to recover — cannot be auto-solved.
    const hardBlock = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
    if (hardBlock.blocked) {
      await recoverFromBlockPage(page, config, hardBlock.reason, 'during resumeFromCurrentPage');
      continue;
    }

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
      info('Resuming from existing OFC schedule page.');
      return;
    }

    if (state.consular) {
      info('Resuming from existing Consular schedule page (/en-US/schedule/).');
      return;
    }

    if (state.verification) {
      info('Cloudflare or bot verification page detected. Waiting for completion.');
      client('🌐', 'Cloudflare challenge detected — auto-solving...');
      await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted);
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

    if (state.privacyAct) {
      info('Resuming from Privacy Act Statement page.');
      await handlePrivacyActStatement(page);
      continue;
    }

    if (state.security) {
      info('Resuming from security questions page.');
      await answerSecurityQuestions(page, config.securityQuestions);
      continue;
    }

    if (state.home) {
      info('Resuming from home page. Clicking Schedule Appointment.');
      try {
        await navigateToOfcSchedule(page, config.scheduleUrl);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        warn('Error during navigateToOfcSchedule in resumeFromCurrentPage:', errMsg);
        // Check if the error was caused by a hard block page
        const hardBlockOnNav = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
        if (hardBlockOnNav.blocked) {
          await recoverFromBlockPage(page, config, hardBlockOnNav.reason, 'during resumeFromCurrentPage home navigation');
          continue;
        }
        // If it's a timeout error, wait 2-3 minutes and retry
        if (/timeout|timed out/i.test(errMsg)) {
          warn('Timeout during resumeFromCurrentPage navigation. Waiting 2-3 minutes before retry...');
          const timeoutWaitMs = 120000 + Math.floor(Math.random() * 60000); // 2-3 minutes
          await page.waitForTimeout(timeoutWaitMs);
          // Retry the navigation
          try {
            await navigateToOfcSchedule(page, config.scheduleUrl);
          } catch (retryErr) {
            warn('Retry after timeout also failed:', retryErr instanceof Error ? retryErr.message : String(retryErr));
            const hardBlockOnRetry = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
            if (hardBlockOnRetry.blocked) {
              await recoverFromBlockPage(page, config, hardBlockOnRetry.reason, 'resumeFromCurrentPage retry');
              continue;
            }
            throw retryErr;
          }
        }
        // If not a hard block or timeout, throw the error to be caught by the outer try-catch
        throw e;
      }
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
  clearStopSignal();
  notificationVideoOpened = false; // reset for this run

  // ---- License validation (second layer: core script) ----
  const licenseKey = readStoredLicenseKey();
  if (!licenseKey) {
    error('No license key found. Please activate a license in the launcher UI.');
    process.exit(1);
  }
  info('Validating license...');
  const licenseResult = await validateLicense(licenseKey);
  if (!licenseResult.valid) {
    error('License validation failed:', licenseResult.message);
    if (licenseResult.status === 'terminated') {
      error('License has been terminated. The application will exit.');
    }
    process.exit(1);
  }
  info('License valid for:', licenseResult.record?.client_name || 'unknown');

  const config = loadConfig();
  if (config.preferLeastSlots) {
    info('Slot selection mode: LEAST available slots first (preferLeastSlots enabled)');
  }
  if (config.specialWindowOnly) {
    info('Special Window mode ON: loop runs only inside :20–:30 / :50–:00 system-clock windows (.ivac-special-window flag can toggle live).');
  }
  if (!config.autoRotateIp) {
    info('Auto IP disabled — IP never rotates automatically; soft 403/429 cool down 60s, hard blocks stop the profile');
  }
  const runId = buildRunId();
  const previousCheckpoint = loadCheckpoint();
  const resumableCheckpointStates = new Set(['city_selection', 'date_selected', 'time_selected', 'checkpoint_resume']);
  if (previousCheckpoint) {
    info('Loaded previous checkpoint', previousCheckpoint);
  }

  // Static IP mode: start the local relay + claim/verify an upstream BEFORE
  // Chrome, so the browser launches already pointing through the proxy.
  let chromeProxyUrl: string | undefined;
  if (config.ipMode === 'static') {
    const started = await startStaticProxy(config); // throws on missing/dead proxies.txt
    staticRelay = started.relay;
    chromeProxyUrl = started.proxyUrl;
    lastRotateFlagMs = rotateFlagMtime(); // don't react to a flag older than this run
    await ensureStaticModeChrome(config, started.proxyUrl, started.relayPort, started.proxyLabel);
  }

  // Ensure Chrome is running and exposing the CDP port; attempt to start it if not.
  await ensureChromeRunning(config, chromeProxyUrl).catch(() => null);
  const browserLaunch = await connectToBrowser(config, chromeProxyUrl);
  let isExistingBrowser = browserLaunch?.existing === true;
  let { browser, context, page } =
    browserLaunch ?? await launchBrowser(config, chromeProxyUrl);

  monitorNetwork(page, config.debugNetwork);
  setupApiResponseCapture(page);

  // Dismiss browser alert dialogs automatically.
  // The usvisascheduling.com page shows alert() dialogs on Cloudflare 403/429 errors:
  //   "Unable to book the appointment at this time. Please contact support with error code PSE0504..."
  //   "Unable to load appointment available days at this time. Please contact support with error code PSE0501..."
  // These dialogs block the page completely. Auto-dismiss them so the flow can continue.
  page.on('dialog', async (dialog) => {
    info(`[DIALOG] Auto-dismissing ${dialog.type()} dialog: "${dialog.message().substring(0, 200)}"`);
    try {
      await dialog.dismiss();
    } catch {
      // Dialog may have already been closed by the page
    }
  });

  const checkpointCanResumeInPlace = !!previousCheckpoint && resumableCheckpointStates.has(previousCheckpoint.state);
  const currentPageIsInternal = await isInternalPage(page).catch(() => false);
  const resumeWithoutNavigation = isExistingBrowser && checkpointCanResumeInPlace && !currentPageIsInternal;
  try {
    await resumeFromCurrentPage(page, config, { allowNavigation: !resumeWithoutNavigation });
  } catch (initErr) {
    if (isBrowserClosedError(initErr)) {
      warn('Browser closed during initial resume. Reconnecting...');
      ({ browser, context, page } = await reconnectBrowser(config));
      isExistingBrowser = false;
      await resumeFromCurrentPage(page, config).catch(() => null);
    } else {
      warn('Initial resume failed:', initErr);
    }
  }

  const appointmentCities = Array.isArray(config.appointment.city)
    ? config.appointment.city
    : [config.appointment.city];
  let cityIndex = 0;
  let consecutiveBlockCount = 0;  // combined 403/429 counter for two-strike city-then-rotate logic
  let blockLadderStartTs = 0;     // when the current strike ladder began — for detecting another profile's rotation
  let appErrorLadderStartTs = 0;
  let blockCycleCount = 0;        // how many full strike ladders fired without a clean response — guards against rotating forever on account-scoped blocks
  let consecutiveAppErrorCount = 0; // app-level errors (HTTP 200 + HasError, e.g. SGA14) — separate ladder, never resets the block counter

  let attempt = previousCheckpoint?.attempt ?? 0;
  let booked = false;
  let checkpointFastResumePending = checkpointCanResumeInPlace;
  // Attempt-scoped with a 3-strike ceiling: a single congested-window 403
  // (observed during slot drops) must not kill the fast path for the whole
  // session. Three CONSECUTIVE blocks → session block; any non-blocked
  // outcome (success/no_slots/all_exhausted) resets the strike count.
  let directApiBlocked = false;
  let directApiBlockStrikes = 0;

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
    // Check for graceful stop signal (from UI Stop button)
    if (checkStopSignal()) {
      info('[STOPPED] Stop signal received. Script stopping (Chrome will stay open).');
      await gracefulExit(config);
    }

    // Static IP: UI Rotate IP button → advance this profile's proxy round-robin.
    await consumeStaticRotateFlag(config);

    // Special Window gate — evaluated once per loop iteration, so an
    // in-flight booking always finishes before the pause takes effect
    // ("finish, then pause").
    if (specialWindowEnabled(config) && (await waitForRunWindowIfNeeded(config))) {
      info('[STOPPED] Stop signal received during Special Window pause. Script stopping.');
      await gracefulExit(config);
    }

    attempt += 1;
    info(`Appointment attempt ${attempt}`);

    // Health check: verify page is still alive and on one of the schedule pages (OFC or Consular).
    // If browser closed, reconnect. If Cloudflare/session expired, recover.
    try {
      const urlNow = page.url();
      const onOfc = await isOfcSchedulePage(page).catch(() => false);
      const onConsular = !onOfc && (await isConsularSchedulePage(page).catch(() => false));
      info(`Page-type check: url=${urlNow} onOfc=${onOfc} onConsular=${onConsular}`);

      // Check for hard block pages (Access limitation / Cloudflare IP block).
      // These require IP rotation + page refresh to recover — they cannot be
      // auto-solved like a Turnstile challenge.
      const hardBlock = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
      if (hardBlock.blocked) {
        await recoverFromBlockPage(page, config, hardBlock.reason, 'on page');
        continue;
      }

      if (onConsular) {
        // We landed directly on the consular page (e.g. resumed after OFC was already submitted,
        // or user manually navigated). Run the consular flow with continuous monitoring and 403 recovery.
        info('Detected Consular schedule page at start of attempt; running consular stage with recovery.');
        // Open notification video if not already opened (e.g. resuming from checkpoint
        // after OFC was booked in a previous session).
        if (!notificationVideoOpened) {
          info('Resuming on consular page — opening notification video (OFC was booked in prior session)...');
          openNotificationVideo(page);
          notificationVideoOpened = true;
        }
        const consularOk = await runConsularStageWithRecovery(page, config, runId, attempt);
        if (consularOk) {
          booked = true;
          saveCheckpoint({
            runId,
            state: 'booked',
            attempt,
            city: appointmentCities[cityIndex],
            url: page.url(),
            timestamp: new Date().toISOString()
          });
          sendMajorEventAlert(config, 'appointment_submitted', {
            runId,
            attempt,
            city: appointmentCities[cityIndex],
            url: page.url(),
            stage: 'consular_only'
          });
          info('Consular-only booking succeeded! Full appointment booked.');
          client('✅', 'CONSULAR BOOKED! Full appointment complete!');
          sendSupabaseEvent('consular_submitted', {
            username: config.username,
            runId,
            attempt,
            city: appointmentCities[cityIndex],
            url: page.url(),
            stage: 'consular_only',
            timestamp: new Date().toISOString()
          }).catch(() => null);
        } else {
          warn('Consular stage did not complete (stop signal or browser closed).');
        }
        break;
      } else if (!onOfc) {
        info('Not on any schedule page at start of attempt. Detecting state and recovering...');
        await resumeFromCurrentPage(page, config);
        const nowOfc = await isOfcSchedulePage(page).catch(() => false);
        const nowConsular = !nowOfc && (await isConsularSchedulePage(page).catch(() => false));
        if (!nowOfc && !nowConsular) {
          warn('Recovery did not reach any schedule page. Retrying after delay...');
          await page.waitForTimeout(5000);
          continue;
        }
        if (nowConsular) {
          info('After recovery we are on Consular page; will handle it on next attempt.');
          continue;
        }
      }
    } catch (healthErr) {
      if (isBrowserClosedError(healthErr)) {
        warn('Browser/page closed. Reconnecting to Chrome...');
        try {
          ({ browser, context, page } = await reconnectBrowser(config));
          await resumeFromCurrentPage(page, config).catch(() => null);
        } catch (reconnErr) {
          warn('Reconnect failed, will retry:', reconnErr);
          await new Promise(r => setTimeout(r, 10000));
        }
      } else {
        warn('Health check failed:', healthErr);
        try {
          await resumeFromCurrentPage(page, config);
        } catch {
          await new Promise(r => setTimeout(r, 10000));
        }
      }
      continue;
    }

    try { // <-- main loop try/catch: any uncaught error triggers recovery

    // Sweep finished naturally (queue drained) — resume normal cadence.
    if (specialSweepRunning && specialSweepQueue.length === 0) {
      specialSweepRunning = false;
      specialSweepSingleCity = false;
      info('SPECIAL WINDOW: Sweep complete — all cities tried, resuming normal city retry.');
      client('✅', 'SPECIAL WINDOW: sweep done — normal retry resumes');
    }

    // During a sweep the city comes from the armed queue (every desired city
    // once, rotation order wrapped). Normal rotation is untouched — cityIndex
    // still points at the same next city when the sweep ends.
    let currentCity = appointmentCities[cityIndex];
    if (specialSweepQueue.length) {
      const pos = specialSweepTotal - specialSweepQueue.length + 1;
      currentCity = specialSweepQueue.shift()!;
      info(`SPECIAL WINDOW: Sweep ${specialSweepSingleCity ? 'attempt' : 'city'} ${pos}/${specialSweepTotal}: ${currentCity}`);
    }
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

      // 'city_selection' checkpoints always reselect. date_selected/time_selected
      // checkpoints may skip the reselect ONLY when they're fresh — the calendar
      // DOM's bound scheduleDayIds die with the schedule-days response behind
      // them. A hours-old checkpoint leaves green cells that fire entries calls
      // with scheduleDayId:null and return empty slots for every date.
      const checkpointAgeMs = Date.now() - Date.parse(previousCheckpoint.timestamp || '');
      const forceReselectFromCheckpoint =
        previousCheckpoint.state === 'city_selection' ||
        !Number.isFinite(checkpointAgeMs) ||
        checkpointAgeMs > 120000; // >2min old → stale calendar, reselect
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
        const postId = await findCityPostId(page, currentCity);
        const scheduleResponsePromise = waitForScheduleResponse(page, scheduleWaitMs(), postId || undefined);
        resetCapturedScheduleData();
        await selectCity(page, currentCity, true, config);
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
      // Pre-flight: when the page's group-member query failed upstream, the
      // page shows "No Class Selected" and every schedule-days call returns
      // SGA14. Skip the guaranteed-doomed requests entirely — the app-error
      // branch below will run home recovery.
      const memberMissing = await probeGroupMembersMissing(page);
      if (memberMissing) {
        warn('[PRE-FLIGHT] Schedule page shows "No Class Selected" — group members not loaded; skipping city select (schedule-days would return SGA14).');
        scheduleResult = {
          response: null,
          status: 200,
          available: false,
          scheduleDays: [],
          scheduleEntries: [],
          payload: { HasError: true },
          parseError: false,
          appErrorCode: 'NO_GROUP_MEMBERS'
        } as unknown as Awaited<ReturnType<typeof waitForScheduleResponse>>;
      }
      const postId = memberMissing ? null : await findCityPostId(page, currentCity);
      const scheduleResponsePromise = memberMissing ? null : waitForScheduleResponse(page, scheduleWaitMs(), postId || undefined);
      // Start listening for any schedule responses (manual user selection)
      const manualResponsePromise = memberMissing ? null : page.waitForResponse(
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

      resetCapturedScheduleData();
      if (!memberMissing) {
        await selectCity(page, currentCity, true, config);
        scheduleResult = await scheduleResponsePromise;
        noSlots = await detectNoSlots(page);
      }

      // Check if a manual city selection happened (response came before our intentional select)
      const manualResponse = manualResponsePromise ? await manualResponsePromise : null;
      if (manualResponse) {
        try {
          let isOwnRequest = false;
          if (scheduleResult?.response) {
            try {
              const sameUrl = String(scheduleResult.response.url() || '').toLowerCase() === String(manualResponse.url() || '').toLowerCase();
              const sameStatus = Number(scheduleResult.status) === Number(manualResponse.status());
              isOwnRequest = sameUrl && sameStatus;
            } catch {
              // comparison failed; treat as manual
            }
          }

          if (isOwnRequest) {
            info('Detected schedule response but it matches our own request; ignoring as manual selection.');
          } else {
            const parsed = await parseManualResponse(manualResponse);
            info('[MANUAL SELECTION] Schedule API response received', {
              status: parsed.status,
              available: parsed.available,
              scheduleDays: parsed.scheduleDays.length,
              scheduleEntries: parsed.scheduleEntries.length,
              scheduleDaySamples: parsed.scheduleDays.slice(0, 50),
              scheduleEntrySamples: parsed.scheduleEntries.slice(0, 50)
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

    // A blocked member query (403/429 on query-family-members-ofc) is a
    // transport block exactly like a days-call block — it must feed the same
    // strike counter, or the rotation ladder below never engages when only
    // the member endpoint is being filtered.
    const memberRes = getMemberQueryResult();
    const memberBlocked = !!memberRes.status &&
      (memberRes.status === 403 || memberRes.status === 429) &&
      (Date.now() - memberRes.at) < 120000;
    const hasUsableResult = !!(scheduleResult && scheduleResult.available);
    const daysBlockStatus = (scheduleResult && (scheduleResult.status === 403 || scheduleResult.status === 429))
      ? scheduleResult.status : null;
    const effectiveBlockStatus = daysBlockStatus ??
      (memberBlocked && !hasUsableResult ? memberRes.status : null);

    if (effectiveBlockStatus) {
      if (consecutiveBlockCount === 0) blockLadderStartTs = Date.now();
      consecutiveBlockCount += 1;
      const blockType = effectiveBlockStatus === 403 ? '403' : '429';
      const blockedRoute = daysBlockStatus ? 'get-family-ofc-schedule-days' : 'query-family-members-ofc';
      warn(`Received HTTP ${blockType} from ${blockedRoute} (consecutive #${consecutiveBlockCount}).`);

      // Check if the 403/429 response was caused by a hard block page (Access limitation
      // or Cloudflare IP block). These require immediate cache clear + IP rotation,
      // not home page recovery. The page may have been redirected to the block page
      // even though the API returned 403/429.
      const hardBlockOnSchedule = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
      if (hardBlockOnSchedule.blocked) {
        warn(`HTTP ${blockType} caused by hard block page (${hardBlockOnSchedule.reason}). Clearing cache and rotating IP.`);
        await recoverFromBlockPage(page, config, hardBlockOnSchedule.reason, `schedule API ${blockType}`);
        consecutiveBlockCount = 0;
        continue;
      }

      if (consecutiveBlockCount >= 3) {
        blockCycleCount += 1;
        if (blockCycleCount >= 3) {
          // Three full strike ladders cleared without a clean response —
          // the block is not IP-scoped (likely account/session-wide rate
          // limit). Stop burning rotations: alert and take a long cooldown.
          warn(`HTTP ${blockType}: ${blockCycleCount} rotation cycles without recovery — likely account-side; cooling down 10 minutes and alerting.`);
          client('⏳', `Persistent ${blockType} blocks — pausing 10 minutes…`);
          uiStatus(`Paused — persistent ${blockType} block`);
          await sendMajorEventAlert(config, 'schedule_persistent_block', {
            runId,
            attempt,
            blockType,
            blockCycleCount,
            city: currentCity,
            url: page.url()
          });
          if (await sleepWithStopSignal(10 * 60 * 1000)) {
            info('Stop signal detected during persistent-block cooldown; exiting main loop.');
            break;
          }
          consecutiveBlockCount = 0;
          blockCycleCount = 0;
          continue;
        }
        if (inSpecialWindow()) {
          // Inside a slot-drop window a burst of 403/429s is server overload,
          // not an IP ban — hold the IP and let the home-recovery below retry.
          warn(`HTTP ${blockType} ×${consecutiveBlockCount} inside drop window — server load; holding IP (no rotation).`);
          client('⏳', `${blockType} ×${consecutiveBlockCount} during drop window — server busy, keeping IP...`);
        } else if (config.autoRotateIp) {
          if (ipRotatedSince(blockLadderStartTs)) {
            // Another ivac-core already rotated the machine-wide IP while
            // this ladder was climbing — the new shared IP is already live,
            // so a second rotation would just blackout every profile again.
            warn(`HTTP ${blockType} ×${consecutiveBlockCount} — shared IP already rotated by another process; reusing it (no rotation).`);
            client('🔄', 'IP already rotated — resuming on the new IP...');
            blockCycleCount = Math.max(0, blockCycleCount - 1); // no rotation was spent on this cycle
            consecutiveBlockCount = 0;
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
            continue;
          }
          // Third consecutive 403/429 — the session/IP is likely burned.
          warn(`HTTP ${blockType} received for ${consecutiveBlockCount} consecutive cities. Forcing NordVPN IP rotation.`);
          uiStatus('Rotating IP');
          await rotateEgress(config, isAborted, true, `OFC schedule API ${blockType} ×${consecutiveBlockCount} across consecutive cities`).catch(() => null);

          // Reload the page to clear stale Cloudflare session after IP rotation.
          client('🔄', 'Refreshing page after IP rotation...');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);

          const delayMs = getBackoffDelayMs(blockType, 2);
          await sendMajorEventAlert(config, 'schedule_' + blockType, {
            runId,
            attempt,
            consecutiveBlockCount,
            city: currentCity,
            backoffMs: delayMs,
            url: page.url()
          });
          try {
            await resumeFromCurrentPage(page, config);
            await page.waitForTimeout(delayMs).catch(() => null);
          } catch (e) {
            warn(`${blockType} recovery error:`, e);
            await page.waitForTimeout(10000).catch(() => null);
          }
          consecutiveBlockCount = 0;
          continue;
        } else {
          // Auto IP off — never rotate. Cool down on the same IP so the soft
          // block can decay, then resume the normal cycle.
          warn(`HTTP ${blockType} ×${consecutiveBlockCount} consecutive — Auto IP is off; cooling down 60s on the same IP instead of rotating.`);
          client('⏳', `${blockType} ×${consecutiveBlockCount} — Auto IP off; cooling down 60s (no rotation)...`);
          if (await sleepWithStopSignal(60000)) {
            info('Stop signal detected during 403/429 cooldown; exiting main loop.');
            break;
          }
          consecutiveBlockCount = 0;
          continue;
        }
      }

      // 429 = rate limited. Navigating home and back fires MORE requests
      // (home GET + nav link + member query + page-views), which keeps the
      // limiter hot so the limit never decays. The right response is to stay
      // on the page and stay quiet for 60-90s, then reload once — a single
      // reload re-fires the member query (~3 requests) vs ~6-8 for a full
      // home↔schedule round-trip.
      if (blockType === '429') {
        const quietMs = 60000 + Math.floor(Math.random() * 30000);
        warn(`HTTP 429 (consecutive #${consecutiveBlockCount}) — rate limited; holding ${(quietMs / 1000).toFixed(0)}s on-page then one reload (no home navigation — that would fire more requests).`);
        client('⏳', `Rate limited (429) — waiting ${(quietMs / 1000).toFixed(0)}s quietly…`);
        uiStatus('Rate limited — backing off');
        if (await sleepWithStopSignal(quietMs)) {
          info('Stop signal detected during 429 backoff; exiting main loop.');
          break;
        }
        resetMemberQueryResult();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
        // Wait for the page's own member query so its fresh verdict is
        // captured before the next iteration evaluates memberBlocked.
        await page.waitForResponse(
          (r) => {
            try {
              return r.request().method() === 'POST' && r.url().includes('query-family-members');
            } catch { return false; }
          },
          { timeout: 10000 }
        ).catch(() => null);
        continue; // same city — counter preserved, strike 3 still rotates
      }

      // Strikes 1-2 (or any strike inside a drop window): a city-page 403 is
      // often a stale cf session, not a dead IP. Go HOME, re-enter the schedule
      // page and retry city selection before spending an IP rotation.
      warn(`HTTP ${blockType} (consecutive #${consecutiveBlockCount}) on city selection — recovering via home page.`);
      client('🔄', `${blockType} — going home and retrying city selection...`);
      uiStatus(`Blocked ${blockType} — recovering`);
      backendError(blockedRoute, effectiveBlockStatus, null,
        `consecutive #${consecutiveBlockCount} | city=${currentCity}`);
      await sendMajorEventAlert(config, 'schedule_' + blockType, {
        runId,
        attempt,
        consecutiveBlockCount,
        city: currentCity,
        url: page.url()
      });
      // Jittered pause BEFORE the home↔schedule ping-pong — a fast refresh
      // cadence is itself a Cloudflare attention trigger.
      if (await pauseBeforeHomeRecovery(`${blockType} strike ${consecutiveBlockCount}`)) {
        info('Stop signal detected during pre-recovery pause; exiting main loop.');
        break;
      }
      try {
        await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
        await navigateToOfcSchedule(page, config.scheduleUrl);
        resetMemberQueryResult();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        warn(`${blockType} home recovery error:`, errMsg);

        // Check if the error was caused by a hard block page during navigation
        const hardBlockOnNav = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
        if (hardBlockOnNav.blocked) {
          warn(`Hard block detected during ${blockType} home recovery: ${hardBlockOnNav.reason}. Clearing cache and rotating IP.`);
          await recoverFromBlockPage(page, config, hardBlockOnNav.reason, `${blockType} home recovery`);
          consecutiveBlockCount = 0;
          continue;
        }

        // If it's a timeout error, wait 2-3 minutes and retry (network/loading issue, not a hard block)
        if (/timeout|timed out/i.test(errMsg)) {
          warn(`Timeout during ${blockType} home recovery. Waiting 2-3 minutes before retry...`);
          client('⏳', 'Timeout — waiting 2-3 minutes...');
          const timeoutWaitMs = 120000 + Math.floor(Math.random() * 60000); // 2-3 minutes
          if (await sleepWithStopSignal(timeoutWaitMs)) {
            info('Stop signal detected during timeout wait; exiting main loop.');
            break;
          }
          // Retry the same home recovery
          info('Retrying home recovery after timeout wait...');
          try {
            await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
            await navigateToOfcSchedule(page, config.scheduleUrl);
          } catch (retryErr) {
            warn('Retry after timeout also failed:', retryErr instanceof Error ? retryErr.message : String(retryErr));
            // After retry failure, check for hard block again
            const hardBlockOnRetry = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
            if (hardBlockOnRetry.blocked) {
              await recoverFromBlockPage(page, config, hardBlockOnRetry.reason, `${blockType} home recovery retry`);
              consecutiveBlockCount = 0;
              continue;
            }
            // If still not a hard block, proceed with normal retry logic
          }
        }
      }

      // Strike 1 retries the SAME city (the failure wasn't about the city);
      // strike 2 advances to the next city to cover more ground.
      if (consecutiveBlockCount >= 2) {
        cityIndex = (cityIndex + 1) % appointmentCities.length;
      }
      const nextCity = appointmentCities[cityIndex];
      const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
      client('⏳', `Retry: ${nextCity} after home recovery (waiting ${(delayMs / 1000).toFixed(1)}s)`);
      if (awaitingWindow) {
        info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
        await preciseSleepUntilSpecialWindow(specialTrigger);
        beginSpecialSweep(appointmentCities, cityIndex);
      } else {
        if (await sleepWithStopSignal(delayMs)) {
          info('Stop signal detected during 403/429 city wait; exiting main loop.');
          break;
        }
      }
      continue;
    }

    // === APP-LEVEL ERROR PATH ===
    // The backend answered but rejected the request — an HTTP 200 body with
    // HasError (e.g. SGA14) or a 5xx. The schedule-group context is broken
    // (usually because the upstream query-family-members call failed and
    // applications went out empty). Member-query 403/429s are NOT here —
    // they feed the transport strike ladder above.
    // CRITICAL: this must never reach the counter reset below — an
    // alternating 403 → SGA14 → 403 pattern used to oscillate the block
    // counter 1→0→1→0 forever and the rotation threshold was never hit.
    const appErrCode = scheduleResult?.appErrorCode ?? null;
    const serverErrStatus = !!(scheduleResult && scheduleResult.status !== null && scheduleResult.status >= 500);

    if ((appErrCode || serverErrStatus) && !hasUsableResult) {
      if (consecutiveAppErrorCount === 0) appErrorLadderStartTs = Date.now();
      consecutiveAppErrorCount += 1;
      // Prefer the real upstream member-query failure over the synthetic
      // NO_GROUP_MEMBERS label — it names the actual root cause.
      const memberErr = !!memberRes.error && (Date.now() - memberRes.at) < 120000;
      const code = memberErr ? `member_${memberRes.error}` : (appErrCode || `http_${scheduleResult?.status}`);
      backendError('schedule-group', scheduleResult?.status ?? memberRes.status ?? null, code,
        `consecutive #${consecutiveAppErrorCount} | city=${currentCity} | memberQuery=${memberRes.status ?? 'n/a'}`);
      client('⚠️', `Server error ${code} (${consecutiveAppErrorCount}x) — refreshing the schedule page…`);
      uiStatus(`Backend error ${code} — recovering`);
      warn(`[APP_ERROR] ${code} (consecutive #${consecutiveAppErrorCount}) on city ${currentCity} — schedule-group context broken; recovering via home page.`);

      // 5th consecutive app error — the session is degraded even without a
      // bare 403, so spend one IP rotation here.
      if (consecutiveAppErrorCount === 5) {
        if (config.autoRotateIp) {
          if (ipRotatedSince(appErrorLadderStartTs)) {
            // Another profile already rotated the shared IP while this
            // ladder was climbing — reuse it instead of rotating again.
            info(`[APP_ERROR] ${consecutiveAppErrorCount} consecutive app errors — shared IP already rotated by another process; reusing it (no rotation).`);
          } else {
            warn(`[APP_ERROR] ${consecutiveAppErrorCount} consecutive app errors — forcing NordVPN IP rotation.`);
            client('🔄', 'Repeated server errors — rotating IP…');
            uiStatus('Rotating IP');
            await rotateEgress(config, isAborted, true, `OFC app error ${code} ×${consecutiveAppErrorCount}`).catch(() => null);
          }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
          resetMemberQueryResult();
        } else {
          warn(`[APP_ERROR] ${consecutiveAppErrorCount} consecutive app errors — Auto IP is off; continuing recovery on the same IP.`);
        }
      }

      // 8th+ consecutive — persistent app errors are almost always
      // account-side (no IP will fix them). Alert + long cooldown instead of
      // spinning on a dead session forever.
      if (consecutiveAppErrorCount >= 8) {
        warn(`[APP_ERROR] ${consecutiveAppErrorCount} consecutive app errors (${code}) — likely account-side; cooling down 10 minutes and alerting.`);
        client('⏳', `Persistent server error ${code} — pausing 10 minutes…`);
        uiStatus(`Paused — persistent backend error ${code}`);
        await sendMajorEventAlert(config, 'schedule_app_error', {
          runId,
          attempt,
          code,
          consecutiveAppErrorCount,
          city: currentCity,
          url: page.url()
        });
        if (await sleepWithStopSignal(10 * 60 * 1000)) {
          info('Stop signal detected during app-error cooldown; exiting main loop.');
          break;
        }
        consecutiveAppErrorCount = 0;
        continue;
      }

      if (await pauseBeforeHomeRecovery(`app error ${code} #${consecutiveAppErrorCount}`)) {
        info('Stop signal detected during app-error recovery pause; exiting main loop.');
        break;
      }
      try {
        await page.goto(getHomePageUrl(config.scheduleUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await waitForHumanVerificationIfNeeded(page, config.cloudflareWaitMs, config.autoSolveCloudflare, isAborted).catch(() => null);
        await navigateToOfcSchedule(page, config.scheduleUrl);
        resetMemberQueryResult();
      } catch (e) {
        warn('App-error home recovery error:', e);
      }

      // Mirror the strike path: first error retries the same city, later
      // ones advance to the next city to cover more ground.
      if (consecutiveAppErrorCount >= 2) {
        cityIndex = (cityIndex + 1) % appointmentCities.length;
      }
      const nextCity = appointmentCities[cityIndex];
      const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
      client('⏳', `Retry: ${nextCity} after recovery (waiting ${(delayMs / 1000).toFixed(1)}s)`);
      if (awaitingWindow) {
        info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
        await preciseSleepUntilSpecialWindow(specialTrigger);
        beginSpecialSweep(appointmentCities, cityIndex);
      } else {
        if (await sleepWithStopSignal(delayMs)) {
          info('Stop signal detected during app-error city wait; exiting main loop.');
          break;
        }
      }
      continue;
    }

    // Reset counters on any clean (non-error) response
    consecutiveBlockCount = 0;
    blockCycleCount = 0;
    consecutiveAppErrorCount = 0;

    // === DIRECT API FLOW ===
    // Try direct XMLHttpRequest-based API calls to bypass DOM rendering waits.
    // Falls back to DOM flow if Cloudflare blocks or if direct flow doesn't succeed.
    if (!directApiBlocked && scheduleResult && scheduleResult.status === 200) {
      info('Attempting direct API flow for OFC scheduling...');
      const directResult = await runDirectOfcFlow(page, config).catch((e) => {
        warn('Direct API flow error:', e instanceof Error ? e.message : String(e));
        return { success: false, fallback: true } as DirectApiResult;
      });

      // Shared OFC-booked completion: notifications → consular stage →
      // final bookkeeping. Used by the normal direct-API success AND by
      // the late-entries rescue below (same outcome, different trigger).
      const handleDirectOfcSuccess = async (result: DirectApiResult, method: string): Promise<void> => {
        info(`OFC appointment booked (${method})! Proceeding to consular stage.`);
        client('✅', `OFC BOOKED! Date=${result.bookedDate || '?'} Time=${result.bookedTime || '?'}`);

        sendSupabaseEvent('ofc_submitted', {
          username: config.username,
          runId,
          attempt,
          city: currentCity,
          date: result.bookedDate || '',
          time: result.bookedTime || '',
          method,
          url: page.url(),
          timestamp: new Date().toISOString()
        }).catch(() => null);

        // Telegram notification (fire-and-forget — never blocks the booking loop)
        sendOfcBookedNotification({
          username: config.username,
          city: currentCity,
          date: result.bookedDate || '',
          time: result.bookedTime || ''
        }).catch(() => null);

        // Open notification video immediately on OFC success (only once).
        if (!notificationVideoOpened) {
          info('OFC booked — opening notification video (consular will continue in background)...');
          client('🔔', 'Notification sent — consular booking in progress...');
          openNotificationVideo(page);
          notificationVideoOpened = true;
        }

        // Run consular stage with continuous monitoring and 403 recovery.
        // This does NOT return false on failure — it keeps trying until
        // consular is booked or the stop signal is detected.
        const consularOk = await runConsularStageWithRecovery(page, config, runId, attempt);
        if (consularOk) {
          // Full success (OFC + consular both submitted)
          booked = true;
          saveCheckpoint({
            runId,
            state: 'booked',
            attempt,
            city: currentCity,
            date: result.bookedDate || '',
            time: result.bookedTime || '',
            url: page.url(),
            timestamp: new Date().toISOString()
          });
          sendMajorEventAlert(config, 'appointment_submitted', {
            runId,
            attempt,
            city: currentCity,
            date: result.bookedDate || '',
            time: result.bookedTime || '',
            url: page.url(),
            method
          });
          info('Consular appointment booked! Full success (OFC + consular).');
          client('✅', 'CONSULAR BOOKED! Full appointment complete!');
          sendSupabaseEvent('consular_submitted', {
            username: config.username,
            runId,
            attempt,
            city: currentCity,
            date: result.bookedDate || '',
            time: result.bookedTime || '',
            url: page.url(),
            method,
            timestamp: new Date().toISOString()
          }).catch(() => null);
        } else {
          // Consular was not booked (stop signal or browser closed)
          warn('Consular stage did not complete; OFC was booked but consular appointment was NOT booked.');
          warn('The OFC appointment is still valid — you may need to manually book the consular appointment.');
        }
      };

      if (directResult.fallback === true) {
        // Only count actual Cloudflare blocks toward the session block —
        // context-extraction failures retry freely on the next city select.
        if (directResult.reason === 'blocked') {
          directApiBlockStrikes++;
          if (directApiBlockStrikes >= 3) {
            directApiBlocked = true;
            warn('Direct API blocked by Cloudflare 3× consecutively — using DOM flow for remainder of session');
          } else {
            warn(`Direct API blocked by Cloudflare (strike ${directApiBlockStrikes}/3) — fast path retries on next attempt`);
          }
        } else {
          directApiBlockStrikes = 0;
        }
        info('Direct API did not succeed — continuing with DOM-based flow');
      } else if (directResult.success) {
        // OFC appointment booked via direct API!
        await handleDirectOfcSuccess(directResult, 'direct_api');
        break; // exit main loop
      } else {
        // Direct API completed but no slots/dates — same as DOM flow finding no slots
        directApiBlockStrikes = 0; // any non-blocked outcome clears the strike count
        info(`Direct API result: ${directResult.reason || 'no success'}`);

        // If the fast flow already tried all dates and exhausted them, skip the
        // DOM flow — it would repeat the same failures with the same stale state.
        // The outer loop will re-select the city and start fresh.
        if (directResult.reason === 'all_exhausted' || directResult.reason === 'hard_error') {
          info('Fast flow exhausted all dates — skipping DOM flow, moving to next city');
          // Respect the configured retry delay — an immediate continue would
          // reselect the city with zero wait and loop flat-out.
          cityIndex = (cityIndex + 1) % appointmentCities.length;
          const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
          client('⏳', `Next: ${appointmentCities[cityIndex]} (waiting ${(delayMs / 1000).toFixed(1)}s)`);
          if (awaitingWindow) {
            info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
            await preciseSleepUntilSpecialWindow(specialTrigger);
            beginSpecialSweep(appointmentCities, cityIndex);
          } else {
            // Late-entries rescue (backup path): if the fast flow timed out
            // with a getScheduleEntries request still in flight, listen for
            // the late response during this wait — dead time the loop
            // already spends. The rescue is consumed before the next city
            // selection, where the per-city context would die anyway.
            const rescueP = consumeLateEntriesRescue(page, config, delayMs).catch(() => null);
            if (await sleepWithStopSignal(delayMs)) {
              info('Stop signal detected during exhausted-flow wait; exiting main loop.');
              break;
            }
            // The wait elapsed. If a rescue capture landed near the end and
            // a submit is mid-flight, give it a bounded settle window — only
            // ever extends the loop when a real submit is in progress.
            const rescueResult = await Promise.race<DirectApiResult | null>([
              rescueP,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 25000))
            ]);
            if (rescueResult && rescueResult.success) {
              await handleDirectOfcSuccess(rescueResult, 'direct_api_late_rescue');
              break;
            }
          }
          continue;
        }
        // For other reasons (no_slots, no_dates_in_range, blocked), fall through
        // to DOM flow which may handle the situation differently
      }
    }
    // === END DIRECT API FLOW ===

    if (scheduleResult && !scheduleResult.available && !scheduleResult.timeout) {
      // Check if the "no availability" result is actually a hard block page
      // (Cloudflare can return 200 with block HTML that gets parsed as no availability).
      const hardBlockNoAvail = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
      if (hardBlockNoAvail.blocked) {
        await recoverFromBlockPage(page, config, hardBlockNoAvail.reason, '(disguised as no availability)');
        continue;
      }

      warn('Schedule API indicates no availability for this city.');
      client('📅', `No dates available for ${currentCity}`);
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
        let uiApiMismatchRetries = config.uiApiMismatchRetries;
        const uiApiMismatchRetryDelayMs = config.uiApiMismatchRetryDelayMs;
        if (appointmentCities.length > 1) uiApiMismatchRetries = 0;
        // A postId-matched HTTP 200 that parsed cleanly is an AUTHORITATIVE
        // answer for this city — the empty-days result is real, not a UI/API
        // mismatch. Reselecting the same city just re-fires schedule-days calls
        // for nothing, so skip the mismatch retries and respect cityRetrySeconds.
        if (scheduleResult && scheduleResult.status === 200 && !scheduleResult.parseError) {
          uiApiMismatchRetries = 0;
        }
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

          const retryPostId = await findCityPostId(page, currentCity);
          const scheduleResponsePromise = waitForScheduleResponse(page, scheduleWaitMs(), retryPostId || undefined);
          resetCapturedScheduleData();
          await selectCity(page, currentCity, true, config);
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
          // Rotate to the next city (for single city: (0+1) % 1 = 0, stays the same)
          cityIndex = (cityIndex + 1) % appointmentCities.length;
          const nextCity = appointmentCities[cityIndex];

          // Compute retry delay with special window awareness
          const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);

          if (awaitingWindow) {
            info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
          }

          info(`Next city: ${nextCity}. Waiting ${delayMs}ms before retry.`);
          client('⏳', `Next: ${nextCity} (waiting ${(delayMs / 1000).toFixed(1)}s)`);
          if (awaitingWindow) {
            // Precisely sync to the special-window trigger so the city
            // selection fires exactly on :MM:58 instead of drifting late.
            await preciseSleepUntilSpecialWindow(specialTrigger);
            beginSpecialSweep(appointmentCities, cityIndex);
          } else {
            await page.waitForTimeout(delayMs);
          }

          // Log clearly if we woke up inside a special window
          const afterDelay = new Date();
          if (inSpecialWindow()) {
            info(`SPECIAL WINDOW ACTIVE: City selection inside drop window at system time ${afterDelay.toTimeString().slice(0, 8)}`);
          }

          continue;
        }
      }

    }

    if (scheduleResult?.timeout) {
      warn('Schedule API response timed out; falling back to UI state.');

      // During a multi-city sweep, a >60s response means the server is wedged —
      // abort the whole sweep rather than burning the drop window on the
      // remaining cities. No-op when a sweep isn't running.
      abortSpecialSweep(`schedule response exceeded 60s for ${currentCity}`);

      // Check if the timeout was caused by a hard block page (Cloudflare IP block
      // or Access limitation). selectCity can trigger an API call that gets
      // blocked, redirecting the page to the block page. The schedule response
      // then times out. Detect the block here and recover via IP rotation.
      const hardBlockOnTimeout = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
      if (hardBlockOnTimeout.blocked) {
        await recoverFromBlockPage(page, config, hardBlockOnTimeout.reason, 'after schedule timeout');
        continue;
      }

      // Try to detect whether the calendar UI became available despite the timeout.
      // If the calendar is not visible within a short grace period, treat this as
      // a transient failure and retry next city / wait instead of proceeding
      // into the date/time flow (which will otherwise time out waiting for the calendar).
      try {
        const cal = await page.waitForSelector('#datepicker, .ui-datepicker', { timeout: 5000 }).catch(() => null);
        if (!cal) {
          warn('Calendar not visible after schedule timeout; will retry outer loop instead of date/time flow.');
          cityIndex = (cityIndex + 1) % appointmentCities.length;

          const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
          info(`Next city: ${appointmentCities[cityIndex]}. Waiting ${delayMs}ms before retry due to schedule timeout.`);
          if (awaitingWindow) {
            info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
            await preciseSleepUntilSpecialWindow(specialTrigger);
            beginSpecialSweep(appointmentCities, cityIndex);
          } else {
            await page.waitForTimeout(delayMs);
          }
          continue;
        }
        info('Calendar became visible despite schedule API timeout; proceeding to date/time flow.');
      } catch (e) {
        warn('Error while checking calendar visibility after schedule timeout:', e);
        cityIndex = (cityIndex + 1) % appointmentCities.length;

        const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
        if (awaitingWindow) {
          info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
          await preciseSleepUntilSpecialWindow(specialTrigger);
          beginSpecialSweep(appointmentCities, cityIndex);
        } else {
          await page.waitForTimeout(delayMs);
        }
        continue;
      }
    }

    if (skippedCitySelectionFromCheckpoint) {
      info('Proceeding directly to date/time flow from checkpoint state.');
    }

    // After city selection, retry date+time selection a few times before falling back to reselecting city
    const maxDateAttempts = config.maxDateAttempts;
    let dateAttempt = 0;
    let dateLoopContinue = false;

    while (dateAttempt < maxDateAttempts && !booked) {
      dateAttempt += 1;
      info(`Date/time attempt ${dateAttempt}/${maxDateAttempts} for appointment try ${attempt}`);

      // Wait for calendar, but recover gracefully if it doesn't appear.
      try {
        await waitForCalendarReady(page, 30000);
        // Calendar is now visible — beep immediately (fire-and-forget, non-blocking).
        // This fires the moment the calendar appears, regardless of whether any
        // dates fall in the configured range.
        playBeep();
      } catch (e) {
        warn('Calendar did not become ready within timeout; attempting recovery steps.', e);
        let recovered = false;

        // Try a few recovery attempts: reselect city, short waits, or navigate back to schedule
        for (let rec = 0; rec < 3 && !recovered; rec += 1) {
          if (checkStopSignal()) {
            // Exit directly — checkStopSignal() already consumed the file, so
            // merely continuing would swallow the stop and keep the loop alive.
            info('Stop signal detected during calendar recovery; aborting.');
            await gracefulExit(config);
          }
          try {
            info(`Recovery attempt ${rec + 1}/3: reselecting city and checking calendar`);
            // reselect current city to trigger schedule refresh
            try {
                await selectCity(page, currentCity, true, config);
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

      // Smart month jump: use API response data to find the earliest available
      // date in the configured range and jump the calendar directly to that month,
      // instead of always starting at the configured month (which may show empty months).
      let targetMonth: string | number = config.appointment.month;
      let targetYear: number = config.appointment.year;
      const apiEarliestDate = extractEarliestApiDate(scheduleResult, config.appointment.startDate, config.appointment.endDate);
      if (apiEarliestDate) {
        const apiYear = Number(apiEarliestDate.slice(0, 4));
        const apiMonth = Number(apiEarliestDate.slice(5, 7));
        info(`API indicates earliest available date: ${apiEarliestDate} — jumping calendar to month ${apiMonth}/${apiYear}`);
        targetMonth = apiMonth;
        targetYear = apiYear;
      }

      await selectCalendarMonthYear(page, targetMonth, targetYear);

      // Enumerate ALL green days in range on the currently-visible calendar month.
      // We iterate through them (fastest first), and within each date iterate ALL available
      // time slots by descending availability. If submit stays disabled for 5s on a time slot,
      // we try the next slot. If a date has no working time slot, we jump to the next date.
      let candidateDates: { date: string; locator: any }[];
      let domDatesReordered = false; // EXPERIMENTAL: avoidEarliestDate
      {
        // Single DOM evaluation that returns BOTH all visible green dates and
        // the in-range subset — zero extra DOM round-trip vs. the old call.
        const { allAvailable, inRange } = await getDatesWithAllAvailable(
          page,
          config.appointment.startDate,
          config.appointment.endDate,
          []
        );
        // EXPERIMENTAL: avoidEarliestDate — same 2nd-first reorder as the
        // fast flow so DOM fallback doesn't silently switch strategy.
        candidateDates = orderDatesForAttempt(inRange, c => c.date, config.avoidEarliestDate,
          { path: 'dom', profile: config.username, city: currentCity, runId, attempt });
        domDatesReordered = candidateDates !== inRange;

        // Log all available dates to client (even if not in range)
        const allDates = allAvailable.map(d => d.date);
        const inRangeDates = inRange.map(d => d.date);
        if (allDates.length > 0) {
          const outOfRange = allDates.filter(d => !inRangeDates.includes(d));
          let msg = `Calendar visible for ${currentCity} — ${allDates.length} date(s) available: ${allDates.join(', ')}`;
          if (inRangeDates.length > 0) {
            msg += ` (${inRangeDates.length} in range)`;
          } else {
            msg += ` (0 in range)`;
          }
          client('📅', msg);
        } else {
          client('📅', `Calendar visible for ${currentCity} — no available dates on this month.`);
        }

        // Record this OFC calendar observation to the local JSONL log.
        // Fire-and-forget (non-blocking) — captures ALL visible green dates
        // (availableDates) AND the in-range subset (inRangeDates) for later
        // pattern analysis of appointment release dates/times.
        recordSlotObservation({
          timestamp: new Date().toISOString(),
          profile: config.username,
          runId,
          stage: 'ofc',
          city: currentCity,
          url: page.url(),
          availableDates: allAvailable.map(d => d.date),
          inRangeDates: inRange.map(d => d.date),
          configuredRange: {
            startDate: config.appointment.startDate,
            endDate: config.appointment.endDate,
            month: config.appointment.month,
            year: config.appointment.year,
          },
          apiScheduleDays: scheduleResult?.scheduleDays?.length ?? 0,
          apiScheduleEntries: scheduleResult?.scheduleEntries?.length ?? 0,
          apiAvailable: scheduleResult?.available ?? null,
          calendarMonth: null,
        });
      }

      if (candidateDates.length === 0) {
        warn('No available date found within configured range on visible calendar');

        // Multi-city: try each remaining city once without delay before falling back
        if (appointmentCities.length > 1) {
          let foundInOtherCity = false;
          const startCityIndex = cityIndex;
          for (let ci = 1; ci < appointmentCities.length; ci++) {
            const tryCityIndex = (startCityIndex + ci) % appointmentCities.length;
            const tryCity = appointmentCities[tryCityIndex];
            info(`Dates not in range for ${currentCity}; trying city ${tryCity} (${ci}/${appointmentCities.length - 1})`);

            // Random delay (3-5s) between city checks to avoid rate limiting / 1015
            const cityGapMs = 3000 + Math.floor(Math.random() * 2000);
            info(`Waiting ${cityGapMs}ms before selecting next city to avoid rate limiting`);
            await page.waitForTimeout(cityGapMs);

            const tryPostId = await findCityPostId(page, tryCity);
            const schedRespPromise = waitForScheduleResponse(page, scheduleWaitMs(), tryPostId || undefined);
            await selectCity(page, tryCity, true, config);
            const tryResult = await schedRespPromise;

            const tryApiDate = extractEarliestApiDate(tryResult, config.appointment.startDate, config.appointment.endDate);
            if (tryApiDate) {
              const tryYear = Number(tryApiDate.slice(0, 4));
              const tryMonth = Number(tryApiDate.slice(5, 7));
              info(`API indicates date ${tryApiDate} for ${tryCity} — jumping calendar to ${tryMonth}/${tryYear}`);
              await selectCalendarMonthYear(page, tryMonth, tryYear);
            } else {
              await selectCalendarMonthYear(page, config.appointment.month, config.appointment.year);
            }

            {
              const { allAvailable, inRange } = await getDatesWithAllAvailable(
                page,
                config.appointment.startDate,
                config.appointment.endDate,
                []
              );
              // EXPERIMENTAL: avoidEarliestDate — same reorder as fast flow.
              candidateDates = orderDatesForAttempt(inRange, c => c.date, config.avoidEarliestDate,
                { path: 'dom', profile: config.username, city: tryCity, runId, attempt });
              domDatesReordered = candidateDates !== inRange;
              // Log all available dates to client (even if not in range)
              const tryAllDates = allAvailable.map(d => d.date);
              const tryInRangeDates = inRange.map(d => d.date);
              if (tryAllDates.length > 0) {
                let msg = `Calendar visible for ${tryCity} — ${tryAllDates.length} date(s) available: ${tryAllDates.join(', ')}`;
                if (tryInRangeDates.length > 0) {
                  msg += ` (${tryInRangeDates.length} in range)`;
                } else {
                  msg += ` (0 in range)`;
                }
                client('📅', msg);
              } else {
                client('📅', `Calendar visible for ${tryCity} — no available dates on this month.`);
              }
              // Record this OFC calendar observation for the alternate city.
              // Fire-and-forget (non-blocking) — captures ALL visible green dates
              // and the in-range subset.
              recordSlotObservation({
                timestamp: new Date().toISOString(),
                profile: config.username,
                runId,
                stage: 'ofc',
                city: tryCity,
                url: page.url(),
                availableDates: allAvailable.map(d => d.date),
                inRangeDates: inRange.map(d => d.date),
                configuredRange: {
                  startDate: config.appointment.startDate,
                  endDate: config.appointment.endDate,
                  month: config.appointment.month,
                  year: config.appointment.year,
                },
                apiScheduleDays: tryResult?.scheduleDays?.length ?? 0,
                apiScheduleEntries: tryResult?.scheduleEntries?.length ?? 0,
                apiAvailable: tryResult?.available ?? null,
                calendarMonth: null,
              });
            }
            if (candidateDates.length > 0) {
              // OFC/VAC: beep when calendar visible with available dates (other city).
              playBeep();
              info(`Found ${candidateDates.length} date(s) in city ${tryCity}`);
              cityIndex = tryCityIndex;
              foundInOtherCity = true;
              break;
            }
          }

          if (!foundInOtherCity) {
            warn('No dates in range across any city after one full rotation; falling back to normal retry');
            cityIndex = (startCityIndex + 1) % appointmentCities.length;
            dateLoopContinue = true;
            break;
          }
        } else {
          // Single city: break to outer loop for normal retry with delay
          dateLoopContinue = true;
          break;
        }
      }

      info(`Iterating ${candidateDates.length} candidate date(s):`, candidateDates.map(d => d.date).join(', '));

      let bookedThisAttempt = false;
      let hardStop = false; // set when we submit-clicked but response was bad and we navigated away
      for (let di = 0; di < candidateDates.length; di += 1) {
        const dateCell = candidateDates[di];
        const selectedDate = dateCell.date;

        // Rate-limit avoidance: pause between date attempts so Cloudflare / IVAC
        // doesn't flag the burst of rapid date clicks as bot activity. Skip on first date.
        if (di > 0) {
          const gapMs = 2000 + Math.floor(Math.random() * 2000); // 2-4s
          info(`Waiting ${gapMs}ms before trying next date (rate-limit avoidance)`);
          await page.waitForTimeout(gapMs);
        }

        info(`Trying date ${selectedDate}`);
        try {
          await clickDateCell(page, dateCell);
        } catch (err) {
          warn(`Could not click date ${selectedDate}, skipping:`, err);
          continue;
        }

        saveCheckpoint({
          runId,
          state: 'date_selected',
          attempt,
          city: currentCity,
          date: selectedDate,
          url: page.url(),
          timestamp: new Date().toISOString()
        });
        if (config.screenshotAfterSelection) {
          saveScreenshot(page, `date-selected-${selectedDate}`).catch(() => null);
        }

        const timeCandidates = await getAvailableTimeCandidates(page, config.appointment.preferredTime ?? null, config.preferLeastSlots);
        if (timeCandidates.length === 0) {
          warn(`No available time slots for date ${selectedDate}; moving to next date`);
          // EXPERIMENTAL
          recordDateExperiment({ type: 'outcome', path: 'dom', profile: config.username, city: currentCity, runId, attempt, date: selectedDate, pos: di + 1, promoted: domDatesReordered && di === 0, result: 'no_slots' });
          continue;
        }

        info(`Date ${selectedDate}: ${timeCandidates.length} time slot(s), ordered by preferred+availability`);

        // Adaptive enable-timeout: if this is the ONLY date-time combination we have
        // (1 date candidate AND 1 time on that date), we have nothing to fall back to,
        // so wait up to 20s for submit to enable. Otherwise stay fast (5s) and skip.
        const singleOption = candidateDates.length === 1 && timeCandidates.length === 1;
        const enableTimeoutMs = singleOption ? 20000 : 5000;
        info(`  submit-enable timeout: ${enableTimeoutMs}ms (singleOption=${singleOption})`);

        let submittedThisDate = false;
        for (let ti = 0; ti < timeCandidates.length; ti += 1) {
          const cand = timeCandidates[ti];
          info(`  Time ${ti + 1}/${timeCandidates.length}: '${cand.time}' avail=${cand.avail}`);
          await selectTimeCandidate(page, cand);

          saveCheckpoint({
            runId,
            state: 'time_selected',
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            url: page.url(),
            timestamp: new Date().toISOString()
          });

          // Set up an HTTP response listener before clicking submit so we can verify a 2xx response.
          // CRITICAL: Only match the actual submit endpoint, not getScheduleEntries or getScheduleDays.
          // The page may make multiple submit calls (retries) — wait for the one with JSON content.
          // The first response may be an empty 270-byte HTML wrapper; the actual result comes later.
          const submitResponsePromise = page.waitForResponse(
            (resp: any) => {
              try {
                const method = resp.request().method();
                if (method !== 'POST') return false;
                const status = resp.status();
                const url = resp.url();
                if (status < 200 || status >= 400) return false;
                if (!url.includes('appointments-for-family')) return false;
                // Only match responses that have a body with JSON (AllScheduled or HasError)
                // This skips empty 270-byte HTML-only responses
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 30000 }
          ).catch(() => null);

          const submitResult = await submitAppointment(page, config, {
            enableTimeoutMs,
            selected: { time: cand.time, availability: cand.avail }
          });
          if (submitResult !== true) {
            warn(`  Submit button did not enable/click for time '${cand.time}'; trying next time`);
            continue;
          }

          // Submit was clicked. Verify the response and navigation.
          let submitResponse = await submitResponsePromise;
          let responseOk = !!(submitResponse && submitResponse.status() >= 200 && submitResponse.status() < 400);
          let submitAllScheduled = false;
          let submitHasError = false;
          let submitRedirectStub = '';

          // Helper to parse submit response body (server wraps JSON in HTML)
          async function parseSubmitResponse(resp: any): Promise<{ allScheduled: boolean; hasError: boolean; redirectStub: string; bodyLen: number; hasJson: boolean }> {
            try {
              const body = await resp.text().catch(() => '');
              const contentType = resp.headers()?.['content-type'] || '';
              info(`[DOM FLOW] Submit response: contentType=${contentType}, bodyLen=${body.length}`);
              if (body.length === 0) return { allScheduled: false, hasError: false, redirectStub: '', bodyLen: 0, hasJson: false };
              const jsonStart = body.indexOf('{');
              const jsonEnd = body.lastIndexOf('}');
              let parsed: any = null;
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                try { parsed = JSON.parse(body.substring(jsonStart, jsonEnd + 1)); } catch { /* try direct */ }
              }
              if (!parsed) { try { parsed = JSON.parse(body); } catch { /* not JSON */ } }
              if (parsed) {
                info(`[DOM FLOW] Submit parsed: AllScheduled=${parsed.AllScheduled}, HasError=${parsed.HasError}, RedirectStub=${parsed.RedirectStub || 'none'}, Errors=${JSON.stringify(parsed.Errors || {}).substring(0, 300)}`);
                return { allScheduled: !!parsed.AllScheduled, hasError: !!parsed.HasError, redirectStub: parsed.RedirectStub || '', bodyLen: body.length, hasJson: true };
              }
              // No JSON found — log a short preview for debugging
              if (body.trim().length > 0) {
                info(`[DOM FLOW] Submit body has no JSON (first 200 chars): ${body.substring(0, 200).replace(/\s+/g, ' ')}`);
              }
              return { allScheduled: false, hasError: false, redirectStub: '', bodyLen: body.length, hasJson: false };
            } catch {
              return { allScheduled: false, hasError: false, redirectStub: '', bodyLen: 0, hasJson: false };
            }
          }

          if (submitResponse) {
            info(`OFC submit HTTP response: ${submitResponse.status()} ${submitResponse.url()}`);
            const parsedResult = await parseSubmitResponse(submitResponse);
            submitAllScheduled = parsedResult.allScheduled;
            submitHasError = parsedResult.hasError;
            submitRedirectStub = parsedResult.redirectStub;

            // If the first response had no JSON (empty 270-byte HTML wrapper),
            // the page likely retries. Wait for a second response with actual JSON.
            if (!parsedResult.hasJson && !parsedResult.allScheduled) {
              info('[DOM FLOW] First submit response had no JSON — waiting for retry response...');
              const retryResponsePromise = page.waitForResponse(
                (resp: any) => {
                  try {
                    return resp.request().method() === 'POST' &&
                           resp.status() >= 200 && resp.status() < 400 &&
                           resp.url().includes('appointments-for-family');
                  } catch { return false; }
                },
                { timeout: 10000 }
              ).catch(() => null);

              const retryResponse = await retryResponsePromise;
              if (retryResponse) {
                info(`[DOM FLOW] Retry submit response: ${retryResponse.status()} ${retryResponse.url()}`);
                const retryParsed = await parseSubmitResponse(retryResponse);
                if (retryParsed.hasJson) {
                  submitAllScheduled = retryParsed.allScheduled;
                  submitHasError = retryParsed.hasError;
                  submitRedirectStub = retryParsed.redirectStub;
                }
              }
            }
          } else {
            warn('OFC submit: no matching 2xx POST response captured within timeout');
          }
          // Fast-fail: if the submit response already says HasError=true (e.g. "slot no longer available"),
          // don't wait 30 seconds for navigation — try the next time slot immediately.
          if (submitHasError && !submitAllScheduled) {
            warn(`OFC submit returned error (AllScheduled=false, HasError=true) — slot likely taken; trying next time slot`);
            // EXPERIMENTAL
            recordDateExperiment({ type: 'outcome', path: 'dom', profile: config.username, city: currentCity, runId, attempt, date: selectedDate, pos: di + 1, promoted: domDatesReordered && di === 0, result: 'submit_error', time: cand.time });
            continue;
          }

          // If submit response says AllScheduled=true with a redirect, navigate there directly
          if (submitAllScheduled && submitRedirectStub) {
            info(`OFC submit success (AllScheduled=true), redirecting to ${submitRedirectStub}`);
            const redirectUrl = `/en-US/${submitRedirectStub}`;
            await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          } else {
            try {
              await page.waitForURL(/\/en-US\/schedule\//, { timeout: 30000 });
            } catch {
              // fall through; we'll check page.url() below
            }
          }
          const currentUrl = page.url();
          const onConsularPage = currentUrl.includes('/en-US/schedule/');

          if (!responseOk || !onConsularPage) {
            warn(`OFC submit outcome not positive (responseOk=${responseOk}, onConsularPage=${onConsularPage}, url=${currentUrl}); aborting date/time loop`);
            await saveScreenshot(page, 'ofc-submit-not-positive').catch(() => null);
            hardStop = true;
            break;
          }

          // EXPERIMENTAL
          recordDateExperiment({ type: 'outcome', path: 'dom', profile: config.username, city: currentCity, runId, attempt, date: selectedDate, pos: di + 1, promoted: domDatesReordered && di === 0, result: 'booked', time: cand.time });
          info('OFC submit positive and page navigated to consular schedule; starting consular stage');
          saveCheckpoint({
            runId,
            state: 'ofc_submitted',
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            url: currentUrl,
            timestamp: new Date().toISOString()
          });
          // Log VAC/OFC submit success to Supabase (fire-and-forget; don't block consular stage).
          sendSupabaseEvent('ofc_submitted', {
            username: config.username,
            runId,
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            availability: cand.avail,
            submitResponseStatus: submitResponse ? submitResponse.status() : null,
            submitResponseUrl: submitResponse ? submitResponse.url() : null,
            url: currentUrl,
            timestamp: new Date().toISOString()
          }).catch(() => null);

          // Send Telegram notification (fire-and-forget — never blocks the booking loop)
          sendOfcBookedNotification({
            username: config.username,
            city: currentCity,
            date: selectedDate,
            time: cand.time
          }).catch(() => null);

          // Open notification video immediately on OFC success (only once).
          if (!notificationVideoOpened) {
            info('OFC booked (DOM flow) — opening notification video (consular will continue in background)...');
            openNotificationVideo(page);
            notificationVideoOpened = true;
          }

          const consularOk = await runConsularStageWithRecovery(page, config, runId, attempt);
          if (!consularOk) {
            warn('Consular stage did not complete (stop signal or browser closed); aborting date/time loop');
            hardStop = true;
            break;
          }

          // Full success (OFC + consular both submitted).
          booked = true;
          bookedThisAttempt = true;
          saveCheckpoint({
            runId,
            state: 'booked',
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            url: page.url(),
            timestamp: new Date().toISOString()
          });
          sendMajorEventAlert(config, 'appointment_submitted', {
            runId,
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            url: page.url()
          });
          info('Consular appointment booked! Full success (OFC + consular via DOM flow).');
          client('✅', 'CONSULAR BOOKED! Full appointment complete!');
          sendSupabaseEvent('consular_submitted', {
            username: config.username,
            runId,
            attempt,
            city: currentCity,
            date: selectedDate,
            time: cand.time,
            url: page.url(),
            method: 'dom_flow',
            timestamp: new Date().toISOString()
          }).catch(() => null);
          submittedThisDate = true;
          break; // exit time loop
        } // end time loop

        if (bookedThisAttempt || hardStop) break; // exit date loop
        if (!submittedThisDate) {
          info(`All time slots on ${selectedDate} exhausted without a successful submit; moving to next date`);
        }
      } // end date loop

      if (bookedThisAttempt) break; // exit inner while (dateAttempt loop)

      if (hardStop) {
        // We clicked submit and got navigated away with a bad outcome; let the outer loop recover.
        dateLoopContinue = true;
        break;
      }

      warn('All candidate dates/times exhausted without a successful submit; retrying date/time selection');
      if (dateAttempt >= maxDateAttempts) {
        dateLoopContinue = true;
        break;
      }
      // Use computeRetryDelay for the delay between date attempts — plain
      // retry delay, no trigger alignment: pausing mid-booking to
      // hit a city-selection trigger would stall the open calendar.
      const { delayMs: dateRetryDelayMs } = computeRetryDelay(config.cityRetrySeconds, false);
      await page.waitForTimeout(dateRetryDelayMs);
    }

    if (dateLoopContinue) {
      // All dateLoopContinue paths used to `continue` immediately — with zero
      // delay the loop re-selected the city at API speed (~3-5s/iteration),
      // ignoring cityRetrySeconds and hammering the schedule endpoint into
      // 403s. Apply the normal retry delay (with special-window alignment)
      // before re-selecting a city.
      const retryCity = appointmentCities[cityIndex];
      const { delayMs, specialTrigger, awaitingWindow } = computeRetryDelay(config.cityRetrySeconds);
      if (awaitingWindow) {
        info(`SPECIAL WINDOW: Trigger :${formatTriggerMMSS(specialTrigger)} in ${(delayMs / 1000).toFixed(1)}s — timing city selection to hit the drop`);
        await preciseSleepUntilSpecialWindow(specialTrigger);
        beginSpecialSweep(appointmentCities, cityIndex);
      } else {
        client('⏳', `Next: ${retryCity} (waiting ${(delayMs / 1000).toFixed(1)}s)`);
        if (await sleepWithStopSignal(delayMs)) {
          info('Stop signal detected during city retry wait; exiting main loop.');
          break;
        }
      }
      continue;
    }

    } catch (loopErr) {
      // Catch-all for any uncaught error in the main loop iteration.
      warn(`Unexpected error during attempt ${attempt}:`, loopErr);

      if (isBrowserClosedError(loopErr)) {
        warn('Browser/page closed during attempt. Reconnecting...');
        try {
          ({ browser, context, page } = await reconnectBrowser(config));
          await resumeFromCurrentPage(page, config).catch(() => null);
        } catch (reconnErr) {
          warn('Reconnect failed, will retry:', reconnErr);
          await new Promise(r => setTimeout(r, 10000));
        }
        continue;
      }

      // Non-browser-closed error: save checkpoint and attempt recovery
      saveCheckpoint({
        runId,
        state: 'error_recovery',
        attempt,
        lastError: String(loopErr),
        url: page.url?.() ?? 'unknown',
        timestamp: new Date().toISOString()
      });
      try {
        await resumeFromCurrentPage(page, config);
      } catch (recoveryErr) {
        if (isBrowserClosedError(recoveryErr)) {
          warn('Browser closed during recovery. Reconnecting...');
          try {
            ({ browser, context, page } = await reconnectBrowser(config));
            await resumeFromCurrentPage(page, config).catch(() => null);
          } catch {
            await new Promise(r => setTimeout(r, 10000));
          }
        } else {
          warn('Post-error recovery also failed. Waiting before retry:', recoveryErr);
          await new Promise(r => setTimeout(r, 10000));
        }
      }
      continue;
    }
  }

  clearCheckpoint();
  if (booked) {
    info('Appointment booking completed successfully — OFC + consular both booked.');
  } else {
    info('Appointment booking loop ended. OFC may have been booked but consular stage did not complete. Check logs for details.');
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  error('Fatal error:', msg);
  client('⚠️', `Startup failed: ${msg}`);
  process.exit(1);
});
