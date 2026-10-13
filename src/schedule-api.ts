import type { Page, Response } from 'patchright';
import { warn, info, uiStatus } from './logger';

export type ScheduleApiResult = {
  response: Response | null;
  status: number | null;
  available: boolean;
  scheduleDays: Array<unknown>;
  scheduleEntries: Array<unknown>;
  payload: any;
  parseError: boolean;
  timeout?: boolean;
  /**
   * App-level error code from a 200 response body (e.g. "SGA14"), when
   * HasError=true. Distinct from transport errors (403/429): the backend
   * answered but rejected the request — usually broken group-member context.
   */
  appErrorCode: string | null;
};

const SCHEDULE_ROUTE = '/api/v1/schedule-group/get-family-ofc-schedule-days';

function extractJsonObject(text: string): any | null {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }
    const jsonText = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }
}

/**
 * Waits for the get-family-ofc-schedule-days response.
 * `postIdFilter` (the <option> value of the city we selected) pins the wait to
 * THAT city's request: the single-city flow's empty pre-select fires the same
 * route with postId:"" and returns instantly, so an unfiltered waiter used to
 * resolve on the wrong response and report empty days for the real city.
 */
export async function waitForScheduleResponse(page: Page, timeoutMs: number, postIdFilter?: string): Promise<ScheduleApiResult> {
  info('Waiting for schedule API response');

  // Heartbeat: this wait can run up to 75s inside drop windows — emit a
  // status marker every 15s so the UI doesn't freeze on the last line.
  const beat = setInterval(() => uiStatus('Checking city — waiting for response'), 15000);
  beat.unref?.();

  try {
    const response = await page.waitForResponse(
      (res) => {
        try {
          if (
            res.request().method() !== 'POST' ||
            !res.url().includes('/custom-actions/') ||
            !res.url().includes(SCHEDULE_ROUTE)
          ) {
            return false;
          }
          if (!postIdFilter) return true;
          // Request body is 'parameters=<urlencoded JSON>' — decoded contains
          // "postId":"<guid>". A guid substring match is sufficient.
          const pd = res.request().postData() || '';
          return decodeURIComponent(pd).includes(postIdFilter);
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs }
    );

    const status = response.status();
    const text = await response.text();
    const payload = extractJsonObject(text);
    const scheduleDays = Array.isArray(payload?.ScheduleDays) ? payload.ScheduleDays : [];
    const scheduleEntries = Array.isArray(payload?.ScheduleEntries) ? payload.ScheduleEntries : [];
    const available =
      status >= 200 &&
      status < 300 &&
      !payload?.HasError &&
      (scheduleDays.length > 0 || scheduleEntries.length > 0);
    const appErrorCode = payload?.HasError
      ? (String(payload?.Errors?.m_StringValue || payload?.ErrorString || 'has_error')
          .replace(/<[^>]+>/g, ' ').trim() || 'has_error')
      : null;

    // Build human-readable date strings from scheduleDays / scheduleEntries when possible
    const extractDate = (item: any) => {
      if (typeof item === 'string') return item;
      if (!item) return '';
      if (item.ScheduleDate) return String(item.ScheduleDate);
      if (item.Date) return String(item.Date);
      if (item.CalendarDate) return String(item.CalendarDate);
      if (item.Day) return String(item.Day);
      // fallback: try common nested properties
      if (item.SlotDate) return String(item.SlotDate);
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    };

    const scheduleDayStrings = scheduleDays.map(extractDate).filter(Boolean).slice(0, 50);
    const scheduleEntryStrings = scheduleEntries.map(extractDate).filter(Boolean).slice(0, 50);

    info('Schedule API response received', {
      status,
      available,
      appError: appErrorCode,
      scheduleDays: scheduleDays.length,
      scheduleEntries: scheduleEntries.length,
      scheduleDaySamples: scheduleDayStrings,
      scheduleEntrySamples: scheduleEntryStrings
    });

    return {
      response,
      status,
      available,
      scheduleDays,
      scheduleEntries,
      payload,
      parseError: payload === null,
      appErrorCode
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      warn('Schedule API response timed out');
      return {
        response: null,
        status: null,
        available: false,
        scheduleDays: [],
        scheduleEntries: [],
        payload: null,
        parseError: true,
        timeout: true,
        appErrorCode: null
      };
    }

    throw error;
  } finally {
    clearInterval(beat);
  }
}
