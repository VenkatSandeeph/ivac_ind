/**
 * slot-tracker.ts -- Local JSONL recorder for calendar visibility observations
 *
 * Records every calendar visibility event (OFC + consular) to a local JSONL file
 * for pattern analysis of appointment release dates and times.
 *
 * KEY DESIGN: Fire-and-forget. The public function returns `void` and never
 * blocks the booking loop. The internal `fs.appendFile` is `.catch()`-ed to
 * swallow all errors. Recording must NEVER break or slow the booking flow.
 *
 * Output: logs/slot-observations.jsonl (one JSON object per line, append-only)
 *
 * To analyze:
 *   findstr "HYDERABAD" logs\slot-observations.jsonl
 *   python -c "import json; [print(json.loads(l)['timestamp'], json.loads(l)['availableDates']) for l in open('logs/slot-observations.jsonl')]"
 */
import fs from 'fs';
import path from 'path';
import { info } from './logger';

export type SlotObservation = {
  /** ISO 8601 UTC timestamp of the observation */
  timestamp: string;
  /** config.username — identifies which account/profile observed this */
  profile: string;
  /** Run identifier from index.ts (or 'consular-<timestamp>' for consular stage) */
  runId: string;
  /** Which scheduling stage: 'ofc' or 'consular' */
  stage: 'ofc' | 'consular';
  /** City being checked when the calendar became visible */
  city: string;
  /** Page URL at time of observation */
  url: string;
  /** ALL green (available) dates on the visible calendar month */
  availableDates: string[];
  /** Dates within the configured startDate..endDate range */
  inRangeDates: string[];
  /** The user's configured appointment range */
  configuredRange: {
    startDate: string;
    endDate: string;
    month: string | number;
    year: number;
  };
  /** Count of schedule days from the schedule API response (0 if no API response) */
  apiScheduleDays: number;
  /** Count of schedule entries from the schedule API response (0 if no API response) */
  apiScheduleEntries: number;
  /** Whether the schedule API reported availability (null if no API response) */
  apiAvailable: boolean | null;
  /** Best-effort calendar month label (e.g. "October 2026"); null if not extracted */
  calendarMonth: string | null;
};

// Resolve the log directory relative to the project root.
// In dev mode (tsx): process.cwd()
// In packaged mode (pkg): path.dirname(process.execPath)
function getLogDir(): string {
  const root = typeof (process as any).pkg !== 'undefined'
    ? path.dirname(process.execPath)
    : process.cwd();
  return path.join(root, 'logs');
}

function getLogFile(): string {
  return path.join(getLogDir(), 'slot-observations.jsonl');
}

/**
 * Append a single observation record to the JSONL log file.
 * Internal async function — errors are caught by the caller's `.catch()`.
 */
async function writeRecord(record: SlotObservation): Promise<void> {
  const logDir = getLogDir();
  const logFile = getLogFile();
  await fs.promises.mkdir(logDir, { recursive: true });
  const line = JSON.stringify(record) + '\n';
  await fs.promises.appendFile(logFile, line, 'utf8');
}

/**
 * Record a calendar visibility observation to the local JSONL log.
 *
 * FIRE-AND-FORGET: This function returns `void` immediately. The file write
 * happens asynchronously off the main booking loop. If the write fails, the
 * error is swallowed and logged to `info()` — it never propagates to the
 * caller and never breaks the booking flow.
 *
 * Usage:
 *   recordSlotObservation({
 *     timestamp: new Date().toISOString(),
 *     profile: config.username,
 *     runId,
 *     stage: 'ofc',
 *     city: currentCity,
 *     url: page.url(),
 *     availableDates: dates.map(d => d.date),
 *     inRangeDates: candidateDates.map(d => d.date),
 *     configuredRange: { startDate, endDate, month, year },
 *     apiScheduleDays: scheduleResult?.scheduleDays?.length ?? 0,
 *     apiScheduleEntries: scheduleResult?.scheduleEntries?.length ?? 0,
 *     apiAvailable: scheduleResult?.available ?? null,
 *     calendarMonth: null
 *   });
 */
export function recordSlotObservation(record: SlotObservation): void {
  // Fire-and-forget: kick off the write, swallow all errors.
  // The booking loop continues immediately without waiting.
  writeRecord(record).catch((err: unknown) => {
    // Non-fatal — recording must never break the booking flow.
    const msg = err instanceof Error ? err.message : String(err);
    info('[slot-tracker] Failed to write observation:', msg);
  });
}
