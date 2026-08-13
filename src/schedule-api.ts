import { Page, Response } from 'playwright';
import { warn, info } from './logger';

export type ScheduleApiResult = {
  response: Response | null;
  status: number | null;
  available: boolean;
  scheduleDays: Array<unknown>;
  scheduleEntries: Array<unknown>;
  payload: any;
  parseError: boolean;
  timeout?: boolean;
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

export async function waitForScheduleResponse(page: Page, timeoutMs: number) {
  info('Waiting for schedule API response');

  try {
    const response = await page.waitForResponse(
      (res) => {
        try {
          return (
            res.request().method() === 'POST' &&
            res.url().includes('/custom-actions/') &&
            res.url().includes(SCHEDULE_ROUTE)
          );
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

    info('Schedule API response received', { status, available, scheduleDays: scheduleDays.length, scheduleEntries: scheduleEntries.length });

    return {
      response,
      status,
      available,
      scheduleDays,
      scheduleEntries,
      payload,
      parseError: payload === null
    } as const;
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
        timeout: true
      } as const;
    }

    throw error;
  }
}
