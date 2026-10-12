import type { Page, Locator } from 'patchright';
import { info, warn, client } from './logger';

export type DateCell = { date: string; locator: Locator };

const calendarContainerSelector = '#datepicker, .ui-datepicker';
const monthSelectSelector = '.ui-datepicker-month';
const yearSelectSelector = '.ui-datepicker-year';
const dayCellSelector = 'td[data-month][data-year] a.ui-state-default, td[data-month][data-year] span.ui-state-default';
const availableDayCellSelector = 'td:not(.ui-state-disabled) a.ui-state-default, td:not(.ui-state-disabled) span.ui-state-default';

const shortMonthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Normalize a date string to yyyy-mm-dd and trim whitespace. */
function normalizeDate(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const [m, d, y] = trimmed.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return trimmed;
}

export async function waitForCalendarReady(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containerVisible = await page.locator(calendarContainerSelector).count().then((c) => c > 0).catch(() => false);
    const groupVisible = await page.locator('.ui-datepicker-group').count().then((c) => c > 0).catch(() => false);
    const dayVisible = await page.locator(dayCellSelector).count().then((c) => c > 0).catch(() => false);
    if (containerVisible && (groupVisible || dayVisible)) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('Calendar did not become ready within timeout.');
}

export async function selectCalendarMonthYear(page: Page, month: string | number, year: number) {
  let targetMonthIndex = -1;
  if (typeof month === 'number') {
    if (month < 1 || month > 12) {
      throw new Error(`Invalid appointment month: ${month}`);
    }
    targetMonthIndex = month - 1;
  } else {
    const fullMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const target = month.trim().toLowerCase();
    targetMonthIndex = fullMonths.findIndex((m) => m.toLowerCase() === target);
    if (targetMonthIndex === -1) {
      targetMonthIndex = shortMonths.findIndex((m) => m.toLowerCase() === target);
    }
    if (targetMonthIndex === -1) {
      warn(`Unrecognized appointment month string: ${month}; will attempt year selection only.`);
    }
  }

  const targetYear = String(year);
  const { monthSet, yearSet } = await page.evaluate(
    ({ targetMonthIndex, targetYear }) => {
      // NOTE: must be a function declaration, not `const dispatch = () => {}`.
      // tsx/esbuild keepNames wraps named function expressions with __name(),
      // which does not exist in the browser → ReferenceError on evaluate.
      function dispatch(el: HTMLElement) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }

      let monthSet = 0;
      let yearSet = 0;

      document.querySelectorAll<HTMLSelectElement>('.ui-datepicker-month').forEach((select) => {
        if (select.tagName !== 'SELECT') return;
        if (targetMonthIndex >= 0 && targetMonthIndex < select.options.length) {
          select.selectedIndex = targetMonthIndex;
          dispatch(select);
          monthSet += 1;
        }
      });

      document.querySelectorAll<HTMLSelectElement>('.ui-datepicker-year').forEach((select) => {
        if (select.tagName !== 'SELECT') return;
        for (let i = 0; i < select.options.length; i += 1) {
          if ((select.options[i].textContent || '').trim() === targetYear) {
            select.selectedIndex = i;
            dispatch(select);
            yearSet += 1;
            break;
          }
        }
      });

      return { monthSet, yearSet };
    },
    { targetMonthIndex, targetYear }
  );

  if (monthSet === 0 && yearSet === 0) {
    warn('Calendar month/year selectors are not available or values did not match; skipping explicit month/year selection.');
  }
}

export async function getAvailableDates(page: Page) {
  const dayLinks = page.locator(availableDayCellSelector);
  const results = await dayLinks.evaluateAll((nodes) => {
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const shortMonthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return nodes.map((node, index) => {
      const text = (node.textContent || '').trim();
      const day = Number(text);
      if (!Number.isFinite(day) || day < 1 || day > 31) return null;

      const td = node.closest('td');
      const dataMonth = td?.getAttribute('data-month');
      const dataYear = td?.getAttribute('data-year');
      if (dataMonth != null && dataYear != null) {
        const m = Number(dataMonth) + 1;
        const y = Number(dataYear);
        if (Number.isFinite(m) && Number.isFinite(y)) {
          const mm = String(m).padStart(2, '0');
          const dd = String(day).padStart(2, '0');
          return { index, date: `${y}-${mm}-${dd}` };
        }
      }

      const group = node.closest('.ui-datepicker-group');
      if (!group) return null;
      const monthEl = group.querySelector('.ui-datepicker-month');
      const yearEl = group.querySelector('.ui-datepicker-year');
      const monthText = (monthEl?.textContent || '').trim();
      const yearText = (yearEl?.textContent || '').trim();
      if (!monthText || !yearText) return null;

      let monthIndex = -1;
      if (monthEl && monthEl.tagName === 'SELECT') {
        const select = monthEl as HTMLSelectElement;
        monthIndex = select.selectedIndex >= 0 ? select.selectedIndex : -1;
      } else {
        monthIndex = monthNames.findIndex((m) => m.toLowerCase() === monthText.toLowerCase());
        if (monthIndex === -1) {
          monthIndex = shortMonthLabels.findIndex((m) => m.toLowerCase() === monthText.toLowerCase());
        }
      }

      const y = Number(yearText);
      if (monthIndex === -1 || !Number.isFinite(y)) return null;
      const mm = String(monthIndex + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return { index, date: `${y}-${mm}-${dd}` };
    });
  });

  const dates: DateCell[] = [];
  for (const item of results) {
    if (!item) continue;
    const locator = dayLinks.nth(item.index);
    dates.push({ date: item.date, locator });
  }
  return dates;
}

export async function clickCalendarDate(page: Page, dateStr: string) {
  const clicked = await page.evaluate((dateStr) => {
    const target = new Date(dateStr);
    if (Number.isNaN(target.getTime())) {
      return false;
    }

    const day = String(target.getDate());
    const month = target.getMonth() + 1;
    const year = target.getFullYear();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    const groups = Array.from(document.querySelectorAll('.ui-datepicker-group'));
    for (const group of groups) {
      const monthElement = group.querySelector('.ui-datepicker-month');
      const yearElement = group.querySelector('.ui-datepicker-year');

      let groupMonth = null;
      let groupYear = null;

      if (monthElement) {
        if (monthElement.tagName === 'SELECT') {
          groupMonth = Number((monthElement as HTMLSelectElement).value) + 1;
        } else {
          groupMonth = monthNames.indexOf(monthElement.textContent?.trim() || '') + 1;
        }
      }

      if (yearElement) {
        if (yearElement.tagName === 'SELECT') {
          groupYear = Number((yearElement as HTMLSelectElement).value);
        } else {
          groupYear = Number(yearElement.textContent?.trim());
        }
      }

      if (groupYear !== year || groupMonth !== month) {
        continue;
      }

      const cell = Array.from(group.querySelectorAll('a.ui-state-default, span.ui-state-default')).find((element) => element.textContent?.trim() === day);
      if (cell) {
        const mouseDown = new MouseEvent('mousedown', { bubbles: true });
        const mouseUp = new MouseEvent('mouseup', { bubbles: true });
        const click = new MouseEvent('click', { bubbles: true });
        cell.dispatchEvent(mouseDown);
        cell.dispatchEvent(mouseUp);
        cell.dispatchEvent(click);
        (cell as HTMLElement).click();
        return true;
      }
    }

    return false;
  }, dateStr);

  if (!clicked) {
    throw new Error(`Could not find or click calendar date ${dateStr}`);
  }
}

/**
 * Return all green (available) dates within [startDate, endDate], sorted:
 *   preferredDates first (in the order they appear in the array), then by ascending date.
 */
export async function getSortedDatesInRange(
  page: Page,
  startDate: string,
  endDate: string,
  preferredDates: string[] = []
): Promise<DateCell[]> {
  const { inRange } = await getDatesWithAllAvailable(page, startDate, endDate, preferredDates);
  return inRange;
}

/**
 * Single DOM evaluation that returns BOTH:
 *   - allAvailable: every green (available) date on the visible calendar month
 *   - inRange: the subset of allAvailable within [startDate, endDate], sorted
 *
 * This avoids a second `getAvailableDates(page)` DOM call when the caller needs
 * both lists (e.g. for slot-tracker recording). Same single DOM round-trip as
 * getSortedDatesInRange — zero extra cost, zero slowdown to the booking loop.
 */
export async function getDatesWithAllAvailable(
  page: Page,
  startDate: string,
  endDate: string,
  preferredDates: string[] = []
): Promise<{ allAvailable: DateCell[]; inRange: DateCell[] }> {
  const availableDates = await getAvailableDates(page);
  // Always log ALL available dates to client logs whenever the calendar is
  // visible and dates exist — not just the ones that fall in the configured range.
  if (availableDates.length > 0) {
    client('📅', `Calendar available dates (${availableDates.length}): ${availableDates.map(d => d.date).join(', ')}`);
  } else {
    client('📅', 'Calendar visible but no available dates found.');
  }
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  info('Calendar filter range (normalized):', start, 'to', end);
  const candidateDates = availableDates.filter((item) => item.date >= start && item.date <= end);
  info('Calendar candidate dates in range:', candidateDates.map(d => d.date));

  const sortedInRange = candidateDates.sort((a, b) => {
    const aIndex = preferredDates.indexOf(a.date);
    const bIndex = preferredDates.indexOf(b.date);
    if (aIndex !== bIndex) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return a.date.localeCompare(b.date);
  });

  return { allAvailable: availableDates, inRange: sortedInRange };
}

/**
 * Click a specific DateCell (returned from getSortedDatesInRange / getAvailableDates).
 * Falls back to in-page dispatch if the Playwright click fails.
 */
export async function clickDateCell(page: Page, cell: DateCell): Promise<void> {
  try {
    await cell.locator.scrollIntoViewIfNeeded().catch(() => null);
    await cell.locator.click({ force: true }).catch(async () => {
      await clickCalendarDate(page, cell.date);
    });
    info('Selected appointment date', cell.date);
  } catch (err) {
    throw new Error(`Could not select calendar date ${cell.date}: ${err}`);
  }
}

export async function chooseDateInRange(page: Page, startDate: string, endDate: string, preferredDates: string[] = []) {
  const sorted = await getSortedDatesInRange(page, startDate, endDate, preferredDates);
  if (sorted.length === 0) return null;
  await clickDateCell(page, sorted[0]);
  return sorted[0].date;
}
