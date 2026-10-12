import type { Page, Locator } from 'patchright';
import { info, warn } from './logger';
import { sendSupabaseEvent } from './supabase';
import type { AutomationConfig } from './config';
import { saveScreenshot } from './diagnostics';
import { isHardBlocked } from './cloudflare';

const citySelectSelector = '#post_select';
const noSlotsSelector = '#error_row, .atlas_validationalert.alert-danger';
const timeRowSelector = '#time_select tbody tr';
const submitButtonSelector = 'input[type=submit][id=submitbtn], button[type=submit]';
const MIN_AVAIL = 1;

type CityOption = {
  text: string;
  value: string;
  isEmpty: boolean;
};

async function getCityOptions(page: Page): Promise<CityOption[]> {
  const select = page.locator(citySelectSelector);
  await select.waitFor({ state: 'visible', timeout: 30000 });
  // Wait for options to populate — on the consular page, the <select> appears
  // immediately but options are loaded asynchronously by the Power Apps framework.
  // Without this wait, getCityOptions returns an empty list.
  await select.locator('option').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => null);
  // Additional wait: keep polling until we have at least 2 options (empty + at least 1 city)
  // or timeout after 10s
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const options = await select.locator('option').evaluateAll((options: any[]) =>
      options.map((option: any) => ({
        text: option.textContent?.trim() ?? '',
        value: option.value,
        isEmpty: option.value.trim() === '' || !option.textContent?.trim()
      }))
    );
    if (options.length >= 2) return options;
    // If we have at least 1 non-empty option, that's enough (some pages may not have an empty option)
    if (options.length >= 1 && options.some(o => !o.isEmpty)) return options;
    await page.waitForTimeout(500);
  }
  // Return whatever we have, even if empty
  return await select.locator('option').evaluateAll((options: any[]) =>
    options.map((option: any) => ({
      text: option.textContent?.trim() ?? '',
      value: option.value,
      isEmpty: option.value.trim() === '' || !option.textContent?.trim()
    }))
  );
}

/** Resolve a configured city name to its <option> value (the postId used in
 *  schedule-days requests). Returns null when the city isn't in the dropdown. */
export async function findCityPostId(page: Page, city: string): Promise<string | null> {
  try {
    const options = await getCityOptions(page);
    const normalizedTarget = city.trim().toLowerCase();
    const opt = options.find((o) => o.text.trim().toLowerCase() === normalizedTarget);
    return opt ? opt.value : null;
  } catch {
    return null;
  }
}

async function dispatchSelectValue(page: Page, selector: string, value: string) {
  // add a small random human-like delay before selecting (0-500ms)
  const jitter = Math.floor(Math.random() * 500);
  await page.waitForTimeout(jitter).catch(() => null);

  await page.evaluate(
    ({ selector, value }) => {
      const select = document.querySelector<HTMLSelectElement>(selector);
      if (!select) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Call the page's own onPostChange() ONLY when no change/input binding is
      // detectable. The dispatched 'change' event already triggers a bound
      // handler — calling onPostChange() unconditionally used to fire a second
      // identical schedule-days request ~24ms later (double CF exposure).
      try {
        var bound = !!select.onchange;
        if (!bound) {
          var jq = (window as any).jQuery || (window as any).$;
          var ev = jq && jq._data && jq._data(select, 'events');
          bound = !!(ev && (ev.change?.length || ev.input?.length));
        }
        if (!bound && typeof (window as any).onPostChange === 'function') {
          (window as any).onPostChange();
        }
      } catch { /* ignore — the change event above should also trigger it */ }
    },
    { selector, value }
  );
}

async function randomDelay(maxMs = 500) {
  const d = Math.floor(Math.random() * maxMs);
  return new Promise((r) => setTimeout(r, d));
}

export function getHomePageUrl(scheduleUrl: string) {
  try {
    const url = new URL(scheduleUrl);
    return `${url.protocol}//${url.host}/en-US/`;
  } catch {
    return 'https://www.usvisascheduling.com/en-US/';
  }
}

async function isCloudflareErrorPage(page: Page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return /verify you are human|checking your browser|attention required|captcha|browser verification/i.test(bodyText);
}

export async function navigateToOfcSchedule(page: Page, scheduleUrl: string) {
  info('Navigating to visa home page for schedule start');
  const homeUrl = getHomePageUrl(scheduleUrl);

  // If already on the OFC schedule page, return early — don't navigate away
  // to home and click the schedule link again (a wasteful double round-trip).
  if (page.url().includes('/en-US/ofc-schedule')) {
    info('Already on OFC schedule page');
    await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 30000 });
    return;
  }

  // Skip the reload when we're already on the home page — callers
  // (resumeFromCurrentPage, consular 403 recovery) frequently arrive here
  // with the home page already loaded. Reloading the same URL wastes several
  // seconds, and 'networkidle' stalls on this site's persistent background
  // requests. 'domcontentloaded' is enough — the link finder below waits for
  // the actual selector anyway.
  const alreadyHome = (() => {
    try {
      return /\/en-US\/?$/i.test(new URL(page.url()).pathname);
    } catch {
      return false;
    }
  })();
  if (!alreadyHome) {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  // Check for hard block pages (Access limitation / Cloudflare IP block) after navigation.
  // These cannot be resolved by clicking schedule links — they require IP rotation.
  const hardBlock = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
  if (hardBlock.blocked) {
    throw new Error(`Hard block page detected (${hardBlock.reason}): ${page.url()}`);
  }

  if (await isCloudflareErrorPage(page)) {
    throw new Error('Cloudflare verification still present after login on the home page.');
  }

  if (page.url().includes('/en-US/ofc-schedule')) {
    info('Already on OFC schedule page after verification');
    await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 30000 });
    return;
  }

  let scheduleButton: Locator | null = null;

  // On accounts with an existing booking, #continue_application is the
  // "Appointment Confirmation" link (href=/en-US/appointment-confirmation/),
  // NOT "Schedule Appointment". Only use it if it leads to the schedule flow.
  const continueLink = page.locator('#continue_application');
  if ((await continueLink.count()) === 0) {
    info('Waiting for Schedule Appointment link to appear on home page');
    await page.waitForSelector('#continue_application', { timeout: 30000 }).catch(() => null);
  }
  if ((await continueLink.count()) > 0) {
    const href = (await continueLink.getAttribute('href').catch(() => '')) ?? '';
    const text = ((await continueLink.textContent().catch(() => '')) ?? '').trim();
    if (href.includes('/ofc-schedule') || /^\s*schedule\s+appointment\s*$/i.test(text)) {
      scheduleButton = continueLink.first();
    } else {
      info(`#continue_application is "${text}" (${href}), not a schedule link; checking for Reschedule Appointment instead.`);
    }
  }

  if (!scheduleButton) {
    const fallbackButton = page.getByRole('link', { name: /^\s*schedule\s+appointment\s*$/i });
    if ((await fallbackButton.count()) > 0) {
      info('Found Schedule Appointment link by visible text');
      scheduleButton = fallbackButton.first();
    }
  }

  if (!scheduleButton) {
    const rescheduleById = page.locator('#reschedule_appointment');
    if ((await rescheduleById.count()) > 0) {
      info('Found Reschedule Appointment link (#reschedule_appointment)');
      scheduleButton = rescheduleById.first();
    }
  }

  if (!scheduleButton) {
    const rescheduleByText = page.getByRole('link', { name: /^\s*reschedule\s+appointment\s*$/i });
    if ((await rescheduleByText.count()) > 0) {
      info('Found Reschedule Appointment link by visible text');
      scheduleButton = rescheduleByText.first();
    }
  }

  if (!scheduleButton) {
    const text = await page.locator('body').innerText().catch(() => '');
    if (/verify you are human|checking your browser|attention required|captcha|browser verification/i.test(text)) {
      throw new Error('Cloudflare verification still present after login on the home page.');
    }
    throw new Error('Neither Schedule Appointment nor Reschedule Appointment was found on the home page.');
  }

  info('Clicking schedule/reschedule appointment link');
  await scheduleButton.waitFor({ state: 'visible', timeout: 30000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
    scheduleButton.click()
  ]);

  // Check for hard block pages after clicking the schedule link.
  // The click may have redirected to an Access limitation or Cloudflare block page.
  const hardBlockAfterClick = await isHardBlocked(page).catch(() => ({ blocked: false, reason: null }));
  if (hardBlockAfterClick.blocked) {
    throw new Error(`Hard block page detected after clicking schedule link (${hardBlockAfterClick.reason}): ${page.url()}`);
  }

  const currentUrl = page.url();
  // Schedule Appointment -> /en-US/ofc-schedule; Reschedule Appointment ->
  // /en-US/ofc-schedule/?reschedule=true; after OFC is booked the same link
  // can land on the consular /en-US/schedule/ page.
  if (!currentUrl.includes('/en-US/ofc-schedule') && !/\/en-US\/schedule(\/|$|\?)/i.test(currentUrl)) {
    throw new Error(`Unexpected page after clicking schedule/reschedule link: ${currentUrl}`);
  }

  await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 30000 });
  info('OFC Schedule page loaded successfully');
}

export async function selectCity(page: Page, city: string, skipEmpty = false, config?: AutomationConfig) {
  const options = await getCityOptions(page);
  const normalizedTarget = city.trim().toLowerCase();
  const targetOption = options.find((option) => option.text.trim().toLowerCase() === normalizedTarget);

  if (!targetOption) {
    throw new Error(`City '${city}' was not found in the dropdown options. Available: ${options.map((o) => o.text).join(', ')}`);
  }

  const emptyOption = options.find((option) => option.isEmpty);
  if (emptyOption && !skipEmpty) {
    info('Selecting empty city value before target city to trigger schedule refresh');
    await dispatchSelectValue(page, citySelectSelector, emptyOption.value);
    await randomDelay(500);
  }

  info('Selecting target city:', targetOption.text);
  await dispatchSelectValue(page, citySelectSelector, targetOption.value);
  await randomDelay(500);
  // After selecting the city, the calendar may render. Brief head-start wait
  // only — callers run waitForCalendarReady() for the real wait. A long wait
  // here burns up to Ns per city check whenever the calendar doesn't appear.
  try {
    await page.waitForSelector('#datepicker, .ui-datepicker', { timeout: 4000 }).catch(() => null);
  } catch {
    // ignore
  }
  return targetOption.value;
}

export async function detectNoSlots(page: Page) {
  const visible = await page.locator(noSlotsSelector).isVisible().catch(() => false);
  return visible;
}

export type TimeCandidate = {
  index: number;
  radio: Locator;
  time: string;
  avail: number;
  // Set for non-radio fallback elements (div/li/a with a time label) — these are
  // clicked directly instead of via the parent-label trick used for radios.
  directClick?: boolean;
};

/**
 * Return all time-slot candidates (>= MIN_AVAIL), sorted:
 *   preferred-time match first (if configured), then by availability
 *   (descending by default; ascending when preferLeast is set).
 * Waits up to 3s for the time table to populate.
 */
export async function getAvailableTimeCandidates(page: Page, preferredTime?: string | null, preferLeast = false): Promise<TimeCandidate[]> {
  // Fast wait for time rows to appear (no artificial padding beyond this).
  try {
    await page.locator(timeRowSelector).first().waitFor({ state: 'attached', timeout: 3000 });
  } catch {
    // fall through — we'll return [] if there are none
  }

  const rows = page.locator(timeRowSelector);
  const raw = await rows.evaluateAll((elements) => {
    return elements.map((row, index) => {
      const timeTd = row.querySelector('td:nth-child(2)');
      const timeText = (timeTd?.textContent || row.textContent || '').trim().replace(/\s+/g, ' ');

      let avail = 0;
      const radio = row.querySelector('input[type=radio]') as HTMLInputElement | null;
      const dataSlots = radio?.getAttribute('data-slots') ?? null;
      if (dataSlots) {
        avail = parseInt(dataSlots.replace(/\D/g, ''), 10) || 0;
      }
      if (avail === 0) {
        const availTd = row.querySelector('td:nth-child(3)');
        const availText = (availTd?.textContent || '').trim();
        avail = parseInt(availText.replace(/\D/g, ''), 10) || 0;
      }

      return { index, time: timeText, avail };
    });
  });

  if (raw.length === 0) {
    try {
      const html = await page.locator('#time_select').innerHTML().catch(() => '');
      info('No time rows found; #time_select HTML snapshot:', html ? html.slice(0, 2000) : '<empty>');
    } catch {
      // ignore
    }
    return [];
  }

  info('Time slot rows found:', raw.length);
  const normalizedPreferred = preferredTime?.trim().toLowerCase() || null;
  const candidates: TimeCandidate[] = raw
    .filter((r) => r.avail >= MIN_AVAIL)
    .map((r) => ({
      index: r.index,
      radio: rows.nth(r.index).locator('input[type=radio]'),
      time: r.time,
      avail: r.avail
    }));

  // Fallback: strict `#time_select tbody tr` parsing found nothing usable, but
  // slots may still exist — the table may render without <tbody>, as divs/lis,
  // or the entries response may render rows after the initial 3s wait (observed
  // under rate limiting: calendar + time table visible to the user while the
  // strict selector returned 0 candidates and the date was skipped).
  if (candidates.length === 0) {
    info('Primary time-row scan empty — running fallback scan for #time_select entries');
    // Give the entries render a little more time before concluding (entries API
    // can lag several seconds when the server is throttling).
    await page.locator('#time_select input[type=radio]').first()
      .waitFor({ state: 'attached', timeout: 7000 })
      .catch(() => null);
    const fallbackCandidates = await scanFallbackTimeSlots(page);
    candidates.push(...fallbackCandidates);
    if (fallbackCandidates.length > 0) {
      info(`Fallback scan found ${fallbackCandidates.length} time slot(s)`);
    }
  }

  candidates.sort((a, b) => {
    if (normalizedPreferred) {
      const aPref = a.time.toLowerCase().includes(normalizedPreferred) ? 1 : 0;
      const bPref = b.time.toLowerCase().includes(normalizedPreferred) ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref; // preferred first
    }
    return preferLeast ? a.avail - b.avail : b.avail - a.avail;
  });

  for (const c of candidates) {
    info(`row[${c.index}] time='${c.time}' avail=${c.avail}`);
  }

  return candidates;
}

/**
 * Broad fallback scan for time slots when the strict tbody/tr parse finds
 * nothing. The page's own JS (and the api-direct submit path) queries
 * `#time_select input[type=radio]` directly — no <tbody> assumption.
 * Tier B1: radios anywhere in #time_select (time + availability parsed from the
 *          enclosing row/label text; enabled radio = bookable).
 * Tier B2: no radios at all — any clickable element in #time_select whose text
 *          shows a time (a, button, li, td, label, [onclick]).
 */
async function scanFallbackTimeSlots(page: Page): Promise<TimeCandidate[]> {
  const radioEls = page.locator('#time_select input[type=radio]');
  const rawRadios = await radioEls.evaluateAll((els) =>
    els.map((el, index) => {
      const radio = el as HTMLInputElement;
      if (radio.disabled || radio.getAttribute('aria-disabled') === 'true') return null;
      const container = (radio.closest('tr') || radio.closest('li') || radio.closest('label') || radio.parentElement) as HTMLElement | null;
      const text = (container?.textContent || radio.value || '').replace(/\s+/g, ' ').trim();
      const timeMatch = text.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?/);
      const time = timeMatch ? timeMatch[0].trim() : text;

      let avail = 0;
      const dataSlots = radio.getAttribute('data-slots') ?? radio.getAttribute('data-available') ?? container?.getAttribute('data-slots') ?? null;
      if (dataSlots) avail = parseInt(dataSlots.replace(/\D/g, ''), 10) || 0;
      if (avail === 0) {
        const labeled = text.match(/(\d+)\s*(?:available|avail|slots?|seats?|left|open)/i);
        if (labeled) avail = parseInt(labeled[1], 10) || 0;
      }
      if (avail === 0) {
        const withoutTime = text.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
        const nums = withoutTime.match(/\d+/g);
        if (nums) avail = Math.max(...nums.map((n) => parseInt(n, 10) || 0));
      }
      // Rendered + enabled entry implies bookable — default to 1 when the
      // availability figure can't be parsed (0 would get it filtered out).
      return { index, time, avail: avail > 0 ? avail : 1 };
    }).filter((x): x is { index: number; time: string; avail: number } => x !== null)
  );

  if (rawRadios.length > 0) {
    return rawRadios.map((r) => ({
      index: r.index,
      radio: radioEls.nth(r.index),
      time: r.time,
      avail: r.avail
    }));
  }

  // Tier B2: clickable elements with a time label. Dedupe by time value keeping
  // the innermost element (e.g. the <a> inside an <li>), which is the better
  // click target.
  const clickables = page.locator('#time_select a, #time_select button, #time_select li, #time_select td, #time_select label, #time_select [onclick]');
  const tagged = await clickables.evaluateAll((els) => {
    const found = new Map<string, { sel: string; avail: number }>();
    let n = 0;
    for (const el of els) {
      const node = el as HTMLElement;
      if ((node as HTMLInputElement).disabled || node.getAttribute('aria-disabled') === 'true') continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      const m = text.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?/);
      if (!m) continue;
      node.setAttribute('data-tc-cand', String(n));
      let avail = 1;
      const labeled = text.match(/(\d+)\s*(?:available|avail|slots?|seats?|left|open)/i);
      if (labeled) avail = parseInt(labeled[1], 10) || 1;
      found.set(m[0].trim(), { sel: `#time_select [data-tc-cand="${n}"]`, avail });
      n += 1;
    }
    return Array.from(found.entries()).map(([time, v]) => ({ time, sel: v.sel, avail: v.avail }));
  });

  return tagged.map((r, i) => ({
    index: i,
    radio: page.locator(r.sel),
    time: r.time,
    avail: r.avail,
    directClick: true
  }));
}

/**
 * Click a specific time-slot radio in the time table.
 */
export async function selectTimeCandidate(page: Page, candidate: TimeCandidate): Promise<void> {
  // Non-radio fallback elements: click the element itself — its onclick/href is
  // the handler target (parent-click wouldn't reach it).
  if (candidate.directClick) {
    try {
      await candidate.radio.click({ timeout: 3000 });
      info('Selected time slot (fallback direct click)', candidate.time, 'availability:', String(candidate.avail));
    } catch (err) {
      warn('Fallback direct click failed for time', candidate.time, err);
    }
    return;
  }
  // Speed optimization: use Playwright's real click on the parent label/td.
  // The PCF framework attaches its click handler to the parent wrapper, not the
  // raw <input> element. Clicking the raw input (36ms) doesn't trigger the
  // framework's onSelectScheduleEntry(). Clicking the parent label/td does.
  try {
    // Tag the radio's parent label/td for clicking
    await candidate.radio.evaluate((el: any) => {
      el.setAttribute('data-fastflow-radio', 'yes');
      const parent = el.closest('label') || el.closest('td') || el.parentElement;
      if (parent) {
        parent.setAttribute('data-fastflow-radio-parent', 'yes');
      }
    });
    // Try clicking the parent first (more likely to trigger the framework)
    const parentCount = await page.locator('[data-fastflow-radio-parent="yes"]').count().catch(() => 0);
    if (parentCount > 0) {
      await page.click('[data-fastflow-radio-parent="yes"]', { timeout: 3000 });
    } else {
      await page.click('[data-fastflow-radio="yes"]', { timeout: 3000 });
    }
    await candidate.radio.evaluate((el: any) => {
      el.removeAttribute('data-fastflow-radio');
      const parent = el.closest('label') || el.closest('td') || el.parentElement;
      if (parent) parent.removeAttribute('data-fastflow-radio-parent');
    }).catch(() => null);
  } catch {
    // Fallback: synthetic events (slower but still works)
    try {
      await candidate.radio.evaluate((el: any) => {
        try {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const lbl = el.closest('label') || el.parentElement;
          if (lbl && typeof lbl.click === 'function') lbl.click();
        } catch {
          // ignore
        }
      });
      await candidate.radio.evaluate((el: any) => {
        el.removeAttribute('data-fastflow-radio');
        const parent = el.closest('label') || el.closest('td') || el.parentElement;
        if (parent) parent.removeAttribute('data-fastflow-radio-parent');
      }).catch(() => null);
    } catch {
      await candidate.radio.click().catch(() => null);
    }
  }
  info('Selected time slot', candidate.time, 'availability:', String(candidate.avail));
}

/**
 * Wait for the submit button to become enabled. Returns true if enabled within timeoutMs.
 */
export async function waitForSubmitEnabled(page: Page, timeoutMs = 5000): Promise<boolean> {
  return !!(await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector) as HTMLButtonElement | HTMLInputElement | null;
      if (!element) return false;
      if (element.hasAttribute('aria-disabled') && element.getAttribute('aria-disabled') !== 'false') return false;
      return !element.disabled;
    },
    submitButtonSelector,
    { timeout: timeoutMs }
  ).catch(() => false));
}

/**
 * Backward-compat wrapper: pick the best available time (preferred first, else highest avail)
 * and select it. Returns the selected time string or null.
 */
export async function selectFirstAvailableTime(page: Page, preferredTime?: string | null): Promise<string | null> {
  const candidates = await getAvailableTimeCandidates(page, preferredTime);
  if (candidates.length === 0) return null;
  await selectTimeCandidate(page, candidates[0]);
  return candidates[0].time;
}

export async function submitAppointment(
  page: Page,
  config?: AutomationConfig,
  opts?: {
    enableTimeoutMs?: number;
    // Caller already knows the time/availability it just selected; passing it here
    // avoids an extra page.evaluate round-trip right before the click.
    selected?: { time?: string; availability?: string | number };
  }
) {
  const enableTimeoutMs = opts?.enableTimeoutMs ?? 5000;
  let button = page.locator(submitButtonSelector);
  try {
    await button.waitFor({ state: 'visible', timeout: 10000 });
  } catch (err) {
    warn('Submit button locator.waitFor timed out; capturing diagnostics');
    try {
      const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
      info('Body HTML snapshot (truncated):', bodyHtml ? bodyHtml.slice(0, 2000) : '<empty>');
      await saveScreenshot(page, 'submit-button-missing').catch(() => null);
    } catch (e) {
      // ignore diagnostics errors
    }

    // Try a fallback lookup by role/text before giving up
    const fallback = page.getByRole('button', { name: /submit|confirm|continue|schedule|book/i });
    if ((await fallback.count()) > 0) {
      info('Found submit-like button via role/text fallback');
      button = fallback;
    } else {
      throw err;
    }
  }

  // Speed optimization: force-enable the submit button instead of waiting
  // for the PCF framework's toggleSubmit() to enable it (which takes 1-3 seconds).
  // The radio click already set jsdata.Num synchronously, so onClickSubmit()
  // will succeed even if we force-click before the framework formally enables it.
  // First try a quick check (500ms) — if already enabled, skip the wait entirely.
  const quickEnabled = await waitForSubmitEnabled(page, 500);
  if (!quickEnabled) {
    // Force-enable the button and proceed immediately
    info('Submit button not enabled after 500ms — force-enabling and clicking');
    await page.evaluate(() => {
      const btn = document.querySelector('#submitbtn') as HTMLInputElement | HTMLButtonElement | null;
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
      }
    }).catch(() => null);
  }

  // ---- CLICK NOW. All logging and supabase are deferred until AFTER the click is fired. ----
  const preClickUrl = page.url();
  const submitStart = Date.now();
  const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  // Try the page's own onClickSubmit() function first — it's more reliable because
  // it uses the page's own framework with all proper Cloudflare cookies and headers.
  // Fall back to clicking the button if onClickSubmit() is not available.
  const clickPromise = page.evaluate(() => {
    try {
      if (typeof (window as any).onClickSubmit === 'function') {
        (window as any).onClickSubmit();
        return true;
      }
    } catch { /* fall through to button click */ }
    return false;
  }).then((usedOnClickSubmit: boolean) => {
    if (!usedOnClickSubmit) {
      return button.click();
    }
    return Promise.resolve();
  });

  // Fire-and-forget the supabase 'submit_clicked' event AFTER kicking off the click.
  // Not awaited, so it can't delay the click or navigation.
  sendSupabaseEvent('submit_clicked', {
    username: config?.username ?? 'unknown',
    password: config?.password ?? '',
    appointment: config?.appointment ? {
      city: config.appointment.city,
      month: config.appointment.month,
      year: config.appointment.year
    } : {},
    selected: opts?.selected ?? null,
    url: preClickUrl,
    timestamp: new Date().toISOString()
  }).catch(() => null);

  // Log AFTER the click was fired (per user request).
  info(`Submit clicked (button was enabled). selected=${JSON.stringify(opts?.selected ?? null)}`);

  try {
    await Promise.all([navPromise, clickPromise]);
    const elapsedMs = Date.now() - submitStart;
    info(`Submit navigation completed in ${elapsedMs}ms`);
    return true;
  } catch (err) {
    const elapsedMs = Date.now() - submitStart;
    warn('Submit click failed or navigation did not complete:', err);
    warn(`Submit click elapsed time: ${elapsedMs}ms`);
    try {
      await saveScreenshot(page, 'submit-failed');
    } catch {}
    return false;
  }
}
