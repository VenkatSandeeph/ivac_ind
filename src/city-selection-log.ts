/**
 * city-selection-log.ts -- Per-profile OFC city-selection history file
 *
 * Appends one line per city selection to
 *   logs/ofc-city-selections-<profile>.txt
 *
 *   [2026-10-12] [14:23:41] Selected NEW DELHI VAC | Calendar Visible: true
 *
 * Append-only — stop/start cycles keep appending to the same file (the date
 * prefix disambiguates runs, unlike the console's time-only timestamps).
 *
 * FIRE-AND-FORGET: returns void immediately; the write rides a serialized
 * queue so the booking loop never waits on disk. Errors are swallowed
 * (logged to info() — dev-only) and can never break or slow the loop.
 */
import fs from 'fs';
import path from 'path';
import { info } from './logger';

// Same pkg-aware root rule as slot-tracker.ts / date-experiment.ts:
// dev (tsx) → cwd/logs, packaged (pkg) → <exe dir>/logs.
function getLogDir(): string {
  const root = typeof (process as any).pkg !== 'undefined'
    ? path.dirname(process.execPath)
    : process.cwd();
  return path.join(root, 'logs');
}

// Serialized writes — keeps line order stable when selections land close
// together (e.g. special-window sweeps firing several selects in a row).
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Append one selection record for this profile's file.
 * Called from logCitySelected in index.ts — the single choke point every
 * OFC selectCity + schedule-response site already flows through.
 */
export function recordCitySelection(profile: string | undefined, city: string, visible: boolean): void {
  const safe = (profile || 'unknown')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
  const logFile = path.join(getLogDir(), `ofc-city-selections-${safe}.txt`);

  const now = new Date();
  const line = `[${now.toISOString().slice(0, 10)}] [${now.toTimeString().slice(0, 8)}] Selected ${city} | Calendar Visible: ${visible}\n`;

  writeQueue = writeQueue
    .then(() => fs.promises.mkdir(path.dirname(logFile), { recursive: true }))
    .then(() => fs.promises.appendFile(logFile, line, 'utf8'))
    .catch((err: unknown) => {
      info('[city-selection-log] Failed to write:', err instanceof Error ? err.message : String(err));
    });
}
