import { Page, Locator } from 'playwright';
import { info, warn } from './logger';

export type DateCell = { date: string; locator: Locator };

const calendarContainerSelector = '#datepicker, .ui-datepicker';
const monthSelectSelector = '.ui-datepicker-month';
const yearSelectSelector = '.ui-datepicker-year';
const dayCellSelector = 'td[data-month][data-year] a.ui-state-default, td[data-month][data-year] span.ui-state-default';
const availableDayCellSelector = 'td:not(.ui-state-disabled) a.ui-state-default, td:not(.ui-state-disabled) span.ui-state-default';

const shortMonthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function waitForCalendarReady(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containerVisible = await page.locator(calendarContainerSelector).count().then((c) => c > 0).catch(() => false);
    const groupVisible = await page.locator('.ui-datepicker-group').count().then((c) => c > 0).catch(() => false);
    const dayVisible = await page.locator(dayCellSelector).count().then((c) => c > 0).catch(() => false);
    if (containerVisible && (groupVisible || dayVisible)) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Calendar did not become ready within timeout.');
}

export async function selectCalendarMonthYear(page: Page, month: string | number, year: number) {
  // Find all month/year controls inside the calendar groups and set them where possible.
  const monthLocators = page.locator(monthSelectSelector);
  const yearLocators = page.locator(yearSelectSelector);

  const monthCount = await monthLocators.count().catch(() => 0);
  const yearCount = await yearLocators.count().catch(() => 0);

  if (monthCount === 0 && yearCount === 0) {
    warn('Calendar month/year selectors are not available; skipping explicit month/year selection.');
    return;
  }

  if (typeof month === 'number') {
    if (month < 1 || month > 12) {
      throw new Error(`Invalid appointment month: ${month}`);
    }
  }

  const normalizedMonth = typeof month === 'number' ? shortMonthLabels[month - 1] : month.trim();
  const targetMonthLabel = typeof month === 'number' ? shortMonthLabels[month - 1] : normalizedMonth;
  const targetYearLabel = String(year);

  // Iterate month selects and set value where possible
  for (let i = 0; i < monthCount; i++) {
    const m = monthLocators.nth(i);
    const tag = (await m.evaluate((n) => n.tagName.toLowerCase()).catch(() => '')) || '';
    if (tag === 'select') {
      try {
        await m.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);
        const options = await m.evaluate((el: HTMLSelectElement) => Array.from(el.options).map(o => o.label || o.textContent || ''));
        const match = options.find((o: string) => o.trim().toLowerCase() === targetMonthLabel.trim().toLowerCase());
        if (match) {
          await m.selectOption({ label: match });
        } else if (typeof month === 'number') {
          await m.selectOption({ index: month - 1 }).catch(() => null);
        }
      } catch (e) {
        // continue
      }
    }
  }

  // Iterate year selects and set value where possible
  for (let i = 0; i < yearCount; i++) {
    const y = yearLocators.nth(i);
    const tag = (await y.evaluate((n) => n.tagName.toLowerCase()).catch(() => '')) || '';
    if (tag === 'select') {
      try {
        await y.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);
        await y.selectOption({ label: targetYearLabel }).catch(() => null);
      } catch (e) {
        // continue
      }
    }
  }
}

export async function getAvailableDates(page: Page) {
  const dayLinks = page.locator(availableDayCellSelector);
  const count = await dayLinks.count().catch(() => 0);
  const dates: DateCell[] = [];

  for (let i = 0; i < count; i++) {
    const locator = dayLinks.nth(i);
    const dataMonth = await locator.evaluate((node) => node.closest('td')?.getAttribute('data-month'));
    const dataYear = await locator.evaluate((node) => node.closest('td')?.getAttribute('data-year'));
    const dayText = await locator.textContent();
    if (!dayText) continue;

    if (dataMonth && dataYear) {
      const monthValue = Number(dataMonth) + 1;
      const yearValue = Number(dataYear);
      const dayValue = Number(dayText.trim());
      if (Number.isFinite(monthValue) && Number.isFinite(yearValue) && Number.isFinite(dayValue)) {
        const mm = String(monthValue).padStart(2, '0');
        const dd = String(dayValue).padStart(2, '0');
        dates.push({ date: `${yearValue}-${mm}-${dd}`, locator });
      }
      continue;
    }

    const date = await locator.evaluate((node) => {
      const text = node.textContent?.trim();
      const day = text ? Number(text) : NaN;
      if (Number.isNaN(day)) return null;
      const parentGroup = node.closest('.ui-datepicker-group');
      if (!parentGroup) return null;
      const monthLabel = parentGroup.querySelector('.ui-datepicker-month');
      const yearLabel = parentGroup.querySelector('.ui-datepicker-year');
      const monthText = monthLabel?.textContent?.trim();
      const yearText = yearLabel?.textContent?.trim();
      if (!monthText || !yearText) return null;
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const monthIndex = monthNames.indexOf(monthText);
      const yearValue = Number(yearText);
      if (monthIndex === -1 || Number.isNaN(yearValue)) return null;
      const mm = String(monthIndex + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return `${yearValue}-${mm}-${dd}`;
    });

    if (date) {
      dates.push({ date, locator });
    }
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

export async function chooseDateInRange(page: Page, startDate: string, endDate: string, preferredDates: string[] = []) {
  // Give the calendar a brief moment to settle, then read available dates.
  await page.waitForTimeout(200).catch(() => null);
  const availableDates = await getAvailableDates(page);
  info('Calendar available dates:', availableDates.map(d => d.date));
  const candidateDates = availableDates
    .filter((item) => item.date >= startDate && item.date <= endDate);
  info('Calendar candidate dates in range:', candidateDates.map(d => d.date));

  if (candidateDates.length === 0) {
    return null;
  }

  const sorted = candidateDates.sort((a, b) => {
    const aIndex = preferredDates.indexOf(a.date);
    const bIndex = preferredDates.indexOf(b.date);

    if (aIndex !== bIndex) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }

    return a.date.localeCompare(b.date);
  });

  const selected = sorted[0];
  try {
    await selected.locator.scrollIntoViewIfNeeded().catch(() => null);
    await selected.locator.click({ force: true }).catch(async () => {
      // Fallback to in-page dispatch if Playwright click fails
      await clickCalendarDate(page, selected.date);
    });
    info('Selected appointment date', selected.date);
    return selected.date;
  } catch (err) {
    throw new Error(`Could not select calendar date ${selected.date}: ${err}`);
  }
}
