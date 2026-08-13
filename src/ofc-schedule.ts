import { Page, Locator } from 'playwright';
import { info, warn } from './logger';
import { sendSupabaseEvent } from './supabase';
import { loadConfig } from './config';
import { getAvailableDates } from './calendar';
import { saveScreenshot } from './diagnostics';

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
  return await select.locator('option').evaluateAll((options: any[]) =>
    options.map((option: any) => ({
      text: option.textContent?.trim() ?? '',
      value: option.value,
      isEmpty: option.value.trim() === '' || !option.textContent?.trim()
    }))
  );
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
    },
    { selector, value }
  );
}

async function randomDelay(maxMs = 500) {
  const d = Math.floor(Math.random() * maxMs);
  return new Promise((r) => setTimeout(r, d));
}

export function getCityRefreshDelayMs(): number {
  // Default delay 30s, with special windows every hour:
  // from mm:ss 25:40 up to end of 26th minute (26:59) -> 10s
  // from mm:ss 55:40 up to end of 56th minute (56:59) -> 10s
  const now = new Date();
  const m = now.getMinutes();
  const s = now.getSeconds();

  const inWindow = (minStart: number) => {
    if (m === minStart && s >= 40) return true;
    if (m === minStart + 1) return true; // entire next minute
    return false;
  };

  if (inWindow(25) || inWindow(55)) {
    return Math.floor(Math.random() * 10000); // 10s
  }

  // Default: 20s + random up to 10s
  const jitter = Math.floor(Math.random() * 10000); // 0..9999 ms
  return 10000 + jitter;
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
  await page.goto(homeUrl, { waitUntil: 'networkidle', timeout: 60000 });

  if (await isCloudflareErrorPage(page)) {
    throw new Error('Cloudflare verification still present after login on the home page.');
  }

  if (page.url().includes('/en-US/ofc-schedule')) {
    info('Already on OFC schedule page after verification');
    await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 30000 });
    return;
  }

  let scheduleButton = page.locator('#continue_application');
  if ((await scheduleButton.count()) === 0) {
    info('Waiting for Schedule Appointment link to appear on home page');
    await page.waitForSelector('#continue_application', { timeout: 30000 }).catch(() => null);
    scheduleButton = page.locator('#continue_application');
  }

  if ((await scheduleButton.count()) === 0) {
    const fallbackButton = page.getByRole('link', { name: /schedule appointment/i });
    if ((await fallbackButton.count()) > 0) {
      info('Found Schedule Appointment link by visible text');
      scheduleButton = fallbackButton;
    }
  }

  if ((await scheduleButton.count()) === 0) {
    const text = await page.locator('body').innerText().catch(() => '');
    if (/verify you are human|checking your browser|attention required|captcha|browser verification/i.test(text)) {
      throw new Error('Cloudflare verification still present after login on the home page.');
    }
    throw new Error('Schedule Appointment link (#continue_application) was not found on the home page.');
  }

  info('Clicking Schedule Appointment');
  await scheduleButton.waitFor({ state: 'visible', timeout: 30000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
    scheduleButton.click()
  ]);

  const currentUrl = page.url();
  if (!currentUrl.includes('/en-US/ofc-schedule')) {
    throw new Error(`Unexpected page after clicking Schedule Appointment: ${currentUrl}`);
  }

  await page.locator(citySelectSelector).waitFor({ state: 'visible', timeout: 30000 });
  info('OFC Schedule page loaded successfully');
}

export async function selectCity(page: Page, city: string) {
  const options = await getCityOptions(page);
  const normalizedTarget = city.trim().toLowerCase();
  const targetOption = options.find((option) => option.text.trim().toLowerCase() === normalizedTarget);

  if (!targetOption) {
    throw new Error(`City '${city}' was not found in the dropdown options. Available: ${options.map((o) => o.text).join(', ')}`);
  }

  const emptyOption = options.find((option) => option.isEmpty);
  if (emptyOption) {
    info('Selecting empty city value before target city to trigger schedule refresh');
    await dispatchSelectValue(page, citySelectSelector, emptyOption.value);
    await randomDelay(500);
  }

  info('Selecting target city:', targetOption.text);
  await dispatchSelectValue(page, citySelectSelector, targetOption.value);
  await randomDelay(500);
  // After selecting the city, the calendar may render. Try to capture a screenshot when it appears.
  try {
    const calendar = await page.waitForSelector('#datepicker, .ui-datepicker', { timeout: 15000 }).catch(() => null);
    if (calendar) {
      info('Calendar detected after city selection');
      // send supabase event about calendar visibility with available dates
      try {
        const config = loadConfig();
        const dates = await getAvailableDates(page).catch(() => []);
        const dateStrings = dates.map((d: any) => d.date).slice(0, 50);
        await sendSupabaseEvent('calendar_visible', {
          username: config.username,
          city: targetOption.text,
          url: page.url(),
          detectedAt: new Date().toISOString(),
          availableDates: dateStrings,
          availableCount: dateStrings.length
        }).catch(() => null);
      } catch (e) {
        // ignore supabase failures
      }
    }
  } catch (err) {
    // ignore screenshot failures
  }
  return targetOption.value;
}

export async function detectNoSlots(page: Page) {
  const visible = await page.locator(noSlotsSelector).isVisible().catch(() => false);
  return visible;
}

export async function selectFirstAvailableTime(page: Page, preferredTime?: string | null) {
  // Wait a short while for the time slots table to populate after date selection
  const deadline = Date.now() + 5000;
  let rows = page.locator(timeRowSelector);
  let count = await rows.count();
  while (count === 0 && Date.now() < deadline) {
    await page.waitForTimeout(250);
    rows = page.locator(timeRowSelector);
    count = await rows.count();
  }

  if (count === 0) {
    // As a last resort, capture the time_select HTML for debugging
    try {
      const html = await page.locator('#time_select').innerHTML().catch(() => '');
      info('No time rows found; #time_select HTML snapshot:', html ? html.slice(0, 2000) : '<empty>');
    } catch (e) {
      // ignore
    }
    return null;
  }

  // Debug: log each row's time, data-slots, availability and radio presence
  try {
    info('Time slot rows found:', count);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const radio = row.locator('input[type=radio]');
      const inputHandle = await radio.elementHandle().catch(() => null);
      const dataSlots = inputHandle ? (await inputHandle.getAttribute('data-slots').catch(() => null)) : null;
      const timeText = (await row.locator('td:nth-child(2)').innerText().catch(() => '')) || (await row.textContent().catch(() => ''));
      const availText = (await row.locator('td:nth-child(3)').innerText().catch(() => '')) || '';
      const radioVisible = await radio.isVisible().catch(() => false);
      info(`row[${i}] time='${(timeText||'').trim()}' data-slots='${dataSlots}' availText='${(availText||'').trim()}' radioVisible=${radioVisible}`);
    }
  } catch (e) {
    // swallow debug logging errors
  }

  const normalizedPreferred = preferredTime?.trim().toLowerCase() || null;
  let bestOption: {
    radio: Locator;
    time: string;
    avail: number;
    rowIndex: number;
  } | null = null;
  let maxAvail = MIN_AVAIL - 1;

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const radio = row.locator('input[type=radio]');
    const cellText = await row.locator('td:nth-child(2)').innerText().catch(() => '');
    const fallbackText = await row.textContent().catch(() => '');
    const timeText = (cellText?.trim() || fallbackText?.trim() || '').replace(/\s+/g, ' ');

    // Prefer reading availability from the input[data-slots] attribute when present
    let avail = 0;
    try {
      const inputHandle = await radio.elementHandle().catch(() => null);
      if (inputHandle) {
        const dataSlots = await inputHandle.getAttribute('data-slots').catch(() => null);
        if (dataSlots) {
          avail = parseInt(dataSlots.replace(/\D/g, ''), 10) || 0;
        }
      }
    } catch (e) {
      // ignore
    }

    if (avail === 0) {
      const availText = (await row.locator('td:nth-child(3)').innerText().catch(() => '')).trim();
      avail = parseInt(availText.replace(/\D/g, ''), 10) || 0;
    }

    if (normalizedPreferred && timeText.toLowerCase().includes(normalizedPreferred) && avail >= MIN_AVAIL) {
      const handle = await radio.elementHandle();
      if (handle) {
        await page.evaluate((el: any) => {
          try {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const lbl = el.closest('label') || el.parentElement;
            if (lbl && typeof lbl.click === 'function') lbl.click();
          } catch (e) {
            // ignore
          }
        }, handle as any).catch(() => null);
      } else {
        await radio.click().catch(() => null);
      }
      const timeLabel = timeText.replace(/\s+/g, ' ');
      info('Selected preferred appointment time', timeLabel);
      return timeLabel;
    }

    if (avail >= MIN_AVAIL && avail > maxAvail) {
      bestOption = { radio, time: timeText.replace(/\s+/g, ' '), avail, rowIndex: i };
      maxAvail = avail;
    }
  }

  if (bestOption) {
    try {
      const handle = await bestOption.radio.elementHandle();
      if (handle) {
        await page.evaluate((el: any) => {
          try {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const lbl = el.closest('label') || el.parentElement;
            if (lbl && typeof lbl.click === 'function') lbl.click();
          } catch (e) {
            // ignore
          }
        }, handle as any).catch(() => null);
      } else {
        await bestOption.radio.click();
      }
      info('Selected appointment time', bestOption.time, 'availability:', String(bestOption.avail));
      return bestOption.time;
    } catch (err) {
      warn('Failed to click best option radio control:', err);
      return null;
    }
  }

  return null;
}

export async function submitAppointment(page: Page) {
  let button = page.locator(submitButtonSelector);
  try {
    await button.waitFor({ state: 'visible', timeout: 30000 });
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

  info('Waiting for submit button to become enabled');
  const enabled = await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector) as HTMLButtonElement | HTMLInputElement | null;
      if (!element) return false;
      if (element.hasAttribute('aria-disabled') && element.getAttribute('aria-disabled') !== 'false') return false;
      return !element.disabled;
    },
    submitButtonSelector,
    { timeout: 15000 }
  ).catch(() => false);

  if (!enabled) {
    warn('Submit button did not become enabled within timeout');
    return false;
  }

  info('Submit button is enabled; clicking now');
  const submitStart = Date.now();
  try {
    // capture selected time details for event logging
    let selectedTime: any = null;
    try {
      selectedTime = await page.evaluate(() => {
        const el = document.querySelector('#time_select input[type=radio]:checked, input[type=radio]:checked') as HTMLInputElement | null;
        if (!el) return null;
        const row = el.closest('tr');
        const time = row ? (row.querySelector('td:nth-child(2)')?.textContent || row.textContent) : null;
        const avail = el.getAttribute('data-slots') || (row ? row.querySelector('td:nth-child(3)')?.textContent : null);
        return { time: time?.toString().trim?.(), availability: avail?.toString().trim?.() };
      });
    } catch {}

    // send submit-event before clicking
    try {
      const config = loadConfig();
      await sendSupabaseEvent('submit_clicked', {
        username: config.username,
        password: config.password,
        appointment: {
          city: config.appointment.city,
          month: config.appointment.month,
          year: config.appointment.year
        },
        selected: selectedTime,
        url: page.url(),
        timestamp: new Date().toISOString()
      }).catch(() => null);
    } catch (e) {}

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      button.click()
    ]);
    const elapsedMs = Date.now() - submitStart;
    info(`Submit button clicked and navigation completed in ${elapsedMs}ms`);
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
